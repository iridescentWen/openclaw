/** Structured install-policy warning details carried in Gateway error payloads. */
export const INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED =
  "install_policy_warning_acknowledgement_required" as const;

export type InstallPolicyWarningErrorFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
};

export type InstallPolicyWarningErrorDetails = {
  installPolicyCode: typeof INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED;
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
  reason: string;
  findings?: InstallPolicyWarningErrorFinding[];
};
