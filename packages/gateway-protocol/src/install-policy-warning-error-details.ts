import { z } from "zod";

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
  acknowledgementToken: string;
  findings?: InstallPolicyWarningErrorFinding[];
};

const installPolicyWarningFindingSchema = z.object({
  ruleId: z.string().trim().min(1),
  severity: z.enum(["info", "warn", "critical"]),
  message: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().trim().min(1).optional(),
});

const installPolicyWarningErrorDetailsSchema = z.object({
  installPolicyCode: z.literal(INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED),
  targetName: z.string().trim().min(1),
  targetType: z.enum(["skill", "plugin"]),
  requestMode: z.enum(["install", "update"]),
  reason: z.string().trim().min(1),
  acknowledgementToken: z.string().trim().min(1),
  findings: z.array(installPolicyWarningFindingSchema).optional(),
});

export function readInstallPolicyWarningErrorDetails(
  value: unknown,
): InstallPolicyWarningErrorDetails | undefined {
  const parsed = installPolicyWarningErrorDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
