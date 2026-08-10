// Gateway control-plane handlers for cold plugin catalog and lifecycle operations.
import { randomUUID } from "node:crypto";
import {
  buildClawHubTrustErrorDetails,
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
  type PluginsInstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import type { InstallPolicyWarningDetails } from "../../plugins/install-security-scan.types.js";
import {
  formatManagedPluginLifecycleError,
  installManagedPlugin,
  listManagedPlugins,
  ManagedPluginLifecycleError,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
  type ManagedPluginInstallRequest,
  type ManagedPluginSourceInstallRequest,
} from "../../plugins/management-service.js";
import { buildGatewayReloadPlan } from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import { readInstallPolicyWarningErrorDetails } from "../install-policy-warning-error-details.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const INSTALL_POLICY_ACKNOWLEDGEMENT_TTL_MS = 5 * 60_000;
const MAX_INSTALL_POLICY_ACKNOWLEDGEMENTS = 256;

type InstallPolicyAcknowledgement = {
  expiresAt: number;
  requestKey: string;
  resolvedRequest: ManagedPluginSourceInstallRequest;
  warning: InstallPolicyWarningDetails;
};

const installPolicyAcknowledgements = new Map<string, InstallPolicyAcknowledgement>();

function installPolicyRequestKey(request: PluginsInstallParams): string {
  return request.source === "clawhub"
    ? JSON.stringify({
        source: request.source,
        packageName: request.packageName,
        version: request.version ?? null,
        acknowledgeClawHubRisk: request.acknowledgeClawHubRisk ?? false,
      })
    : JSON.stringify({ source: request.source, pluginId: request.pluginId });
}

function pruneInstallPolicyAcknowledgements(now: number): void {
  for (const [token, acknowledgement] of installPolicyAcknowledgements) {
    if (acknowledgement.expiresAt <= now) {
      installPolicyAcknowledgements.delete(token);
    }
  }
  while (installPolicyAcknowledgements.size >= MAX_INSTALL_POLICY_ACKNOWLEDGEMENTS) {
    const oldestToken = installPolicyAcknowledgements.keys().next().value;
    if (typeof oldestToken !== "string") {
      break;
    }
    installPolicyAcknowledgements.delete(oldestToken);
  }
}

function issueInstallPolicyAcknowledgement(params: {
  request: PluginsInstallParams;
  resolvedRequest: ManagedPluginSourceInstallRequest;
  warning: InstallPolicyWarningDetails;
}): string {
  const now = Date.now();
  pruneInstallPolicyAcknowledgements(now);
  const token = randomUUID();
  installPolicyAcknowledgements.set(token, {
    expiresAt: now + INSTALL_POLICY_ACKNOWLEDGEMENT_TTL_MS,
    requestKey: installPolicyRequestKey(params.request),
    resolvedRequest: params.resolvedRequest,
    warning: params.warning,
  });
  return token;
}

function consumeInstallPolicyAcknowledgement(
  request: PluginsInstallParams,
): Pick<InstallPolicyAcknowledgement, "resolvedRequest" | "warning"> | undefined {
  const token = request.installPolicyWarningAcknowledgement;
  if (!token) {
    return undefined;
  }
  const acknowledgement = installPolicyAcknowledgements.get(token);
  installPolicyAcknowledgements.delete(token);
  if (
    !acknowledgement ||
    acknowledgement.expiresAt <= Date.now() ||
    acknowledgement.requestKey !== installPolicyRequestKey(request)
  ) {
    throw new ManagedPluginLifecycleError(
      "Install policy approval expired or does not match this plugin. Review the current warning and try again.",
    );
  }
  return {
    resolvedRequest: acknowledgement.resolvedRequest,
    warning: acknowledgement.warning,
  };
}

function managedInstallRequest(params: PluginsInstallParams): ManagedPluginInstallRequest {
  const installPolicyWarningAcknowledgement = consumeInstallPolicyAcknowledgement(params);
  if (params.source === "clawhub") {
    return {
      source: params.source,
      packageName: params.packageName,
      ...(params.version ? { version: params.version } : {}),
      ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(installPolicyWarningAcknowledgement ? { installPolicyWarningAcknowledgement } : {}),
    };
  }
  return {
    source: params.source,
    pluginId: params.pluginId,
    ...(installPolicyWarningAcknowledgement ? { installPolicyWarningAcknowledgement } : {}),
  };
}

function pluginPolicyRestartRequired(params: {
  config: OpenClawConfig;
  changedPaths: readonly string[];
}): boolean {
  const plan = buildGatewayReloadPlan([...params.changedPaths]);
  const mode = resolveGatewayReloadSettings(params.config).mode;
  return plan.restartGateway || mode === "off";
}

/** Gateway handlers for plugin inventory, ClawHub search, install, and policy state. */
export const pluginsHandlers: GatewayRequestHandlers = {
  "plugins.refresh": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsRefreshParams, "plugins.refresh", respond)) {
      return;
    }
    context.notifyPluginMetadataChanged();
    respond(true, { ok: true }, undefined);
  },
  "plugins.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      respond(true, await listManagedPlugins({ config: context.getRuntimeConfig() }), undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatManagedPluginLifecycleError(error)),
      );
    }
  },
  "plugins.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsSearchParams, "plugins.search", respond)) {
      return;
    }
    try {
      const results = await searchInstallablePluginPackages({
        query: params.query,
        limit: params.limit,
      });
      respond(
        true,
        {
          results: results.flatMap((entry) => {
            if (
              entry.package.family !== "code-plugin" &&
              entry.package.family !== "bundle-plugin"
            ) {
              return [];
            }
            const downloads = entry.package.stats?.downloads;
            return [
              {
                score: entry.score,
                package: {
                  name: entry.package.name,
                  displayName: entry.package.displayName,
                  family: entry.package.family,
                  channel: entry.package.channel,
                  isOfficial: entry.package.isOfficial,
                  ...(entry.package.summary ? { summary: entry.package.summary } : {}),
                  ...(entry.package.latestVersion
                    ? { latestVersion: entry.package.latestVersion }
                    : {}),
                  ...(entry.package.runtimeId ? { runtimeId: entry.package.runtimeId } : {}),
                  ...(typeof downloads === "number" && Number.isFinite(downloads) && downloads >= 0
                    ? { downloads }
                    : {}),
                  ...(entry.package.verificationTier
                    ? { verificationTier: entry.package.verificationTier }
                    : {}),
                },
              },
            ];
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatManagedPluginLifecycleError(error)),
      );
    }
  },
  "plugins.install": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsInstallParams, "plugins.install", respond)) {
      return;
    }
    try {
      const result = await installManagedPlugin({ request: managedInstallRequest(params) });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: true,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      const trustCode =
        lifecycleError?.code && isClawHubTrustErrorCode(lifecycleError.code)
          ? lifecycleError.code
          : undefined;
      const trustDetails = lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
      const installPolicyDetails =
        lifecycleError?.installPolicyWarning && lifecycleError.installPolicyResolvedRequest
          ? readInstallPolicyWarningErrorDetails({
              installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
              ...lifecycleError.installPolicyWarning,
              acknowledgementToken: issueInstallPolicyAcknowledgement({
                request: params,
                resolvedRequest: lifecycleError.installPolicyResolvedRequest,
                warning: lifecycleError.installPolicyWarning,
              }),
            })
          : undefined;
      const details = installPolicyDetails ?? trustDetails;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatManagedPluginLifecycleError(error),
          details ? { details } : undefined,
        ),
      );
    }
  },
  "plugins.uninstall": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsUninstallParams, "plugins.uninstall", respond)) {
      return;
    }
    try {
      const result = await uninstallManagedPlugin({ pluginId: params.pluginId });
      respond(
        true,
        {
          ok: true,
          pluginId: result.pluginId,
          restartRequired: true,
          removed: result.removed,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatManagedPluginLifecycleError(error),
        ),
      );
    }
  },
  "plugins.setEnabled": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsSetEnabledParams, "plugins.setEnabled", respond)
    ) {
      return;
    }
    try {
      const result = await setManagedPluginEnabled({
        pluginId: params.pluginId,
        enabled: params.enabled,
      });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: pluginPolicyRestartRequired({
            config: context.getRuntimeConfig(),
            changedPaths: result.changedPaths,
          }),
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatManagedPluginLifecycleError(error),
        ),
      );
    }
  },
};
