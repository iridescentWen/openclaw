import { resolveMessageReceiptPrimaryId } from "../../channels/message/receipt.js";
import {
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../../config/sessions/conversation-delivery-store.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

/** Serializable owner callback for a durable queue entry. */
export type DurableDeliveryCompletion =
  | {
      kind: "conversation";
      agentId: string;
      operationId: string;
      storePath?: string;
    }
  | {
      kind: "pending-final";
      context: DeliveryContext;
      createdAt: number;
      deliveryId: string;
      intentId: string;
      sessionId: string;
      sessionKey: string;
      storePath: string;
    };

export type DurableDeliveryCompletionResult = {
  state: "prepared" | "queued" | "delivered" | "suppressed" | "rejected" | "unknown" | "stale";
  platformMessageId?: string;
  rejectionError?: string;
};

export type PendingFinalDeliveryClaimResult = DurableDeliveryCompletionResult & {
  applied: boolean;
};

function shouldReplacePendingDeliveryNotice(
  entry: SessionEntry,
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
): boolean {
  const notice = entry.pendingDeliveryNotice;
  return (
    !notice || notice.intentId === completion.intentId || notice.createdAt <= completion.createdAt
  );
}

export function buildPendingFinalDeliveryInstallPatch(
  entry: SessionEntry,
  pendingFinalDelivery: NonNullable<SessionEntry["pendingFinalDelivery"]>,
): Pick<SessionEntry, "pendingFinalDelivery" | "pendingDeliveryNotice" | "updatedAt"> {
  const predecessor = entry.pendingFinalDelivery;
  const predecessorHasUnknown = predecessor?.deliveries?.some(({ state }) => state === "unknown");
  const predecessorNotice =
    predecessorHasUnknown && predecessor?.context && predecessor.intentId
      ? {
          context: predecessor.context,
          createdAt: predecessor.createdAt,
          intentId: predecessor.intentId,
          state: "owed" as const,
        }
      : undefined;
  const pendingDeliveryNotice =
    predecessorNotice &&
    (!entry.pendingDeliveryNotice ||
      entry.pendingDeliveryNotice.createdAt <= predecessorNotice.createdAt)
      ? predecessorNotice
      : entry.pendingDeliveryNotice;
  return {
    pendingFinalDelivery,
    pendingDeliveryNotice,
    updatedAt: Date.now(),
  };
}

function scopeForCompletion(
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>,
) {
  return {
    agentId: completion.agentId,
    ...(completion.storePath ? { storePath: completion.storePath } : {}),
  };
}

function conversationResult(record: ConversationDeliveryRecord): DurableDeliveryCompletionResult {
  const delivered = record.status === "sent" || record.status === "replied";
  return {
    state: delivered
      ? "delivered"
      : record.status === "suppressed" ||
          record.status === "rejected" ||
          record.status === "unknown"
        ? record.status
        : "queued",
    ...(delivered && (record.platformMessageId || record.preparedMessageId)
      ? { platformMessageId: record.platformMessageId ?? record.preparedMessageId }
      : {}),
    ...(record.status === "rejected" && record.rejectionError
      ? { rejectionError: record.rejectionError }
      : {}),
  };
}

async function mutatePendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: Exclude<DurableDeliveryCompletionResult["state"], "rejected" | "stale">,
  requirePrepared: boolean,
  stateDir?: string,
): Promise<PendingFinalDeliveryClaimResult> {
  let settled: DurableDeliveryCompletionResult["state"] = "stale";
  let applied = false;
  let wakeRecovery = false;
  await updateSessionEntry(
    { sessionKey: completion.sessionKey, storePath: completion.storePath },
    (entry) => {
      const pending = entry.pendingFinalDelivery;
      if (entry.sessionId !== completion.sessionId || pending?.intentId !== completion.intentId) {
        if (
          state === "unknown" &&
          !requirePrepared &&
          shouldReplacePendingDeliveryNotice(entry, completion)
        ) {
          settled = "unknown";
          applied = true;
          return {
            pendingDeliveryNotice: {
              context: completion.context,
              createdAt: completion.createdAt,
              intentId: completion.intentId,
              state: "owed" as const,
            },
            updatedAt: Date.now(),
          };
        }
        return null;
      }
      const deliveries = pending.deliveries;
      const index = deliveries?.findIndex(({ id }) => id === completion.deliveryId) ?? -1;
      if (!deliveries || index < 0) {
        return null;
      }
      const current = deliveries[index]!.state;
      if (requirePrepared && current !== "prepared") {
        settled = current;
        return null;
      }
      settled =
        current === "delivered" ||
        current === "suppressed" ||
        (current === "unknown" && state === "unknown")
          ? current
          : state;
      if (settled === current) {
        return null;
      }
      applied = true;
      const nextDeliveries = deliveries.with(index, { id: completion.deliveryId, state: settled });
      const allTerminal = nextDeliveries.every(
        ({ state: nextState }) =>
          nextState === "delivered" || nextState === "suppressed" || nextState === "unknown",
      );
      const hasUnknown = nextDeliveries.some(({ state: nextState }) => nextState === "unknown");
      const recoveryRunId = entry.restartRecoveryDeliveryRunId?.trim();
      const completesHookTurn =
        allTerminal &&
        recoveryRunId === undefined &&
        (entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
          entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable");
      const now = Date.now();
      wakeRecovery =
        settled !== "queued" && entry.status === "running" && entry.abortedLastRun === true;
      const patch = {
        pendingFinalDelivery: allTerminal ? undefined : { ...pending, deliveries: nextDeliveries },
        ...(allTerminal &&
        hasUnknown &&
        pending.context &&
        shouldReplacePendingDeliveryNotice(entry, completion)
          ? {
              pendingDeliveryNotice: {
                createdAt: pending.createdAt,
                context: pending.context,
                intentId: completion.intentId,
                state: "owed" as const,
              },
            }
          : {}),
        updatedAt: now,
      };
      const recovery = (entry as InternalSessionEntry).mainRestartRecovery;
      if (recovery) {
        Object.assign(patch, {
          mainRestartRecovery: {
            ...recovery,
            revision: recovery.revision + 1,
          },
        });
      }
      if (allTerminal) {
        Object.assign(
          patch,
          buildRestartRecoveryClaimCleanupPatch({
            entry,
            recordTerminalSource: recoveryRunId !== undefined,
          }),
        );
      }
      if (completesHookTurn) {
        Object.assign(patch, {
          abortedLastRun: false,
          endedAt: now,
          lifecycleRunId: undefined,
          runtimeMs:
            typeof entry.startedAt === "number" ? Math.max(0, now - entry.startedAt) : undefined,
          status: "done" as const,
        });
      }
      return patch;
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (wakeRecovery) {
    const { scheduleMainSessionRecoveryPendingTarget } =
      await import("../../agents/main-session-recovery/main-session-recovery-owner-release.js");
    scheduleMainSessionRecoveryPendingTarget({
      sessionId: completion.sessionId,
      sessionKey: completion.sessionKey,
      ...(stateDir !== undefined ? { stateDir } : {}),
      storePath: completion.storePath,
    });
  }
  return { state: settled, applied };
}

export async function settlePendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: Exclude<DurableDeliveryCompletionResult["state"], "rejected" | "stale">,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> {
  const { applied: _applied, ...result } = await mutatePendingFinalDelivery(
    completion,
    state,
    false,
    stateDir,
  );
  return result;
}

export function claimPreparedPendingFinalDelivery(
  completion: Extract<DurableDeliveryCompletion, { kind: "pending-final" }>,
  state: "queued" | "suppressed",
  stateDir?: string,
): Promise<PendingFinalDeliveryClaimResult> {
  return mutatePendingFinalDelivery(completion, state, true, stateDir);
}

function readPlatformMessageId(result: OutboundDeliveryResult): string | undefined {
  const receiptId = result.receipt ? resolveMessageReceiptPrimaryId(result.receipt) : undefined;
  return receiptId ?? (result.messageId.trim() || undefined);
}

/** Records queue ownership before either the live sender or recovery crosses platform I/O. */
export function markDurableDeliveryQueued(
  completion: DurableDeliveryCompletion,
  queueId: string,
  expectedPendingFinalState?: "prepared",
): Promise<DurableDeliveryCompletionResult> | DurableDeliveryCompletionResult {
  return completion.kind === "pending-final"
    ? expectedPendingFinalState === "prepared"
      ? claimPreparedPendingFinalDelivery(completion, "queued")
      : settlePendingFinalDelivery(completion, "queued")
    : conversationResult(
        markConversationDeliveryQueued(
          scopeForCompletion(completion),
          completion.operationId,
          queueId,
        ),
      );
}

/** Finalizes owner state from identified platform evidence before queue acknowledgement. */
export function completeDurableDelivery(
  completion: DurableDeliveryCompletion,
  result: OutboundDeliveryResult,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> | DurableDeliveryCompletionResult {
  return completion.kind === "pending-final"
    ? settlePendingFinalDelivery(completion, "delivered", stateDir)
    : conversationResult(
        markConversationDeliverySent(
          scopeForCompletion(completion),
          completion.operationId,
          readPlatformMessageId(result),
        ),
      );
}

/** Finalizes a policy-suppressed send before its durable intent is acknowledged. */
export function suppressDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> | DurableDeliveryCompletionResult {
  return completion.kind === "pending-final"
    ? settlePendingFinalDelivery(completion, "suppressed", stateDir)
    : conversationResult(
        markConversationDeliverySuppressed(scopeForCompletion(completion), completion.operationId),
      );
}

/** Finalizes a permanent provider rejection that provably preceded platform I/O. */
export function rejectDurableDelivery(
  completion: DurableDeliveryCompletion,
  error: string,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> | DurableDeliveryCompletionResult {
  return completion.kind === "pending-final"
    ? settlePendingFinalDelivery(completion, "unknown", stateDir)
    : conversationResult(
        markConversationDeliveryRejected(
          scopeForCompletion(completion),
          completion.operationId,
          error,
        ),
      );
}

/** Makes a dead-lettered durable send terminal without allowing a blind replay. */
export function failDurableDelivery(
  completion: DurableDeliveryCompletion,
  stateDir?: string,
): Promise<DurableDeliveryCompletionResult> | DurableDeliveryCompletionResult {
  return completion.kind === "pending-final"
    ? settlePendingFinalDelivery(completion, "unknown", stateDir)
    : conversationResult(
        markConversationDeliveryUnknown(scopeForCompletion(completion), completion.operationId),
      );
}
