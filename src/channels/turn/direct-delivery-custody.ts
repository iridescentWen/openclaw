import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { claimPreparedPendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ChannelDeliveryInfo } from "./types.js";

type DirectPendingFinalCustody = Pick<ChannelDeliveryInfo, "bindPendingFinalDelivery"> & {
  onPlatformSendDispatch: () => Promise<void>;
};

export const NO_PENDING_FINAL_CUSTODY: DirectPendingFinalCustody = {
  onPlatformSendDispatch: async () => {},
};

export function resolvePendingFinalCompletion(payload: ReplyPayload) {
  const identity = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  return identity ? { kind: "pending-final" as const, ...identity } : undefined;
}

export function createDirectPendingFinalCustody(
  payload: ReplyPayload,
): DirectPendingFinalCustody | undefined {
  const completion = resolvePendingFinalCompletion(payload);
  if (!completion) {
    return undefined;
  }
  let admission: Promise<void> | undefined;
  return {
    bindPendingFinalDelivery: (nextPayload) => copyReplyPayloadMetadata(payload, nextPayload),
    onPlatformSendDispatch: () => {
      admission ??= claimPreparedPendingFinalDelivery(completion, "queued").then((result) => {
        if (result.state !== "queued" || !result.applied) {
          throw new PlatformMessageNotDispatchedError(
            "Pending final delivery ownership changed before platform dispatch",
            { cause: new Error(`pending final delivery is ${result.state}`) },
          );
        }
      });
      return admission;
    },
  };
}
