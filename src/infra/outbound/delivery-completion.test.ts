import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  claimPreparedPendingFinalDelivery,
  settlePendingFinalDelivery,
} from "./delivery-completion.js";

const recoveryMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock(
  "../../agents/main-session-recovery/main-session-recovery-owner-release.js",
  () => recoveryMocks,
);

describe("pending-final delivery completion", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:main";
  const completion = {
    kind: "pending-final" as const,
    context: { channel: "telegram", to: "chat-1", accountId: "default" },
    createdAt: 100,
    deliveryId: "delivery-1",
    intentId: "intent-1",
    sessionId: "session-1",
    sessionKey,
    storePath: "",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-delivery-completion-"));
    storePath = path.join(tmpDir, "sessions.json");
    completion.storePath = storePath;
    const entry: InternalSessionEntry = {
      sessionId: completion.sessionId,
      status: "running",
      abortedLastRun: true,
      updatedAt: Date.now(),
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1 },
      pendingFinalDelivery: {
        kind: "replayable",
        text: "durable final",
        createdAt: Date.now(),
        intentId: completion.intentId,
        context: completion.context,
        deliveries: [{ id: completion.deliveryId, state: "prepared" }],
      },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invalidates an observed recovery decision and wakes the exact session", async () => {
    const observation = { sessionId: completion.sessionId, cycleId: "cycle-1", revision: 1 };

    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "delivered",
    });

    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry).toMatchObject({ mainRestartRecovery: { revision: 2 } });
    expect(entry?.pendingFinalDelivery).toBeUndefined();
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      storePath,
    });
    await expect(
      commitMainSessionRecovery({
        command: { kind: "fail_recovery", now: Date.now(), observation },
        requireWriteSuccess: true,
        target: { sessionKey, storePath },
      }),
    ).resolves.toMatchObject({ transition: { kind: "rejected", reason: "stale_revision" } });
  });

  it("records queue custody without waking recovery", async () => {
    await expect(settlePendingFinalDelivery(completion, "queued")).resolves.toEqual({
      state: "queued",
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      mainRestartRecovery: { revision: 2 },
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "queued" }],
      },
    });
    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).not.toHaveBeenCalled();
  });

  it("keeps direct custody pending until the provider result terminalizes it", async () => {
    await expect(claimPreparedPendingFinalDelivery(completion, "queued")).resolves.toEqual({
      state: "queued",
      applied: true,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      pendingFinalDelivery: {
        deliveries: [{ id: completion.deliveryId, state: "queued" }],
      },
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();

    await expect(claimPreparedPendingFinalDelivery(completion, "queued")).resolves.toEqual({
      state: "queued",
      applied: false,
    });
    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "delivered",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();
  });

  it("turns a returned direct-send failure into retained notice debt", async () => {
    await claimPreparedPendingFinalDelivery(completion, "queued");

    await expect(settlePendingFinalDelivery(completion, "unknown")).resolves.toEqual({
      state: "unknown",
    });

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toBeUndefined();
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: completion.intentId,
      state: "owed",
    });
  });

  it("keeps a multi-payload owner until every direct send settles", async () => {
    const second = { ...completion, deliveryId: "delivery-2" };
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          deliveries: [
            { id: completion.deliveryId, state: "prepared" },
            { id: second.deliveryId, state: "prepared" },
          ],
        },
      },
    );

    await claimPreparedPendingFinalDelivery(completion, "queued");
    await settlePendingFinalDelivery(completion, "delivered");
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toMatchObject({
      deliveries: [
        { id: completion.deliveryId, state: "delivered" },
        { id: second.deliveryId, state: "prepared" },
      ],
    });

    await claimPreparedPendingFinalDelivery(second, "queued");
    await settlePendingFinalDelivery(second, "delivered");
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toBeUndefined();
  });

  it("carries a custom queue root when a terminal sibling wakes recovery", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          deliveries: [
            { id: completion.deliveryId, state: "prepared" },
            { id: "delivery-2", state: "queued" },
          ],
        },
      },
    );

    await settlePendingFinalDelivery(completion, "delivered", tmpDir);

    expect(recoveryMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith({
      sessionId: completion.sessionId,
      sessionKey,
      stateDir: tmpDir,
      storePath,
    });
  });

  it("cannot settle a newer intent through an old completion", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        pendingFinalDelivery: {
          ...entry.pendingFinalDelivery!,
          intentId: "new-intent",
        },
      },
    );

    await expect(settlePendingFinalDelivery(completion, "delivered")).resolves.toEqual({
      state: "stale",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery?.intentId).toBe(
      "new-intent",
    );
  });
});
