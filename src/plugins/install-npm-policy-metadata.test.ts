import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolveNpmSpecMetadata =
  typeof import("../infra/install-source-utils.js").resolveNpmSpecMetadata;
type PreflightPluginNpmInstallPolicy =
  typeof import("./install-security-scan.js").preflightPluginNpmInstallPolicy;

const resolveNpmSpecMetadataMock = vi.fn<ResolveNpmSpecMetadata>();
const preflightPluginNpmInstallPolicyMock = vi.fn<PreflightPluginNpmInstallPolicy>();

vi.mock("../infra/install-source-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/install-source-utils.js")>();
  return { ...actual, resolveNpmSpecMetadata: resolveNpmSpecMetadataMock };
});

vi.mock("./install-security-scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./install-security-scan.js")>();
  return {
    ...actual,
    preflightPluginNpmInstallPolicy: preflightPluginNpmInstallPolicyMock,
  };
});

const { installPluginFromNpmSpec } = await import("./install-npm.js");

describe("npm install policy metadata", () => {
  beforeEach(() => {
    resolveNpmSpecMetadataMock.mockReset();
    preflightPluginNpmInstallPolicyMock.mockReset();
    resolveNpmSpecMetadataMock.mockResolvedValue({
      ok: true,
      metadata: {
        name: "@openclaw/demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-reviewed",
        shasum: "reviewed",
        packageOpenClaw: { extensions: ["./index.js"] },
      },
    });
  });

  it("keeps policy metadata stable when a retry pins the resolved npm spec", async () => {
    const policyInputs: Array<{
      requestedSpecifier: string;
      metadata: Record<string, unknown>;
    }> = [];
    preflightPluginNpmInstallPolicyMock.mockImplementation(async (params) => {
      policyInputs.push({
        requestedSpecifier: params.requestedSpecifier ?? "",
        metadata: JSON.parse(await fs.readFile(params.sourcePath, "utf8")) as Record<
          string,
          unknown
        >,
      });
      return { blocked: { code: "security_scan_blocked", reason: "test stop" } };
    });

    const requestedSpecifier = "@openclaw/demo@latest";
    const first = await installPluginFromNpmSpec({ spec: requestedSpecifier });
    const retry = await installPluginFromNpmSpec({
      spec: "@openclaw/demo@1.2.3",
      installPolicyRequestedSpecifier: requestedSpecifier,
      expectedIntegrity: "sha512-reviewed",
    });

    expect(first.ok).toBe(false);
    expect(retry.ok).toBe(false);
    expect(policyInputs).toHaveLength(2);
    expect(policyInputs[0]).toMatchObject({
      requestedSpecifier,
      metadata: {
        packageName: "@openclaw/demo",
        requestedSpecifier,
        resolution: {
          resolvedSpec: "@openclaw/demo@1.2.3",
          integrity: "sha512-reviewed",
        },
      },
    });
    expect(policyInputs[1]).toEqual(policyInputs[0]);
    expect(policyInputs[0]).not.toHaveProperty("metadata.resolution.resolvedAt");
  });
});
