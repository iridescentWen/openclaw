import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type {
  InstallPolicyWarningAcknowledgementRequest,
  InstallPolicyWarningAcknowledgementResult,
  InstallPolicyWarningOccurrence,
} from "../install-security-scan.types.js";

export const officialDiffsWarningOccurrence: InstallPolicyWarningOccurrence = {
  warningFingerprint: "review-diffs-warning",
  scan: {
    requestKind: "plugin-archive",
    originType: "plugin-package",
    pluginContentType: "package",
  },
  warning: {
    targetName: "diffs",
    targetType: "plugin",
    requestMode: "install",
    reason: "Review this warning",
  },
};

type InstallPolicyWarningCall = {
  onInstallPolicyWarning?: (
    request: InstallPolicyWarningAcknowledgementRequest,
  ) => Promise<InstallPolicyWarningAcknowledgementResult>;
};

export const officialDiffsWarningRequest = {
  source: "official",
  pluginId: "diffs",
  installPolicyWarningAcknowledgement: {
    resolvedRequest: {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs@2026.6.11",
      expectedPluginId: "diffs",
      expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
    },
    warnings: [officialDiffsWarningOccurrence],
  },
} as const;

export async function expectOneShotInstallPolicyWarningAcknowledgement(mock: {
  mock: { calls: unknown[][] };
}): Promise<void> {
  const call = expectDefined(mock.mock.calls[0], "clawhub install call test invariant");
  const params = call[0] as InstallPolicyWarningCall;
  const acknowledge = expectDefined(
    params.onInstallPolicyWarning,
    "expected install-policy acknowledgement callback",
  );
  const request: InstallPolicyWarningAcknowledgementRequest = {
    targetName: "diffs",
    targetType: "plugin",
    requestMode: "install",
    ...officialDiffsWarningOccurrence,
  };
  expect(await acknowledge(request)).toEqual({ status: "approved" });
  expect(await acknowledge(request)).toEqual({
    status: "unavailable",
    reason: "warning-not-approved",
  });
}
