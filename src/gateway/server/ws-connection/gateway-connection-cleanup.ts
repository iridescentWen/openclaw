import { disposeSystemAgentSessionsForOwner } from "../../server-methods/system-agent-session-disposal.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { cleanupTalkConnection } from "../../talk-session-registry.js";

export function cleanupGatewayConnectionResources(params: {
  context: GatewayRequestContext;
  connId: string;
  warn: (message: string) => void;
}): void {
  void disposeSystemAgentSessionsForOwner(
    params.context.systemAgentSessions,
    `connection:${params.connId}`,
    params.context.systemAgentApprovalManager,
  ).catch((error: unknown) => {
    params.warn(
      `failed to dispose connection-owned system-agent sessions conn=${params.connId}: ${formatError(error)}`,
    );
  });
  cleanupTalkConnection(params.connId, { warn: params.warn });
  params.context.unsubscribeAllSessionEvents(params.connId);
  // PTYs detach or stop according to their grace policy. Keep every connection
  // owner here so another close path cannot strand one of these resources.
  params.context.terminalSessions?.handleDisconnect(params.connId);
}
