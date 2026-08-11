/** Persists restart-recoverable final delivery markers for agent runs. */
import { randomUUID } from "node:crypto";
import { setReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
  normalizePendingFinalRecoveryPayloads,
} from "../auto-reply/reply/pending-final-delivery.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { buildPendingFinalDeliveryInstallPatch } from "../infra/outbound/delivery-completion.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";

type PersistPendingFinalDeliveryMarkerParams = {
  deliver: boolean;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  storePath: string;
  suppressVisibleSessionEffects: boolean;
  sessionReboundDuringRun: boolean;
  payloads: ReplyPayload[];
  deliveryContext?: DeliveryContext;
  runOwnedSessionId: string;
};

type PendingFinalDeliveryMarkerResult = {
  sessionEntry?: SessionEntry;
  pendingFinalDeliveryMarkerPersisted: boolean;
  hasSendableFinalPayload: boolean;
};

export async function persistPendingFinalDeliveryMarker(
  params: PersistPendingFinalDeliveryMarkerParams,
): Promise<PendingFinalDeliveryMarkerResult> {
  const sendablePayloads = params.payloads.filter(
    (payload) => normalizePendingFinalDeliveryPayloads([payload]).length > 0,
  );
  const hasSendableFinalPayload = sendablePayloads.length > 0;
  const recoverableText = buildRecoverablePendingFinalDeliveryText(
    normalizePendingFinalRecoveryPayloads(params.payloads),
  );

  if (
    !params.deliver ||
    !params.sessionStore ||
    !params.sessionKey ||
    params.suppressVisibleSessionEffects ||
    params.sessionReboundDuringRun ||
    isSubagentSessionKey(params.sessionKey) ||
    !hasSendableFinalPayload ||
    !params.deliveryContext
  ) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  const entry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
  if (!entry) {
    return {
      sessionEntry: params.sessionEntry,
      pendingFinalDeliveryMarkerPersisted: false,
      hasSendableFinalPayload,
    };
  }

  const now = Date.now();
  const intentId = randomUUID();
  const deliveryId = randomUUID();
  const persisted = await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (current) =>
      current.sessionId === params.runOwnedSessionId && current.abortedLastRun !== true
        ? buildPendingFinalDeliveryInstallPatch(current, {
            ...(recoverableText
              ? { kind: "replayable" as const, text: recoverableText }
              : { kind: "transport-only" as const }),
            intentId,
            deliveries: [{ id: deliveryId, state: "prepared" as const }],
            createdAt: now,
            context: params.deliveryContext,
          })
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  }
  const markerPersisted = persisted?.pendingFinalDelivery?.intentId === intentId;

  if (markerPersisted) {
    for (const payload of sendablePayloads) {
      setReplyPayloadMetadata(payload, {
        pendingFinalDeliveryCompletion: {
          context: params.deliveryContext,
          createdAt: now,
          deliveryId,
          intentId,
          sessionId: params.runOwnedSessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
      });
    }
  }

  return {
    sessionEntry: persisted ?? undefined,
    pendingFinalDeliveryMarkerPersisted: markerPersisted,
    hasSendableFinalPayload,
  };
}
