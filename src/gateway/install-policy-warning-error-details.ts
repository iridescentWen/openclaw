import { z } from "zod";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  type InstallPolicyWarningErrorDetails,
} from "../../packages/gateway-protocol/src/install-policy-warning-error-details.js";

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
  findings: z.array(installPolicyWarningFindingSchema).optional(),
});

export function readInstallPolicyWarningErrorDetails(
  value: unknown,
): InstallPolicyWarningErrorDetails | undefined {
  const parsed = installPolicyWarningErrorDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
