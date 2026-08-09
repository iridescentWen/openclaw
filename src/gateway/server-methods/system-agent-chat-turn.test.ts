import { describe, expect, it, vi } from "vitest";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";

function makeEngine() {
  const handle = vi.fn();
  const answerWizard = vi.fn();
  const cancelWizard = vi.fn();
  const pollStep = vi.fn();
  return {
    answerWizard,
    cancelWizard,
    handle,
    pollStep,
    engine: { answerWizard, cancelWizard, handle, pollStep },
  };
}

describe("system-agent chat input", () => {
  it.each([
    {
      input: {
        sessionId: "s1",
        message: "5",
        wizardAnswer: { stepId: "channel", value: "twitch" },
      },
      error: "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "secret", value: "not-forwarded" },
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot answer or poll structured wizard steps.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
        reset: true,
      },
      error: "A wizard answer or poll cannot reset its OpenClaw chat session.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", message: "continue" },
      error: "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        pollStepId: "qr",
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot answer or poll structured wizard steps.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", reset: true },
      error: "A wizard answer or poll cannot reset its OpenClaw chat session.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", welcomeVariant: "onboarding" as const },
      error: "A wizard poll cannot include welcome or UI context.",
    },
    {
      input: { sessionId: "s1", pollStepId: "qr", context: { page: "channels" } },
      error: "A wizard poll cannot include welcome or UI context.",
    },
    {
      input: {
        sessionId: "s1",
        message: "cancel",
        wizardCancel: { stepId: "channel" },
      },
      error: "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
        wizardCancel: { stepId: "channel" },
      },
      error: "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        wizardCancel: { stepId: "channel" },
        pollStepId: "qr",
      },
      error: "Send exactly one of message, wizardAnswer, wizardCancel, or pollStepId.",
    },
    {
      input: {
        sessionId: "s1",
        wizardCancel: { stepId: "channel" },
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot cancel hosted wizards.",
    },
    {
      input: {
        sessionId: "s1",
        wizardCancel: { stepId: "channel" },
        reset: true,
      },
      error: "A wizard cancel cannot reset its OpenClaw chat session.",
    },
  ])("rejects invalid mixed input: $error", ({ input, error }) => {
    expect(getSystemAgentChatInputError(input)).toBe(error);
  });

  it("routes a structured wizard answer through the typed engine seam", async () => {
    const { engine, answerWizard, handle } = makeEngine();
    answerWizard.mockResolvedValue({ text: "Next step.", action: "none" });

    await expect(
      runSystemAgentChatInput({
        engine,
        input: {
          sessionId: "s1",
          wizardAnswer: { stepId: "channel", value: "twitch" },
        },
      }),
    ).resolves.toEqual({ text: "Next step.", action: "none" });

    expect(answerWizard).toHaveBeenCalledWith({ stepId: "channel", value: "twitch" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("routes a structured wizard cancel through the typed engine seam", async () => {
    const { engine, answerWizard, cancelWizard, handle } = makeEngine();
    cancelWizard.mockResolvedValue({ text: "Setup cancelled.", action: "none" });

    await expect(
      runSystemAgentChatInput({
        engine,
        input: {
          sessionId: "s1",
          wizardCancel: { stepId: "channel" },
        },
      }),
    ).resolves.toEqual({ text: "Setup cancelled.", action: "none" });

    expect(cancelWizard).toHaveBeenCalledWith({ stepId: "channel" });
    expect(answerWizard).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("polls a structured wizard step without answering it", async () => {
    const { engine, pollStep, handle } = makeEngine();
    pollStep.mockResolvedValue({ text: "Still waiting.", action: "none" });

    await expect(
      runSystemAgentChatInput({ engine, input: { sessionId: "s1", pollStepId: "qr" } }),
    ).resolves.toEqual({ text: "Still waiting.", action: "none" });

    expect(pollStep).toHaveBeenCalledWith("qr");
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves the enriched wizard step in the gateway result", () => {
    expect(
      buildSystemAgentChatResult({
        sessionId: "s1",
        reply: {
          text: "Choose a channel.",
          action: "none",
          step: {
            id: "channel",
            type: "select",
            message: "Channel",
            options: [{ label: "Twitch", value: "twitch" }],
          },
        },
      }),
    ).toMatchObject({
      sessionId: "s1",
      reply: "Choose a channel.",
      action: "none",
      step: { id: "channel", type: "select" },
    });
  });

  it("preserves non-input wizard settlement in the gateway result", () => {
    expect(
      buildSystemAgentChatResult({
        sessionId: "s1",
        reply: {
          text: "Setup is still finishing the QR attempt.",
          action: "none",
          wizardSettling: true,
        },
      }),
    ).toMatchObject({
      sessionId: "s1",
      action: "none",
      wizardSettling: true,
    });
  });
});
