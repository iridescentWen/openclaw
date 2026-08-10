// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallPolicyFinding, InstallPolicyRequestKind } from "../security/install-policy.js";

export type InstallPolicyWarningDetails = {
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
  reason: string;
  findings?: InstallPolicyFinding[];
};

/** Stable policy-stage facts that scope an approval without exposing scan internals to clients. */
type InstallPolicyWarningScanIdentity = {
  requestKind: InstallPolicyRequestKind;
  originType: string;
  pluginContentType?: "bundle" | "package" | "file" | "dependency-tree";
  skillInstallId?: string;
};

export type InstallPolicyWarningOccurrence = {
  scan: InstallPolicyWarningScanIdentity;
  warning: InstallPolicyWarningDetails;
};

export type InstallPolicyWarningAcknowledgementRequest = InstallPolicyWarningOccurrence & {
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
};

type InstallPolicyWarningAcknowledgementResult =
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
