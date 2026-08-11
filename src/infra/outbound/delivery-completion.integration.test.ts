import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import {
  buildPendingFinalDeliveryInstallPatch,
  settlePendingFinalDelivery,
} from "./delivery-completion.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("pending-final durable delivery completion", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const initialStateDir = process.env.OPENCLAW_STATE_DIR;
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    if (initialStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = initialStateDir;
    }
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("publishes the queue row before custody and suppresses a second stable caller", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sessionKey = "agent:main:matrix:direct:123";
    const storePath = path.join(tmpDir, "sessions.json");
    const deliveryId = "pending-final-delivery-1";
    const completion = {
      kind: "pending-final" as const,
      context: { channel: "matrix", to: "!room:example", accountId: "default" },
      createdAt: 100,
      deliveryId,
      intentId: "pending-final-intent-1",
      sessionId: "session-1",
      sessionKey,
      storePath,
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        status: "running",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "deliver once",
          createdAt: Date.now(),
          intentId: completion.intentId,
          context: completion.context,
          deliveries: [{ id: deliveryId, state: "prepared" }],
        },
      },
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "matrix-message-1" });
    const params = {
      cfg: {} as OpenClawConfig,
      channel: "matrix" as const,
      to: "!room:example",
      payloads: [{ text: "deliver once" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId: deliveryId,
      deliveryCompletion: completion,
    };

    await expect(deliverOutboundPayloads(params)).resolves.toMatchObject([
      { messageId: "matrix-message-1" },
    ]);
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery).toBeUndefined();

    await expect(deliverOutboundPayloads(params)).resolves.toEqual([]);
    expect(sendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toEqual([]);
  });

  it("turns an overwritten unknown final into route-scoped notice debt", async () => {
    const patch = buildPendingFinalDeliveryInstallPatch(
      {
        sessionId: "session-1",
        updatedAt: 100,
        pendingDeliveryNotice: {
          context: { channel: "telegram", to: "chat-0", accountId: "default" },
          createdAt: 50,
          intentId: "older-debt",
          state: "owed",
        },
        pendingFinalDelivery: {
          kind: "replayable",
          text: "old reply",
          createdAt: 100,
          context: { channel: "telegram", to: "chat-1", accountId: "default" },
          intentId: "old-intent",
          deliveries: [{ id: "old-delivery", state: "unknown" }],
        },
      },
      {
        kind: "replayable",
        text: "new reply",
        createdAt: 200,
        context: { channel: "telegram", to: "chat-1", accountId: "default" },
        intentId: "new-intent",
        deliveries: [{ id: "new-delivery", state: "prepared" }],
      },
    );

    expect(patch.pendingDeliveryNotice).toMatchObject({
      intentId: "old-intent",
      state: "owed",
    });
    expect(patch.pendingFinalDelivery?.intentId).toBe("new-intent");
  });

  it("records late dead-letter debt after a newer marker replaced its owner", async () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const storePath = path.join(tmpDir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-2",
        updatedAt: 200,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "new reply",
          createdAt: 200,
          context: { channel: "telegram", to: "chat-1", accountId: "default" },
          intentId: "new-intent",
          deliveries: [{ id: "new-delivery", state: "prepared" }],
        },
      },
    );

    const result = await settlePendingFinalDelivery(
      {
        kind: "pending-final",
        context: { channel: "telegram", to: "chat-1", accountId: "default" },
        createdAt: 100,
        deliveryId: "old-delivery",
        intentId: "old-intent",
        sessionId: "session-1",
        sessionKey,
        storePath,
      },
      "unknown",
    );

    expect(result).toEqual({ state: "unknown" });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "old-intent",
      state: "owed",
    });
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingFinalDelivery?.intentId).toBe(
      "new-intent",
    );
  });
});
