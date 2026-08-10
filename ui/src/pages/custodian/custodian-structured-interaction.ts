import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { custodianWizardSubmission } from "./custodian-wizard-step.ts";
import type * as eventNudgeState from "./event-nudge.ts";
import { custodianChatParams, type CustodianSessionVariant } from "./session-lifecycle.ts";
import type { CustodianMessage, CustodianStructuredResponse } from "./transcript.ts";

type StructuredInteractionState = {
  activeClient: GatewayBrowserClient | null;
  chatAvailable: boolean;
  messages: readonly CustodianMessage[];
  sending: boolean;
  sessionId: string;
  setupRequired: boolean;
  variant: CustodianSessionVariant;
  wizardCancelAvailable: boolean;
  wizardInputPending: boolean;
};

type StructuredInteractionHost = {
  state: () => StructuredInteractionState;
  emit: () => void;
  exitSetup: () => void;
  markDismissed: (message: CustodianMessage, questionId: string) => void;
  replaceMessages: (messages: CustodianMessage[]) => void;
  sendUserTurn: (
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    display: string,
  ) => Promise<eventNudgeState.CustodianSendOutcome>;
};

function withResponse(
  messages: readonly CustodianMessage[],
  messageId: number,
  response: CustodianStructuredResponse | null,
): CustodianMessage[] | null {
  const target = messages.find((message) => message.id === messageId);
  return target
    ? messages.map((message) =>
        message === target ? { ...message, structuredResponse: response } : message,
      )
    : null;
}

export function createCustodianStructuredInteraction(host: StructuredInteractionHost) {
  const submit = async (params: {
    client: GatewayBrowserClient;
    message: CustodianMessage;
    request: SystemAgentChatParams;
    display: string;
  }): Promise<eventNudgeState.CustodianSendOutcome> => {
    const state = host.state();
    if (
      !state.chatAvailable ||
      state.sending ||
      state.setupRequired ||
      !state.messages.includes(params.message)
    ) {
      host.emit();
      return "rejected";
    }
    host.replaceMessages(
      withResponse(state.messages, params.message.id, {
        display: params.display,
        state: "submitting",
      }) ?? [...state.messages],
    );
    host.emit();
    const outcome = await host.sendUserTurn(params.client, params.request, params.display);
    const current = host.state();
    const response: CustodianStructuredResponse | null =
      outcome === "rejected"
        ? null
        : {
            display: params.display,
            state: outcome === "unknown" ? "uncertain" : "submitted",
          };
    const messages = withResponse(current.messages, params.message.id, response);
    if (messages) {
      host.replaceMessages(messages);
      host.emit();
    }
    return outcome;
  };

  return {
    async dismissQuestion(message: CustodianMessage): Promise<void> {
      const question = message.question;
      if (!question) {
        return;
      }
      if (question.skipAction === "exit") {
        host.exitSetup();
        return;
      }
      const state = host.state();
      if (!state.activeClient) {
        return;
      }
      const outcome = await submit({
        client: state.activeClient,
        message,
        request: {
          sessionId: state.sessionId,
          ...custodianChatParams(state.variant, question.isOther ? t("optionCard.skip") : "cancel"),
        },
        display: t("optionCard.skip"),
      });
      if (outcome !== "rejected" && host.state().messages.includes(message)) {
        host.markDismissed(message, question.id);
      }
    },

    answerQuestion(message: CustodianMessage, label: string): void {
      const state = host.state();
      const question = message.question;
      if (!question || !state.activeClient) {
        return;
      }
      const option = question.options.find((candidate) => candidate.label === label);
      void submit({
        client: state.activeClient,
        message,
        request: {
          sessionId: state.sessionId,
          ...custodianChatParams(state.variant, option?.reply ?? label),
        },
        display: label,
      });
    },

    answerWizardStep(message: CustodianMessage, value: unknown): void {
      const state = host.state();
      const submission = message.step ? custodianWizardSubmission(message.step, value) : null;
      if (!submission || !state.activeClient || !state.wizardInputPending) {
        host.emit();
        return;
      }
      void submit({
        client: state.activeClient,
        message,
        request: { sessionId: state.sessionId, wizardAnswer: submission.answer },
        display: message.step?.sensitive ? t("custodian.sensitiveReply") : submission.display,
      });
    },

    cancelWizardStep(message: CustodianMessage): void {
      const state = host.state();
      const step = message.step;
      const activeWizardMessage = state.messages.findLast((candidate) => candidate.step !== null);
      if (
        !step ||
        message !== activeWizardMessage ||
        !state.wizardInputPending ||
        !state.wizardCancelAvailable ||
        !state.activeClient
      ) {
        host.emit();
        return;
      }
      void submit({
        client: state.activeClient,
        message,
        request: { sessionId: state.sessionId, wizardCancel: { stepId: step.id } },
        display: t("custodian.cancel"),
      });
    },
  };
}
