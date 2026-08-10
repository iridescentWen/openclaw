import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { InstallPolicyWarningAcknowledgementRequest } from "../install-security-scan.types.js";

type InstallPolicyWarningCall = {
  onInstallPolicyWarning?: (
    request: InstallPolicyWarningAcknowledgementRequest,
  ) => Promise<boolean>;
};

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
  };
  expect(await acknowledge(request)).toBe(true);
  expect(await acknowledge(request)).toBe(false);
}
