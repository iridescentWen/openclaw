import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  ProjectRecordSchema,
  ProjectSummarySchema,
  ProjectsListResultSchema,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateSessionsCreateParams,
} from "../index.js";

describe("project protocol schemas", () => {
  it("validates project method inputs as closed objects", () => {
    expect(validateProjectsListParams({})).toBe(true);
    expect(validateProjectsListParams({ limit: 200 })).toBe(true);
    expect(validateProjectsListParams({ limit: 201 })).toBe(false);
    expect(validateProjectsListParams({ extra: true })).toBe(false);
    expect(validateProjectsRegisterParams({ path: "/repo", name: "OpenClaw" })).toBe(true);
    expect(validateProjectsRegisterParams({ path: "" })).toBe(false);
    expect(validateProjectsRemoveParams({ id: "openclaw-2" })).toBe(true);
    expect(validateProjectsRemoveParams({ id: "workspace:main" })).toBe(false);
  });

  it("accepts workspace and stored project records", () => {
    expect(
      Value.Check(ProjectRecordSchema, {
        id: "workspace:main",
        displayName: "openclaw",
        source: "workspace",
        agentId: "main",
      }),
    ).toBe(true);
    expect(
      Value.Check(ProjectsListResultSchema, {
        projects: [
          {
            id: "openclaw",
            displayName: "OpenClaw",
            repoRoot: "/repo/openclaw",
            originUrl: "https://github.com/openclaw/openclaw.git",
            source: "registered",
          },
        ],
        observedProjects: [],
      }),
    ).toBe(true);
  });

  it("bounds derived projects and their checkout lists", () => {
    const project = {
      name: "openclaw",
      originUrl: "https://github.com/openclaw/openclaw.git",
      checkouts: [{ runnerId: "gateway", path: "/repo/openclaw" }],
      lastUsedAt: 1,
    };
    expect(Value.Check(ProjectSummarySchema, project)).toBe(true);
    expect(
      Value.Check(ProjectSummarySchema, {
        ...project,
        checkouts: Array.from(
          { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1 },
          (_, index) => ({ runnerId: "gateway", path: `/repo/openclaw-${index}` }),
        ),
      }),
    ).toBe(false);
  });

  it("accepts projectId as an additive sessions.create parameter", () => {
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "openclaw" })).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", projectId: "" })).toBe(false);
  });
});
