// Grok Build ACP event reducer.
//
// Phase 0 fixtures showed that `session/load` replays historical
// `session/update` chunks with `_meta.isReplay === true`. Those chunks must
// never enter the current turn accumulator or resumed replies will include
// previous-turn text.

export interface GrokAcpNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface GrokTurnState {
  sessionId?: string;
  promptComplete: boolean;
  replyText: string;
  skippedReplay: number;
  chunks: number;
  toolCalls: number;
  lastStopReason?: string;
  warnings: string[];
}

export interface ReduceResult {
  state: GrokTurnState;
  consumed: boolean;
  kind:
    | "reply_chunk"
    | "tool_call"
    | "prompt_complete"
    | "replay_skipped"
    | "ignored"
    | "warning";
}

export function newGrokTurnState(sessionId?: string): GrokTurnState {
  return {
    sessionId,
    promptComplete: false,
    replyText: "",
    skippedReplay: 0,
    chunks: 0,
    toolCalls: 0,
    warnings: [],
  };
}

export function reduceGrokAcpNotification(
  state: GrokTurnState,
  notification: GrokAcpNotification,
): ReduceResult {
  if (notification.method === "_x.ai/session/prompt_complete") {
    const params = asRecord(notification.params);
    const stopReason = typeof params?.stopReason === "string" ? params.stopReason : undefined;
    state.promptComplete = true;
    state.lastStopReason = stopReason;
    return { state, consumed: true, kind: "prompt_complete" };
  }

  if (notification.method !== "session/update") {
    return { state, consumed: false, kind: "ignored" };
  }

  const params = asRecord(notification.params);
  const meta = asRecord(params?._meta);
  if (meta?.isReplay === true) {
    state.skippedReplay++;
    return { state, consumed: false, kind: "replay_skipped" };
  }

  const update = asRecord(params?.update);
  const updateType = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : "";

  if (updateType === "agent_message_chunk") {
    const content = asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      state.replyText += content.text;
      state.chunks++;
      return { state, consumed: true, kind: "reply_chunk" };
    }
    state.warnings.push("agent_message_chunk without text content");
    return { state, consumed: false, kind: "warning" };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    state.toolCalls++;
    return { state, consumed: true, kind: "tool_call" };
  }

  return { state, consumed: false, kind: "ignored" };
}

export function reduceGrokAcpNotifications(
  notifications: GrokAcpNotification[],
  sessionId?: string,
): GrokTurnState {
  const state = newGrokTurnState(sessionId);
  for (const notification of notifications) {
    reduceGrokAcpNotification(state, notification);
  }
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
