import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const StoredProjectIdSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
});

export const PROJECTS_LIST_DEFAULT_LIMIT = 50;
export const PROJECTS_LIST_MAX_LIMIT = 200;
export const PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT = 50;
export const PROJECTS_LIST_MAX_IDENTITY_PROBES = 32;

export const ProjectRecordSchema = closedObject({
  id: NonEmptyString,
  displayName: NonEmptyString,
  repoRoot: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Repository checkout root; included only for callers holding operator.write.",
    }),
  ),
  originUrl: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Repository origin URL; included only for callers holding operator.write.",
    }),
  ),
  source: Type.String({ enum: ["workspace", "registered", "cloned"] }),
  agentId: Type.Optional(NonEmptyString),
});

/** One gateway-visible checkout for an observed repository project. */
export const ProjectCheckoutSchema = closedObject({
  runnerId: NonEmptyString,
  path: NonEmptyString,
});

/** Repository identity derived from visible checkout and session state. */
export const ProjectSummarySchema = closedObject({
  name: NonEmptyString,
  originUrl: Type.Optional(NonEmptyString),
  checkouts: Type.Array(ProjectCheckoutSchema, {
    minItems: 1,
    maxItems: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  }),
  lastUsedAt: Type.Number({ minimum: 0 }),
});

export const ProjectsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PROJECTS_LIST_MAX_LIMIT })),
});
export const ProjectsListResultSchema = closedObject({
  projects: Type.Array(ProjectRecordSchema, { maxItems: PROJECTS_LIST_MAX_LIMIT }),
  observedProjects: Type.Array(ProjectSummarySchema, { maxItems: PROJECTS_LIST_MAX_LIMIT }),
});

export const ProjectsRegisterParamsSchema = closedObject({
  path: NonEmptyString,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export const ProjectsRegisterResultSchema = ProjectRecordSchema;

export const ProjectsRemoveParamsSchema = closedObject({ id: StoredProjectIdSchema });
export const ProjectsRemoveResultSchema = closedObject({ removed: Type.Boolean() });

export type ProjectRecord = Static<typeof ProjectRecordSchema>;
export type ProjectCheckout = Static<typeof ProjectCheckoutSchema>;
export type ProjectSummary = Static<typeof ProjectSummarySchema>;
export type ProjectsListParams = Static<typeof ProjectsListParamsSchema>;
export type ProjectsListResult = Static<typeof ProjectsListResultSchema>;
export type ProjectsRegisterParams = Static<typeof ProjectsRegisterParamsSchema>;
export type ProjectsRegisterResult = Static<typeof ProjectsRegisterResultSchema>;
export type ProjectsRemoveParams = Static<typeof ProjectsRemoveParamsSchema>;
export type ProjectsRemoveResult = Static<typeof ProjectsRemoveResultSchema>;
