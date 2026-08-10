// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type InstallPolicyWarningAcknowledgementRequest = {
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
};

export type InstallPolicyWarningAcknowledgementResult =
  | { status: "approved" }
  | { status: "declined" }
  | {
      status: "unavailable";
      reason: "approval-exhausted";
    };

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: (
    request: InstallPolicyWarningAcknowledgementRequest,
  ) => Promise<InstallPolicyWarningAcknowledgementResult>;
  trustedSourceLinkedOfficialInstall?: boolean;
};
