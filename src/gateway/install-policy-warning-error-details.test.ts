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
  ])("rejects malformed warning details", (value) => {
    expect(readInstallPolicyWarningErrorDetails(value)).toBeUndefined();
  });
});
