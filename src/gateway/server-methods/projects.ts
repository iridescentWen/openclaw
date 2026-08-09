import {
  ErrorCodes,
  errorShape,
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
  PROJECTS_LIST_MAX_LIMIT,
  type ProjectRecord,
  type ProjectSummary,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees, type ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
} from "../../projects/project-registry.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadCombinedSessionStoreForGateway } from "../session-utils.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ProjectWorktreeService = Pick<ManagedWorktreeService, "list" | "resolveRepositoryIdentity">;

type ProjectCandidate = {
  checkoutPath: string;
  fingerprint: string;
  lastUsedAt: number;
  originUrl?: string;
};

type RawProjectCandidate =
  | { kind: "session"; checkoutPath: string; lastUsedAt: number }
  | {
      kind: "worktree";
      checkoutPath: string;
      fingerprint: string;
      lastUsedAt: number;
      repoRoot: string;
    };

type ProjectGroup = {
  checkouts: Map<string, { path: string; lastUsedAt: number }>;
  lastUsedAt: number;
  name: string;
  nameUsedAt: number;
  originUrl?: string;
};

function checkoutName(checkoutPath: string): string {
  const trimmed = checkoutPath.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}

function sanitizePublicOriginUrl(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const suffixIndex = trimmed.search(/[?#]/u);
  const withoutSuffix = suffixIndex < 0 ? trimmed : trimmed.slice(0, suffixIndex);
  const scp = /^[^@\s/:]+@(\[[^\]]+\]|[^:\s]+):(.+)$/u.exec(withoutSuffix);
  if (scp) {
    return `${scp[1]}:${scp[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutSuffix);
  } catch {
    return undefined;
  }
  if (!parsed.username && !parsed.password) {
    return withoutSuffix;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function sanitizeProjectRecord(project: ProjectRecord): ProjectRecord {
  const { originUrl, ...record } = project;
  const sanitizedOriginUrl = originUrl ? sanitizePublicOriginUrl(originUrl) : undefined;
  return {
    ...record,
    ...(sanitizedOriginUrl ? { originUrl: sanitizedOriginUrl } : {}),
  };
}

function projectCandidatesToSummaries(
  candidates: readonly ProjectCandidate[],
  limit: number,
): ProjectSummary[] {
  const groups = new Map<string, ProjectGroup>();
  for (const candidate of candidates) {
    const group: ProjectGroup = groups.get(candidate.fingerprint) ?? {
      checkouts: new Map(),
      lastUsedAt: candidate.lastUsedAt,
      name: checkoutName(candidate.checkoutPath),
      nameUsedAt: candidate.lastUsedAt,
    };
    const checkout = group.checkouts.get(candidate.checkoutPath);
    if (!checkout || candidate.lastUsedAt > checkout.lastUsedAt) {
      group.checkouts.set(candidate.checkoutPath, {
        path: candidate.checkoutPath,
        lastUsedAt: candidate.lastUsedAt,
      });
    }
    group.lastUsedAt = Math.max(group.lastUsedAt, candidate.lastUsedAt);
    if (candidate.lastUsedAt > group.nameUsedAt) {
      group.name = checkoutName(candidate.checkoutPath);
      group.nameUsedAt = candidate.lastUsedAt;
    }
    if (!group.originUrl && candidate.originUrl) {
      group.originUrl = candidate.originUrl;
    }
    groups.set(candidate.fingerprint, group);
  }
  return [...groups.values()]
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    )
    .slice(0, limit)
    .map((group) => {
      const summary: ProjectSummary = {
        name: group.name,
        checkouts: [...group.checkouts.values()]
          .toSorted(
            (left, right) =>
              right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path),
          )
          .slice(0, PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT)
          .map((checkout) => ({ runnerId: "gateway", path: checkout.path })),
        lastUsedAt: group.lastUsedAt,
      };
      if (group.originUrl) {
        const originUrl = sanitizePublicOriginUrl(group.originUrl);
        if (originUrl) {
          summary.originUrl = originUrl;
        }
      }
      return summary;
    });
}

async function listObservedProjects(
  service: ProjectWorktreeService,
  context: Parameters<GatewayRequestHandlers["projects.list"]>[0]["context"],
  client: Parameters<GatewayRequestHandlers["projects.list"]>[0]["client"],
  limit: number,
): Promise<ProjectSummary[]> {
  const { store } = loadCombinedSessionStoreForGateway(context.getRuntimeConfig(), {
    projection: "list",
  });
  const rawCandidates: RawProjectCandidate[] = [];
  const visibilityFilter = createSessionListEntryFilter({ client });
  const canSeeAll = !visibilityFilter;
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (visibilityFilter && !visibilityFilter(sessionKey, entry)) {
      continue;
    }
    const checkoutPath = entry.execCwd?.trim();
    if (checkoutPath && !entry.execNode?.trim()) {
      rawCandidates.push({ kind: "session", checkoutPath, lastUsedAt: entry.updatedAt });
    }
  }
  for (const worktree of await service.list()) {
    if (worktree.removedAt !== undefined) {
      continue;
    }
    if (!canSeeAll) {
      // Session-owned worktrees use their canonical session key as ownerId, so the same
      // visibility policy that admitted the session also owns its managed checkout.
      const ownerId = worktree.ownerKind === "session" ? worktree.ownerId?.trim() : undefined;
      const ownerEntry = ownerId ? store[ownerId] : undefined;
      if (!ownerId || !ownerEntry || !visibilityFilter?.(ownerId, ownerEntry)) {
        continue;
      }
    }
    rawCandidates.push({
      kind: "worktree",
      checkoutPath: worktree.path,
      fingerprint: worktree.repoFingerprint,
      lastUsedAt: worktree.lastActiveAt,
      repoRoot: worktree.repoRoot,
    });
  }

  const candidates: ProjectCandidate[] = [];
  type RepositoryIdentity = Awaited<
    ReturnType<ProjectWorktreeService["resolveRepositoryIdentity"]>
  >;
  const identities = new Map<string, Promise<RepositoryIdentity>>();
  let identityProbeCount = 0;
  const resolveIdentity = (checkoutPath: string) => {
    const existing = identities.get(checkoutPath);
    if (existing) {
      return existing;
    }
    if (identityProbeCount >= PROJECTS_LIST_MAX_IDENTITY_PROBES) {
      return undefined;
    }
    identityProbeCount += 1;
    const identity = Promise.resolve().then(() => service.resolveRepositoryIdentity(checkoutPath));
    identities.set(checkoutPath, identity);
    return identity;
  };

  // Identity probes perform realpath plus Git subprocesses. The fixed newest-first budget keeps
  // request cost independent of the caller's response limit; duplicate roots reuse cached work.
  for (const raw of rawCandidates.toSorted(
    (left, right) =>
      right.lastUsedAt - left.lastUsedAt || left.checkoutPath.localeCompare(right.checkoutPath),
  )) {
    if (raw.kind === "worktree") {
      let originUrl: string | undefined;
      const pendingIdentity = resolveIdentity(raw.repoRoot);
      try {
        const identity = pendingIdentity ? await pendingIdentity : undefined;
        originUrl = identity?.originUrl || undefined;
      } catch {
        // The registry fingerprint and physical checkout path remain authoritative if the source
        // checkout has disappeared since the managed worktree record was written.
      }
      candidates.push({
        checkoutPath: raw.checkoutPath,
        fingerprint: raw.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(originUrl ? { originUrl } : {}),
      });
      continue;
    }
    const pendingIdentity = resolveIdentity(raw.checkoutPath);
    if (!pendingIdentity) {
      continue;
    }
    try {
      const identity = await pendingIdentity;
      candidates.push({
        checkoutPath: identity.checkoutRoot,
        fingerprint: identity.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(identity.originUrl ? { originUrl: identity.originUrl } : {}),
      });
    } catch {
      // Plain folders remain available through the existing folder picker.
    }
  }

  // M5: merge operator-enabled device checkout advertisements at this seam.
  return projectCandidatesToSummaries(candidates, limit);
}

function readSafeProject(project: ProjectRecord): ProjectRecord {
  return project.agentId
    ? {
        id: project.id,
        displayName: project.displayName,
        source: project.source,
        agentId: project.agentId,
      }
    : { id: project.id, displayName: project.displayName, source: project.source };
}

export function createProjectsHandlers(service: ProjectWorktreeService): GatewayRequestHandlers {
  return {
    "projects.list": async ({ params, respond, context, client }) => {
      if (!validateProjectsListParams(params)) {
        return respondInvalidParams({
          respond,
          method: "projects.list",
          validator: validateProjectsListParams,
        });
      }
      await respondUnavailableOnThrow(respond, async () => {
        const limit = params.limit ?? PROJECTS_LIST_DEFAULT_LIMIT;
        const projects = listProjectRegistry(context.getRuntimeConfig())
          .slice(0, PROJECTS_LIST_MAX_LIMIT)
          .map(sanitizeProjectRecord);
        const observedProjects = await listObservedProjects(service, context, client, limit);
        const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
        const canWrite = authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, scopes).allowed;
        respond(
          true,
          { projects: canWrite ? projects : projects.map(readSafeProject), observedProjects },
          undefined,
        );
      });
    },
    "projects.register": async ({ params, respond }) => {
      if (
        !assertValidParams(params, validateProjectsRegisterParams, "projects.register", respond)
      ) {
        return;
      }
      try {
        respond(
          true,
          sanitizeProjectRecord(
            await registerProjectRegistry({ path: params.path, name: params.name }),
          ),
          undefined,
        );
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            error instanceof ProjectCheckoutError
              ? ErrorCodes.INVALID_REQUEST
              : ErrorCodes.UNAVAILABLE,
            formatErrorMessage(error),
          ),
        );
      }
    },
    "projects.remove": ({ params, respond }) => {
      if (!assertValidParams(params, validateProjectsRemoveParams, "projects.remove", respond)) {
        return;
      }
      if (!removeProjectRegistry(params.id)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${params.id}`),
        );
        return;
      }
      respond(true, { removed: true }, undefined);
    },
  };
}

export const projectsHandlers = createProjectsHandlers(managedWorktrees);
