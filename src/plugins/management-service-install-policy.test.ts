import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstallPolicyWarningAcknowledgementRequest,
  InstallPolicyWarningAcknowledgementResult,
  InstallPolicyWarningOccurrence,
} from "./install-security-scan.types.js";
import {
  expectOneShotInstallPolicyWarningAcknowledgement,
  officialDiffsWarningRequest,
} from "./test-helpers/install-policy-warning.js";
import { metadataSnapshot } from "./test-helpers/management-service-fixtures.js";

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  clawhubInstall: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  npmInstall: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  preflight: vi.fn(),
  providerAuthChoices: vi.fn(),
  readConfig: vi.fn(),
  recommendedInstalls: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
  slotSelection: vi.fn((config: unknown): { config: unknown; warnings: string[] } => ({
    config,
    warnings: [],
  })),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: (...args: unknown[]) => mocks.persistInstall(...args),
  resolveInstallConfigMutationPreflights: (...args: unknown[]) => mocks.preflight(...args),
  selectInstallMutationWriteOptions: (writeOptions: unknown) =>
    mocks.selectWriteOptions(writeOptions),
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => mocks.slotSelection(config),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => mocks.clawhubInstall(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.npmInstall(...args),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uninstall.js")>()),
  applyPluginUninstallDirectoryRemoval: (...args: unknown[]) => mocks.applyUninstall(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: (...args: unknown[]) => mocks.providerAuthChoices(...args),
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: (...args: unknown[]) => mocks.recommendedInstalls(...args),
}));

const {
  clearManagedPluginOfficialCatalogCache,
  installManagedPlugin,
  ManagedPluginLifecycleError,
} = await import("./management-service.js");

function configSnapshot() {
  return {
    snapshot: {
      valid: true,
      parsed: {},
      path: "/tmp/openclaw.json",
      sourceConfig: {},
      hash: "base-hash",
    },
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
      includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
    },
  };
}

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

function mockClawHubInstall(pluginId: string, packageName: string) {
  mocks.clawhubInstall.mockResolvedValue({
    ok: true,
    pluginId,
    targetDir: `/tmp/extensions/${pluginId}`,
    extensions: ["index.js"],
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin",
    },
  });
}

const hostedFeedDiffsEntry = {
  id: "@openclaw/diffs",
  title: "Diffs",
  state: "available",
  featured: true,
  publisher: { id: "openclaw", trust: "official" },
  install: {
    candidates: [
      {
        sourceRef: "public-clawhub",
        package: "@openclaw/diffs",
        version: "2026.6.11",
        integrity: `sha256:${"a".repeat(64)}`,
      },
    ],
  },
};

describe("plugin management install-policy acknowledgements", () => {
  beforeEach(() => {
    clearManagedPluginOfficialCatalogCache();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    mocks.selectWriteOptions.mockImplementation((writeOptions) => writeOptions);
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
    mocks.slotSelection.mockImplementation((config) => ({ config, warnings: [] }));
    mocks.installRecords.mockResolvedValue({});
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.providerAuthChoices.mockReturnValue([]);
    mocks.recommendedInstalls.mockReturnValue([]);
    mockHostedOfficialCatalog([]);
  });

  it("threads hosted ClawHub candidate integrity into official installs", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.persistInstall.mockResolvedValue({});
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: {
        ...officialDiffsWarningRequest,
        installPolicyWarningAcknowledgement: {
          ...officialDiffsWarningRequest.installPolicyWarningAcknowledgement,
          warnings: [...officialDiffsWarningRequest.installPolicyWarningAcknowledgement.warnings],
        },
      },
      env: {},
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/diffs@2026.6.11",
        expectedPluginId: "diffs",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      }),
    );
    await expectOneShotInstallPolicyWarningAcknowledgement(mocks.clawhubInstall);
  });

  it("acknowledges a reviewed warning only at the same scan stage and only once", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.persistInstall.mockResolvedValue({});
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );
    const packageWarning: InstallPolicyWarningOccurrence = expectDefined(
      officialDiffsWarningRequest.installPolicyWarningAcknowledgement.warnings[0],
      "first approved warning",
    );
    const dependencyWarning: InstallPolicyWarningOccurrence = {
      scan: {
        ...packageWarning.scan,
        originType: "plugin-dependency-tree",
        pluginContentType: "dependency-tree",
      },
      warning: packageWarning.warning,
    };

    await installManagedPlugin({
      request: {
        ...officialDiffsWarningRequest,
        installPolicyWarningAcknowledgement: {
          ...officialDiffsWarningRequest.installPolicyWarningAcknowledgement,
          warnings: [packageWarning],
        },
      },
      env: {},
    });

    const call = expectDefined(mocks.clawhubInstall.mock.calls[0], "clawhub install call");
    const acknowledge = expectDefined(
      (
        call[0] as {
          onInstallPolicyWarning?: (
            request: InstallPolicyWarningAcknowledgementRequest,
          ) => Promise<InstallPolicyWarningAcknowledgementResult>;
        }
      ).onInstallPolicyWarning,
      "install-policy acknowledgement callback",
    );
    expect(
      await acknowledge({
        targetName: dependencyWarning.warning.targetName,
        targetType: dependencyWarning.warning.targetType,
        requestMode: dependencyWarning.warning.requestMode,
        ...dependencyWarning,
      }),
    ).toEqual({ status: "unavailable", reason: "warning-not-approved" });
    const packageRequest: InstallPolicyWarningAcknowledgementRequest = {
      targetName: packageWarning.warning.targetName,
      targetType: packageWarning.warning.targetType,
      requestMode: packageWarning.warning.requestMode,
      ...packageWarning,
    };
    expect(await acknowledge(packageRequest)).toEqual({ status: "approved" });
    expect(await acknowledge(packageRequest)).toEqual({
      status: "unavailable",
      reason: "warning-not-approved",
    });
  });

  it("pins reviewed npm warnings to the first resolved version and integrity", async () => {
    const warning: InstallPolicyWarningOccurrence = {
      scan: {
        requestKind: "plugin-npm",
        originType: "plugin-npm",
        pluginContentType: "package",
      },
      warning: {
        targetName: "npm-demo",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review this npm package",
      },
    };
    const npmResolution = {
      name: "@openclaw/npm-demo",
      version: "1.2.3",
      resolvedSpec: "@openclaw/npm-demo@1.2.3",
      integrity: "sha512-reviewed",
      resolvedAt: "2026-08-10T00:00:00.000Z",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([
      {
        name: "@openclaw/npm-demo",
        openclaw: {
          plugin: { id: "npm-demo" },
          install: { npmSpec: "@openclaw/npm-demo", defaultChoice: "npm" },
        },
      },
    ]);
    mocks.npmInstall
      .mockResolvedValueOnce({
        ok: false,
        error: warning.warning.reason,
        installPolicyWarning: warning,
        npmResolution,
      })
      .mockResolvedValueOnce({ ok: false, error: "stop after inspecting the pinned retry" });

    let firstFailure: unknown;
    try {
      await installManagedPlugin({
        request: { source: "official", pluginId: "npm-demo" },
        env: {},
      });
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(ManagedPluginLifecycleError);
    if (!(firstFailure instanceof ManagedPluginLifecycleError)) {
      throw new Error("expected managed plugin lifecycle failure");
    }
    const resolvedRequest = expectDefined(
      firstFailure.installPolicyResolvedRequest,
      "pinned npm install request",
    );
    expect(resolvedRequest).toMatchObject({
      source: "official",
      spec: npmResolution.resolvedSpec,
      expectedIntegrity: npmResolution.integrity,
    });

    await expect(
      installManagedPlugin({
        request: {
          source: "official",
          pluginId: "npm-demo",
          installPolicyWarningAcknowledgement: {
            warnings: [warning],
            resolvedRequest,
          },
        },
        env: {},
      }),
    ).rejects.toThrow("stop after inspecting the pinned retry");
    expect(mocks.npmInstall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spec: npmResolution.resolvedSpec,
        expectedIntegrity: npmResolution.integrity,
      }),
    );
  });

  it("keeps npm warnings terminal when immutable resolution metadata is incomplete", async () => {
    const warning: InstallPolicyWarningOccurrence = {
      scan: {
        requestKind: "plugin-npm",
        originType: "plugin-npm",
        pluginContentType: "package",
      },
      warning: {
        targetName: "npm-demo",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review this npm package",
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([
      {
        name: "@openclaw/npm-demo",
        openclaw: {
          plugin: { id: "npm-demo" },
          install: { npmSpec: "@openclaw/npm-demo", defaultChoice: "npm" },
        },
      },
    ]);
    mocks.npmInstall.mockResolvedValue({
      ok: false,
      error: warning.warning.reason,
      installPolicyWarning: warning,
      npmResolution: {
        name: "@openclaw/npm-demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/npm-demo@1.2.3",
        resolvedAt: "2026-08-10T00:00:00.000Z",
      },
    });

    let failure: unknown;
    try {
      await installManagedPlugin({
        request: { source: "official", pluginId: "npm-demo" },
        env: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ManagedPluginLifecycleError);
    if (!(failure instanceof ManagedPluginLifecycleError)) {
      throw new Error("expected managed plugin lifecycle failure");
    }
    expect(failure.installPolicyWarning).toEqual(warning);
    expect(failure.installPolicyResolvedRequest).toBeUndefined();
    expect(failure.message).toContain("immutable artifact resolution metadata");
  });

  it("pins reviewed ClawHub warnings to the downloaded archive integrity", async () => {
    const warning: InstallPolicyWarningOccurrence = {
      scan: {
        requestKind: "plugin-archive",
        originType: "plugin-package",
        pluginContentType: "package",
      },
      warning: {
        targetName: "demo",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review this ClawHub package",
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.clawhubInstall.mockResolvedValue({
      ok: false,
      error: warning.warning.reason,
      installPolicyWarning: warning,
      version: "1.2.3",
      integrity: "sha256-reviewed",
    });

    let failure: unknown;
    try {
      await installManagedPlugin({
        request: { source: "clawhub", packageName: "community/demo" },
        env: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ManagedPluginLifecycleError);
    if (!(failure instanceof ManagedPluginLifecycleError)) {
      throw new Error("expected managed plugin lifecycle failure");
    }
    expect(failure.installPolicyResolvedRequest).toMatchObject({
      source: "clawhub",
      spec: "clawhub:community/demo@1.2.3",
      expectedIntegrity: "sha256-reviewed",
    });
  });
});
