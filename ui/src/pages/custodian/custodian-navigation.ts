import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";

function pathForCustodianAgentHandoff(
  context: Pick<ApplicationContext, "agents" | "agentSelection" | "basePath" | "gateway">,
  sessionKey: string,
): string {
  return sessionNavigationTarget({
    face: "chat",
    sessionKey,
    fallbackAgentId: resolveSessionNavigationAgentId(context),
    basePath: context.basePath,
    mainKey: resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  }).href;
}

export async function applyCustodianChatNavigation(params: {
  context: ApplicationContext;
  result: SystemAgentChatResult;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const { context, result } = params;
  if (result.action === "exit") {
    context.navigate("chat");
    return true;
  }
  if (result.action !== "open-agent") {
    return true;
  }
  let sessionKey = context.gateway.snapshot.sessionKey?.trim();
  if (result.agentId) {
    const roster = await context.agents.refreshList();
    if (!params.isCurrent()) {
      return false;
    }
    sessionKey = buildAgentMainSessionKey({
      agentId: result.agentId,
      mainKey: roster?.mainKey,
    });
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: result.agentId,
    });
  }
  if (result.agentDraft === "hatch" && sessionKey) {
    context.navigate("chat", {
      pathname: pathForCustodianAgentHandoff(context, sessionKey),
      search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
    });
  } else {
    context.navigate("chat");
  }
  return true;
}
