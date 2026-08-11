import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { retireTerminalRestartRecoverySourceClaim } from "./restart-recovery-claim.js";

describe("pending final delivery restart proof", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:discord:direct:123";
  const context = { channel: "discord", to: "discord:dm:123", accountId: "main" };

  function completion(deliveryId = "delivery-1", intentId = "intent-1") {
    return {
      kind: "pending-final" as const,
      context,
      createdAt: 1,
      deliveryId,
      intentId,
      sessionId: "session",
      sessionKey,
      storePath,
    };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-final-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePendingFinal(
    beforeAgentReplyState: "continue" | "handled-reply",
  ): Promise<void> {
    const entry: SessionEntry = {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      lifecycleRunId: "active-run",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "replayable",
        text: "hook reply",
        createdAt: 1,
        intentId: "intent-1",
        deliveries: [{ id: "delivery-1", state: "prepared" }],
        context,
      },
      restartRecoveryBeforeAgentReplyState: beforeAgentReplyState,
      restartRecoveryForceSafeTools: beforeAgentReplyState === "handled-reply" ? true : undefined,
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }

  it.each(["continue", "handled-reply"] as const)(
    "clears %s provenance only after the exact pending intent succeeds",
    async (beforeAgentReplyState) => {
      await writePendingFinal(beforeAgentReplyState);
      await settlePendingFinalDelivery(completion(), "delivered");

      const entry = loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined;
      expect(entry?.pendingFinalDelivery).toBeUndefined();
      expect(entry?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
      expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
      expect(entry?.restartRecoverySourceIngress).toBeUndefined();
      expect(entry?.status).toBe(beforeAgentReplyState === "handled-reply" ? "done" : "running");
      expect(entry?.lifecycleRunId).toBe(
        beforeAgentReplyState === "handled-reply" ? undefined : "active-run",
      );
      if (beforeAgentReplyState === "handled-reply") {
        expect(entry?.endedAt).toBeTypeOf("number");
        expect(entry?.runtimeMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("finalizes a media-only hook turn after its exact transport intent succeeds", async () => {
    const entry: SessionEntry = {
      sessionId: "session",
      status: "running",
      startedAt: 10,
      lifecycleRunId: "media-run",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "transport-only",
        createdAt: Date.now(),
        intentId: "intent-media",
        context,
        deliveries: [{ id: "delivery-media", state: "prepared" }],
      },
      restartRecoveryBeforeAgentReplyState: "handled-unrecoverable",
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    await settlePendingFinalDelivery(completion("delivery-media", "intent-media"), "delivered");

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      status: "done",
      abortedLastRun: false,
    });
    expect(
      (loadSessionEntry({ sessionKey, storePath }) as SessionEntry | undefined)?.lifecycleRunId,
    ).toBeUndefined();
  });

  it("turns an ambiguous terminal result into retained notice debt", async () => {
    await writePendingFinal("continue");

    await settlePendingFinalDelivery(completion(), "unknown");

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({
      pendingDeliveryNotice: {
        intentId: "intent-1",
        state: "owed",
      },
    });
    expect(entry?.pendingFinalDelivery).toBeUndefined();
  });

  it("does not retire a source while its terminal provider outcome is unknown", async () => {
    await replaceSessionEntry(
      { storePath, sessionKey },
      {
        sessionId: "session",
        status: "done",
        updatedAt: Date.now(),
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: "message-call-1",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: "source-1",
      },
    );

    await expect(
      retireTerminalRestartRecoverySourceClaim({
        sessionId: "session",
        sessionKey,
        sourceTurnId: "source-1",
        storePath,
      }),
    ).resolves.toBeUndefined();

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });
    expect(
      loadSessionEntry({ sessionKey, storePath })?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();
  });
});
