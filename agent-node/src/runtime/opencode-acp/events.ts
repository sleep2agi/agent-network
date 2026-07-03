// RFC-029 PR② — opencode ACP notification reducer.
//
// Derived from agent-node/src/runtime/grok-build-acp/events.ts. The wire
// framing (JSON-RPC 2.0 over stdio) and the streaming envelope
// (`session/update` notifications carrying a nested
// `params.update.sessionUpdate` discriminator) are byte-identical to
// Grok's Zed ACP; Phase 0b probes verified this against opencode-ai@
// 1.17.13's `spawn('opencode', ['acp'])` output (see
// `docs/analysis/rfc029-opencode-probe/u8-acp.txt`).
//
// Diff vs the Grok reducer is small enough to keep the shim tiny (per
// the RFC v0.3 §5 estimate of ~15-25 LOC net):
//
//   1. Turn-end.
//      Grok emits a bespoke `_x.ai/session/prompt_complete` notification
//      with a `stopReason` string. opencode instead completes the turn
//      by RESPONDING to the client-issued `session/prompt` request
//      (id-carrying JSON-RPC response) with `result.stopReason`. This
//      reducer therefore consumes a response frame — not a notification —
//      for the turn-end signal. The dispatcher (client.ts) is
//      responsible for correlating the response back to the same
//      state machine that saw the streaming notifications.
//
//   2. New sessionUpdate subtypes.
//      opencode emits `agent_thought_chunk` while the model is
//      reasoning (grok never does — it hides reasoning). We aggregate
//      it into a separate `thoughtText` field for parity with the
//      #383 thinking-only rescue logic — if a terminal turn produces
//      thought but no `agent_message_chunk`, the caller can re-prompt
//      exactly like the claude runtime does.
//
//   3. Bookkeeping.
//      `usage_update` and `available_commands_update` are informational
//      only; we track them to a warnings-free bucket so the reducer's
//      "kind: ignored" fallback doesn't fire on healthy traffic.

export interface OpencodeAcpNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export interface OpencodeAcpResponse {
  jsonrpc?: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface OpencodeTurnState {
  sessionId?: string;
  promptComplete: boolean;
  replyText: string;
  thoughtText: string;
  chunks: number;
  thoughtChunks: number;
  toolCalls: number;
  lastStopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
  };
  warnings: string[];
}

export interface ReduceResult {
  state: OpencodeTurnState;
  consumed: boolean;
  kind:
    | "reply_chunk"
    | "thought_chunk"
    | "tool_call"
    | "usage_update"
    | "available_commands"
    | "prompt_complete"
    | "ignored"
    | "warning";
}

export function newOpencodeTurnState(sessionId?: string): OpencodeTurnState {
  return {
    sessionId,
    promptComplete: false,
    replyText: "",
    thoughtText: "",
    chunks: 0,
    thoughtChunks: 0,
    toolCalls: 0,
    warnings: [],
  };
}

/**
 * Consume an id-carrying `session/prompt` response frame. Sets the
 * terminal state (`promptComplete + lastStopReason + usage`) so the
 * caller can settle its `think()` promise. Response frames don't
 * carry `method`, hence this distinct entry point vs the streaming
 * notification reducer below.
 */
export function reduceOpencodeAcpResponse(
  state: OpencodeTurnState,
  response: OpencodeAcpResponse,
): ReduceResult {
  const result = asRecord(response.result);
  const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
  const usage = asRecord(result?.usage);
  if (usage) {
    state.usage = {
      inputTokens: numberField(usage.inputTokens),
      outputTokens: numberField(usage.outputTokens),
      totalTokens: numberField(usage.totalTokens),
      thoughtTokens: numberField(usage.thoughtTokens),
    };
  }
  state.promptComplete = true;
  state.lastStopReason = stopReason;
  return { state, consumed: true, kind: "prompt_complete" };
}

export function reduceOpencodeAcpNotification(
  state: OpencodeTurnState,
  notification: OpencodeAcpNotification,
): ReduceResult {
  if (notification.method !== "session/update") {
    return { state, consumed: false, kind: "ignored" };
  }

  const params = asRecord(notification.params);
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

  if (updateType === "agent_thought_chunk") {
    const content = asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      state.thoughtText += content.text;
      state.thoughtChunks++;
      return { state, consumed: true, kind: "thought_chunk" };
    }
    return { state, consumed: false, kind: "warning" };
  }

  if (updateType === "tool_call" || updateType === "tool_call_update") {
    state.toolCalls++;
    return { state, consumed: true, kind: "tool_call" };
  }

  if (updateType === "usage_update") {
    // Snap the running usage totals into state so callers can log them
    // even before the terminal response arrives.
    const inFlight = update as Record<string, unknown>;
    if (typeof inFlight.used === "number") {
      state.usage = { ...state.usage, totalTokens: inFlight.used };
    }
    return { state, consumed: true, kind: "usage_update" };
  }

  if (updateType === "available_commands_update") {
    return { state, consumed: true, kind: "available_commands" };
  }

  return { state, consumed: false, kind: "ignored" };
}

/** Ergonomic wrapper for tests / offline replay: feed an ordered list
 *  of frames (mixed notifications + responses) and return the reduced
 *  turn state. */
export function reduceOpencodeAcpFrames(
  frames: Array<OpencodeAcpNotification | OpencodeAcpResponse>,
  sessionId?: string,
): OpencodeTurnState {
  const state = newOpencodeTurnState(sessionId);
  for (const frame of frames) {
    // Response frames carry `id` and never `method`. This
    // discriminant is precisely how the wire distinguishes the two;
    // no ambiguity in real traffic.
    if ("id" in frame && frame.id !== undefined && !("method" in frame && (frame as any).method)) {
      reduceOpencodeAcpResponse(state, frame as OpencodeAcpResponse);
    } else if ("method" in frame && (frame as any).method) {
      reduceOpencodeAcpNotification(state, frame as OpencodeAcpNotification);
    }
  }
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
