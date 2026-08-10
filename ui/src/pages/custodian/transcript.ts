import type {
  SystemAgentChatHistoryResult,
  SystemAgentChatHistoryTurn,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { handleMarkdownCodeBlockCopy } from "../../components/markdown-code-blocks.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { renderChatDivider } from "../chat/components/chat-divider.ts";
import { renderMarkdownText } from "../chat/components/chat-message-markdown.ts";
import { renderMessageGroup } from "../chat/components/chat-message.ts";
import { renderCustodianQuestionCard } from "./custodian-question-card.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";

const CUSTODIAN_TRANSCRIPT_TIMEOUT_MS = 15_000;

export type CustodianMessage = {
  id: number;
  role: "assistant" | "user";
  text: string;
  at: number;
  question: CustodianStructuredQuestion | null;
  step: WizardStep | null;
  structuredResponse: CustodianStructuredResponse | null;
  sessionId?: string;
};

export type CustodianStructuredResponse = {
  display: string;
  state: "submitting" | "submitted" | "uncertain";
};

export function hasUnresolvedCustodianQuestion(
  messages: readonly CustodianMessage[],
  dismissedQuestions: ReadonlySet<string>,
  answeredQuestions: ReadonlySet<string>,
  wizardInputPending: boolean,
  replyUncertain: boolean,
): boolean {
  return (
    wizardInputPending ||
    replyUncertain ||
    messages.some(
      (message) =>
        message.question !== null &&
        !dismissedQuestions.has(`${message.id}:${message.question.id}`) &&
        !answeredQuestions.has(`${message.id}:${message.question.id}`),
    )
  );
}

export function retireCustodianQuestions(
  messages: readonly CustodianMessage[],
  answeredQuestions: ReadonlySet<string>,
): Set<string> {
  const answered = new Set(answeredQuestions);
  for (const message of messages) {
    if (message.question) {
      answered.add(`${message.id}:${message.question.id}`);
    }
  }
  return answered;
}

export function createCustodianSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `control-ui-onboarding-${crypto.randomUUID()}`;
  }
  const suffix = [...crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  return `control-ui-onboarding-${suffix}`;
}

export function custodianErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : t("custodian.requestFailed");
}

function toCustodianMessageGroup(message: CustodianMessage): MessageGroup {
  const key = `msg-${message.id}`;
  return {
    kind: "group",
    key,
    role: message.role,
    messages: [{ message: { role: message.role, content: message.text }, key }],
    timestamp: message.at,
    isStreaming: false,
  };
}

async function readCustodianTranscript(
  client: GatewayBrowserClient,
  sessionId?: string,
): Promise<SystemAgentChatHistoryResult> {
  return await client.request<SystemAgentChatHistoryResult>(
    "openclaw.chat.history",
    sessionId ? { sessionId } : {},
    {
      timeoutMs: CUSTODIAN_TRANSCRIPT_TIMEOUT_MS,
    },
  );
}

/**
 * Sensitive turns are masked server-side before persistence: the engine pushes
 * only "<redacted secret>" into history (never raw input), so durable turns
 * cannot carry credentials. This mapping only localizes that marker to the
 * same display text live sensitive replies use.
 */
const SERVER_SENSITIVE_MASK = "<redacted secret>";

function createCustodianTranscriptMessages(
  turns: readonly SystemAgentChatHistoryTurn[],
  firstMessageId: number,
  activeWizard?: SystemAgentChatHistoryResult["activeWizard"],
): { messages: CustodianMessage[]; nextMessageId: number } {
  let nextMessageId = firstMessageId;
  const messages: CustodianMessage[] = [];
  for (const turn of turns) {
    const display =
      turn.role === "user" && turn.text === SERVER_SENSITIVE_MASK
        ? t("custodian.sensitiveReply")
        : turn.text;
    if (turn.role === "user" && turn.wizardAction) {
      const previous = messages.at(-1);
      const ownsPreviousPrompt =
        previous?.role === "assistant" &&
        turn.sessionId !== undefined &&
        previous.sessionId === turn.sessionId;
      const supportingText = ownsPreviousPrompt ? previous.text : "";
      if (supportingText) {
        messages.pop();
      }
      messages.push({
        id: nextMessageId++,
        role: "assistant",
        text: supportingText,
        at: turn.at,
        question: null,
        step: turn.wizardAction.step,
        structuredResponse: { display, state: "submitted" },
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      });
      continue;
    }
    messages.push({
      id: nextMessageId++,
      role: turn.role,
      text: display,
      at: turn.at,
      question: null,
      step: null,
      structuredResponse: null,
      ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    });
  }
  if (activeWizard) {
    const activePrompt = messages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.sessionId === activeWizard.sessionId &&
        message.structuredResponse === null,
    );
    if (activePrompt) {
      activePrompt.step = activeWizard.step;
    } else {
      messages.push({
        id: nextMessageId++,
        role: "assistant",
        text: "",
        at: Date.now(),
        question: null,
        step: activeWizard.step,
        structuredResponse: null,
        sessionId: activeWizard.sessionId,
      });
    }
  }
  return { messages, nextMessageId };
}

export type CustodianTranscriptSnapshot = {
  messages: CustodianMessage[];
  nextMessageId: number;
  earlierBoundaryAfterId: number | null;
  recoveredStep?: WizardStep;
};

export async function loadCustodianTranscriptSnapshot(
  client: GatewayBrowserClient,
  firstMessageId: number,
  sessionId?: string,
): Promise<CustodianTranscriptSnapshot> {
  const history = await readCustodianTranscript(client, sessionId);
  const transcript = createCustodianTranscriptMessages(
    history.turns,
    firstMessageId,
    sessionId && history.activeWizard?.sessionId === sessionId ? history.activeWizard : undefined,
  );
  const earlierBoundaryAfterId = transcript.messages.at(-1)?.id ?? null;
  const activeWizard = history.activeWizard;
  const recoveredStep =
    sessionId && activeWizard?.sessionId === sessionId ? activeWizard.step : null;
  return {
    ...transcript,
    earlierBoundaryAfterId,
    ...(recoveredStep ? { recoveredStep } : {}),
  };
}

function wizardFallbackText(step: WizardStep): string {
  const lines: string[] = [];
  if (step.title) {
    lines.push(`**${step.title}**`);
  }
  if (step.message) {
    lines.push(step.message);
  }
  const options = (step.options ?? []).map(
    (option, index) => `${index + 1}. ${option.label}${option.hint ? ` — ${option.hint}` : ""}`,
  );
  if (step.type === "select") {
    lines.push(...options, "Reply with a number.");
  } else if (step.type === "multiselect") {
    lines.push(...options, "Reply with numbers (e.g. 1,3) or `none`.");
  } else if (step.type === "confirm") {
    lines.push("Reply yes or no.");
  } else if (step.type === "text") {
    if (step.placeholder) {
      lines.push(`(e.g. ${step.placeholder})`);
    }
    lines.push("Type your answer.");
  }
  return lines.filter(Boolean).join("\n");
}

function formatTrailingJson(markdown: string): string {
  const lines = markdown.split("\n");
  const jsonStart = lines.findIndex((line) => line.trim() === "{");
  if (jsonStart < 0) {
    return markdown;
  }
  const jsonText = lines.slice(jsonStart).join("\n").trim();
  try {
    const parsed: unknown = JSON.parse(jsonText);
    const prose = lines.slice(0, jsonStart).join("\n").trim();
    return [prose, "```json", JSON.stringify(parsed, null, 2), "```"].filter(Boolean).join("\n\n");
  } catch {
    return markdown;
  }
}

function custodianWizardSupportingMarkdown(text: string, step: WizardStep): string {
  const cancelHint = "Say `cancel` to stop this setup.";
  const fallback = wizardFallbackText(step);
  let supporting = text.trim();
  for (const suffix of [`${fallback}\n${cancelHint}`, fallback]) {
    if (supporting === suffix) {
      supporting = "";
      break;
    }
    const separatedSuffix = `\n\n${suffix}`;
    if (supporting.endsWith(separatedSuffix)) {
      supporting = supporting.slice(0, -separatedSuffix.length).trim();
      break;
    }
  }
  const normalizedLists = supporting.replace(/^(\s*\d+)\)\s+/gm, "$1. ");
  return formatTrailingJson(normalizedLists);
}

function renderCustodianEarlierDivider(message: CustodianMessage, boundaryAfterId: number | null) {
  return message.id === boundaryAfterId
    ? renderChatDivider({
        kind: "divider",
        key: "custodian-earlier",
        label: t("custodian.earlier"),
        timestamp: message.at,
      })
    : nothing;
}

function structuredPrompt(message: CustodianMessage): string {
  return (
    message.step?.title ??
    message.step?.message ??
    message.question?.question ??
    t("custodian.structured.response")
  );
}

function renderStructuredResponse(message: CustodianMessage) {
  const response = message.structuredResponse;
  if (!response) {
    return nothing;
  }
  const status =
    response.state === "submitting"
      ? t("custodian.structured.submitting")
      : response.state === "uncertain"
        ? t("custodian.structured.confirmationUnavailable")
        : t("custodian.structured.submitted");
  return html`<section
    class="custodian__structured-response"
    aria-label=${t("custodian.structured.response")}
    aria-busy=${response.state === "submitting" ? "true" : "false"}
  >
    <span class="custodian__structured-response-icon" aria-hidden="true">${icons.check}</span>
    <span class="custodian__structured-response-copy">
      <span class="custodian__structured-response-prompt">${structuredPrompt(message)}</span>
      <strong>${response.display}</strong>
      <span class="sr-only">${status}</span>
    </span>
  </section>`;
}

export function renderCustodianTranscriptEntry(params: {
  message: CustodianMessage;
  boundaryAfterId: number | null;
  assistantAvatar: string;
  showQuestion: boolean;
  questionDisabled: boolean;
  showWizardStep: boolean;
  wizardValue: unknown;
  wizardDisabled: boolean;
  wizardSecretVisible: boolean;
  showWizardCancel: boolean;
  onSelect: (label: string) => void;
  onSkip: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown) => void;
  onWizardCancel: () => void;
  onToggleWizardSecretVisibility: () => void;
}) {
  const question = params.message.question;
  const step = params.message.step;
  const hasStructuredResponse = params.message.structuredResponse !== null;
  const hasActiveQuestion = params.showQuestion && question !== null;
  const hasActiveWizardStep = params.showWizardStep && step !== null;
  const showTranscriptMessage =
    params.message.text && !hasActiveQuestion && !hasActiveWizardStep && !hasStructuredResponse;
  const guidance =
    hasActiveWizardStep && step ? custodianWizardSupportingMarkdown(params.message.text, step) : "";
  return html`
    ${showTranscriptMessage
      ? renderMessageGroup(toCustodianMessageGroup(params.message), {
          showReasoning: false,
          showToolCalls: false,
          assistantName: t("custodian.title"),
          assistantAvatar: params.assistantAvatar,
        })
      : nothing}
    ${renderCustodianEarlierDivider(params.message, params.boundaryAfterId)}
    ${hasStructuredResponse
      ? renderStructuredResponse(params.message)
      : params.showQuestion && question
        ? renderCustodianQuestionCard({
            question,
            disabled: params.questionDisabled,
            onSelect: params.onSelect,
            onSkip: params.onSkip,
          })
        : nothing}
    ${hasActiveWizardStep && !hasStructuredResponse && step
      ? html`<section
          class="custodian__wizard-step"
          aria-label=${step.title ?? step.message ?? "Setup"}
        >
          ${step.title
            ? html`<strong class="custodian__wizard-title">${step.title}</strong>`
            : nothing}
          ${guidance
            ? html`<div class="custodian__wizard-guidance" @click=${handleMarkdownCodeBlockCopy}>
                ${renderMarkdownText(guidance, false, { jsonCodeBlockCollapse: "never" })}
              </div>`
            : nothing}
          ${renderWizardStepControls({
            step,
            value: params.wizardValue,
            busy: params.wizardDisabled,
            inputId: `custodian-wizard-input-${params.message.id}`,
            sensitiveRevealed: params.wizardSecretVisible,
            onValueChange: params.onWizardValueChange,
            onAnswer: params.onWizardAnswer,
            leadingAction: params.showWizardCancel
              ? html`<button
                  class="btn btn--ghost custodian__wizard-cancel"
                  type="button"
                  ?disabled=${params.wizardDisabled}
                  @click=${params.onWizardCancel}
                >
                  ${t("custodian.cancel")}
                </button>`
              : undefined,
            onToggleSensitiveVisibility: params.onToggleWizardSecretVisibility,
          })}
        </section>`
      : nothing}
  `;
}
