import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  deliverPendingDeliveryNotice,
  PENDING_DELIVERY_NOTICE,
} from "./pending-delivery-notice.js";

const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const findDeliveryIntentOwner = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return { ...actual, appendAssistantMessageToSessionTranscript };
});
vi.mock("../../infra/outbound/delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-queue-storage.js")>();
  return { ...actual, findDeliveryIntentOwner };
});

describe("pending delivery notice", () => {
  let tmpDir: string;
  let storePath: string;
  const sessionKey = "agent:main:telegram:direct:chat-1";

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue("sent");
    findDeliveryIntentOwner.mockReturnValue(null);
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pending-notice-"));
    storePath = path.join(tmpDir, "sessions.json");
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "session-1",
        status: "idle",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: "default" },
          context: { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 },
          origin: {},
        },
        pendingDeliveryNotice: {
          createdAt: Date.now(),
          context: { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 },
          intentId: "intent-1",
          state: "owed",
        },
      },
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("clears debt only after the stable notice is acknowledged", async () => {
    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      channel: "telegram",
      to: "chat-1",
      accountId: "default",
      threadId: 42,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey: "main-session-restart-recovery:pending-final:intent-1",
    });
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session-1",
        text: PENDING_DELIVERY_NOTICE,
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();
  });

  it("does not cross an account or thread route", async () => {
    const entry = loadSessionEntry({ sessionKey, storePath })!;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...entry,
        delivery: {
          ...entry.delivery!,
          context: { channel: "telegram", to: "chat-1", accountId: "other", threadId: 42 },
        },
      },
    );

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "owed",
    });
  });

  it("records a policy-suppressed notice before clearing the debt", async () => {
    sendRecoveryNotice.mockResolvedValue("suppressed");

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session-1",
        text: PENDING_DELIVERY_NOTICE,
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();
  });

  it("retains unresolved debt after a terminal notice delivery failure", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("delivery failed"));
    findDeliveryIntentOwner.mockReturnValue({ status: "failed" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "unresolved",
    });
  });

  it("records and clears debt when the stable notice receipt completed before an error", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("post-ack failure"));
    findDeliveryIntentOwner.mockReturnValue({ status: "completed" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: "session-1",
        text: PENDING_DELIVERY_NOTICE,
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();
  });

  it("retains owed debt while the durable notice remains pending", async () => {
    sendRecoveryNotice.mockRejectedValue(new Error("delivery pending"));
    findDeliveryIntentOwner.mockReturnValue({ status: "pending" });

    await deliverPendingDeliveryNotice(sessionKey, storePath);

    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toMatchObject({
      intentId: "intent-1",
      state: "owed",
    });
  });
});
