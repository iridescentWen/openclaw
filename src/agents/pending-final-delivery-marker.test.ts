import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { persistPendingFinalDeliveryMarker } from "./pending-final-delivery-marker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("persistPendingFinalDeliveryMarker", () => {
  it("owns a multi-payload command delivery as one durable batch", async () => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    const storePath = path.join(tempDirs.make("openclaw-pending-final-marker-"), "sessions.json");
    await replaceSessionEntry({ sessionKey: "main", storePath }, entry);
    const payloads = [{ text: "first" }, { text: "second" }];

    const result = await persistPendingFinalDeliveryMarker({
      deliver: true,
      sessionStore: { main: entry },
      sessionKey: "main",
      sessionEntry: entry,
      storePath,
      suppressVisibleSessionEffects: false,
      sessionReboundDuringRun: false,
      payloads,
      deliveryContext: { channel: "telegram", to: "chat-1", accountId: "default" },
      runOwnedSessionId: "session-1",
    });

    expect(result.sessionEntry?.pendingFinalDelivery?.deliveries).toEqual([
      { id: expect.any(String), state: "prepared" },
    ]);
    const deliveryId = result.sessionEntry?.pendingFinalDelivery?.deliveries?.[0]?.id;
    expect(
      payloads.map(
        (payload) => getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion?.deliveryId,
      ),
    ).toEqual([deliveryId, deliveryId]);
  });
});
