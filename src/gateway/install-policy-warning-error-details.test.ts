import { describe, expect, it } from "vitest";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  type InstallPolicyWarningErrorDetails,
} from "../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import { readInstallPolicyWarningErrorDetails } from "./install-policy-warning-error-details.js";

describe("install policy warning error details", () => {
  const completeWarning: Omit<InstallPolicyWarningErrorDetails, "installPolicyCode"> = {
    targetName: "demo-plugin",
    targetType: "plugin",
    requestMode: "install",
    reason: "Scanner found behavior that needs review",
    acknowledgementToken: "approval-token",
    findings: [
      {
        ruleId: "dynamic-eval",
        severity: "warn",
        message: "Dynamic code execution",
        file: "index.js",
        line: 12,
      },
    ],
  };

  const expectedWarning = {
    installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
    ...completeWarning,
  };

  it("parses a complete warning payload", () => {
    expect(
      readInstallPolicyWarningErrorDetails({
        ...expectedWarning,
      }),
    ).toEqual(expectedWarning);
  });

  it.each([
    null,
    {},
    {
      installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
      targetName: "demo-plugin",
      targetType: "plugin",
      requestMode: "install",
      reason: "",
    },
    {
      ...expectedWarning,
      findings: [{ ...completeWarning.findings?.[0], line: 0 }],
    },
    {
      ...expectedWarning,
      findings: [{ ...completeWarning.findings?.[0], severity: "error" }],
    },
  ])("rejects malformed warning details", (value) => {
    expect(readInstallPolicyWarningErrorDetails(value)).toBeUndefined();
  });

  it("normalizes protocol strings without changing the published dependency surface", () => {
    expect(
      readInstallPolicyWarningErrorDetails({
        ...expectedWarning,
        targetName: " demo-plugin ",
        reason: " Review required ",
        acknowledgementToken: " token ",
      }),
    ).toMatchObject({
      targetName: "demo-plugin",
      reason: "Review required",
      acknowledgementToken: "token",
    });
  });
});
