import { claimPreparedPendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";

export async function suppressPendingFinalDelivery(payload: ReplyPayload): Promise<void> {
  const completion = getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion;
  if (!completion) {
    return;
  }
  await claimPreparedPendingFinalDelivery({ kind: "pending-final", ...completion }, "suppressed");
}
