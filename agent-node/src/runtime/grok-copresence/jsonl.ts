/**
 * Pure reducers for Grok's on-disk copresence protocol.
 *
 * The PTY owner tails chat_history.jsonl and events.jsonl, then feeds complete
 * lines here. This module deliberately performs no filesystem, PTY, or network
 * I/O so restart/race behaviour can be fixture-tested.
 */

export const MAX_GROK_JSONL_LINE_BYTES = 1_048_576;
export const MAX_GROK_COMPLETION_CANDIDATES = 8;
export const MAX_OWNED_NETWORK_TASKS = 1_024;

export type GrokJsonlSource = "chat_history" | "events";

type JsonRecord = Record<string, unknown>;

export interface AgentNetworkEnvelope {
  from: string;
  taskId: string;
  message: string;
}

export interface OwnedNetworkTask {
  from: string;
  taskId: string;
}

export type GrokCompletionStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface GrokCompletionSignal {
  /** True only for a terminal shape we currently understand. */
  recognized: boolean;
  /** Candidate shapes are retained even when not yet understood. */
  candidate: boolean;
  status: GrokCompletionStatus;
  discriminator?: string;
  raw: JsonRecord;
}

export interface GrokActiveTurn {
  origin: "human" | "network";
  query: string;
  /** `events.jsonl` lifecycle epoch paired to this chat turn. */
  turnNumber?: number;
  parsedEnvelope?: AgentNetworkEnvelope;
  networkTask?: OwnedNetworkTask;
  finalAssistantText?: string;
  assistantMessages: number;
  /** Set when events.jsonl wins a polling race against chat_history.jsonl. */
  pendingCompletion?: GrokCompletionSignal;
}

export interface GrokJsonlStats {
  parsedLines: number;
  ignoredLines: number;
  malformedLines: number;
  oversizedLines: number;
  orphanAssistants: number;
  orphanCompletions: number;
}

export interface GrokJsonlState {
  version: 1;
  ownedNetworkTasks: OwnedNetworkTask[];
  activeTurn?: GrokActiveTurn;
  /** The one `turn_started` epoch currently open in events.jsonl. */
  openTurnNumber?: number;
  /** Set by malformed/overlapping lifecycle starts; next end cannot succeed. */
  lifecycleInvalid?: boolean;
  /** An open epoch abandoned by a later chat user; its terminal is quarantined. */
  abandonedTurnNumber?: number;
  /** Chat turns abandoned before events exposed their turn_started epoch. */
  abandonedUnnumberedTurns?: number;
  /** Terminal event observed before chat_history exposed its user line. */
  pendingOrphanCompletion?: GrokCompletionSignal;
  /** Epoch carried by pendingOrphanCompletion; both fields move together. */
  pendingOrphanTurnNumber?: number;
  /** Trusted PTY-side origin expected for a pending orphan completion. */
  pendingOrphanOrigin?: "human" | "network";
  /** Exact network owner captured when an event-first terminal was observed. */
  pendingOrphanNetworkTask?: OwnedNetworkTask;
  /** Set immediately before the PTY owner submits a human composer turn. */
  expectedHumanTurn: boolean;
  /** Bounded forensic evidence for version-sensitive completion schemas. */
  completionCandidates: GrokCompletionSignal[];
  partialLines: Record<GrokJsonlSource, string>;
  droppingOversizedLine: Record<GrokJsonlSource, boolean>;
  stats: GrokJsonlStats;
}

export type GrokCopresenceEvent =
  | {
    kind: "human_user";
    query: string;
    /** Present when a human/replayed line looked like a network injection. */
    unownedNetworkEnvelope?: AgentNetworkEnvelope;
  }
  | {
    kind: "network_user";
    query: string;
    rawQuery: string;
    task: OwnedNetworkTask;
  }
  | {
    kind: "network_reply";
    task: OwnedNetworkTask;
    text: string;
    completion: GrokCompletionSignal;
  }
  | {
    kind: "turn_completed";
    origin: "human" | "network" | "orphan";
    status: GrokCompletionStatus;
    completion: GrokCompletionSignal;
    task?: OwnedNetworkTask;
  }
  | {
    kind: "completion_pending_reply";
    task: OwnedNetworkTask;
    completion: GrokCompletionSignal;
  }
  | {
    kind: "turn_abandoned";
    origin: "human" | "network";
    reason: "new_user_before_completion";
    task?: OwnedNetworkTask;
  }
  | {
    kind: "malformed";
    source: GrokJsonlSource;
    reason: "invalid_json" | "non_object_json" | "line_too_large";
  };

export interface GrokJsonlReduceResult {
  state: GrokJsonlState;
  events: GrokCopresenceEvent[];
}

export function newGrokJsonlState(
  ownedNetworkTasks: readonly OwnedNetworkTask[] = [],
): GrokJsonlState {
  const state: GrokJsonlState = {
    version: 1,
    ownedNetworkTasks: [],
    expectedHumanTurn: false,
    completionCandidates: [],
    partialLines: { chat_history: "", events: "" },
    droppingOversizedLine: { chat_history: false, events: false },
    stats: {
      parsedLines: 0,
      ignoredLines: 0,
      malformedLines: 0,
      oversizedLines: 0,
      orphanAssistants: 0,
      orphanCompletions: 0,
    },
  };
  for (const task of ownedNetworkTasks) registerOwnedNetworkTask(state, task);
  return state;
}

/** Register synchronously before the PTY owner writes a human submit key. */
export function registerExpectedGrokHumanTurn(state: GrokJsonlState): void {
  if (state.expectedHumanTurn) {
    throw new Error("a Grok human turn is already awaiting its user log");
  }
  state.expectedHumanTurn = true;
}

/** Register before writing the envelope to the PTY. Prefixes alone are not trusted. */
export function registerOwnedNetworkTask(
  state: GrokJsonlState,
  task: OwnedNetworkTask,
): void {
  assertEnvelopePart(task.from, "from");
  assertEnvelopePart(task.taskId, "taskId");
  const duplicate = state.ownedNetworkTasks.find((item) => item.taskId === task.taskId);
  if (duplicate) {
    if (duplicate.from !== task.from) {
      throw new Error(`network task ${task.taskId} is already owned by a different sender`);
    }
    return;
  }
  if (state.ownedNetworkTasks.length >= MAX_OWNED_NETWORK_TASKS) {
    throw new Error(`too many pending network tasks (max ${MAX_OWNED_NETWORK_TASKS})`);
  }
  state.ownedNetworkTasks.push({ from: task.from, taskId: task.taskId });
}

export function unregisterOwnedNetworkTask(
  state: GrokJsonlState,
  taskId: string,
): boolean {
  const index = state.ownedNetworkTasks.findIndex((item) => item.taskId === taskId);
  if (index < 0) return false;
  const [removed] = state.ownedNetworkTasks.splice(index, 1);
  if (
    state.pendingOrphanOrigin === "network"
    && sameOwnedTask(state.pendingOrphanNetworkTask, removed)
  ) {
    clearPendingOrphanCompletion(state);
  }
  return true;
}

/** Parse only an envelope anchored at the beginning of the actual user query. */
export function parseAgentNetworkEnvelope(query: string): AgentNetworkEnvelope | undefined {
  const match = query.match(
    /^\s*\[Agent Network\/from=([^\]/\r\n]+)\/task=([^\]/\r\n]+)\][ \t]*(.*)$/s,
  );
  if (!match) return undefined;
  const from = match[1].trim();
  const taskId = match[2].trim();
  if (!isSafeEnvelopePart(from) || !isSafeEnvelopePart(taskId)) return undefined;
  return { from, taskId, message: match[3] };
}

/** Extract the query Grok stores inside its user wrapper; array content is supported too. */
export function extractGrokUserQuery(record: unknown): string | undefined {
  const object = asRecord(record);
  if (!object || object.type !== "user") return undefined;
  const content = extractText(object.content);
  if (content === undefined) return undefined;

  // The outermost/first wrapper is authoritative. Taking the last wrapper
  // lets untrusted prompt text close/reopen user_query and change its origin.
  const match = content.match(/<user_query>([\s\S]*?)<\/user_query>/);
  // Grok also persists system reminders as `type=user`. Only the verified
  // user_query wrapper denotes an actual human/network turn.
  return match ? match[1].trim() : undefined;
}

/**
 * Recognize known terminal records without treating arbitrary assistant/user
 * prose as lifecycle control. Candidate raw objects remain available in state.
 */
export function detectGrokCompletionEvent(record: unknown): GrokCompletionSignal | undefined {
  const raw = asRecord(record);
  if (!raw) return undefined;
  const discriminator = typeof raw.type === "string" ? raw.type : undefined;
  if (!discriminator) return undefined;
  const normalized = normalizeDiscriminator(discriminator);
  const recognized = discriminator === "turn_ended";
  const candidate = recognized
    || (/(^|_)turn(_|$)/.test(normalized) && /(complet|end|finish|done)/.test(normalized));
  if (!candidate) return undefined;

  // 0.2.93's verified terminal contract is exact: only top-level
  // `turn_ended` and only outcome="completed" is a successful turn.
  // status/result aliases and success/done/ok must never widen that gate.
  const statusValue = typeof raw.outcome === "string" ? raw.outcome : undefined;
  let status: GrokCompletionStatus = "unknown";
  if (recognized && statusValue === "completed") status = "completed";
  else if (recognized && statusValue && /^(?:cancelled|canceled|aborted|interrupted)$/.test(statusValue)) {
    status = "cancelled";
  } else if (recognized && statusValue) status = "failed";

  return {
    recognized,
    candidate: true,
    status,
    discriminator,
    raw,
  };
}

export function reduceGrokJsonlLine(
  state: GrokJsonlState,
  source: GrokJsonlSource,
  rawLine: string,
): GrokJsonlReduceResult {
  const events: GrokCopresenceEvent[] = [];
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.trim()) return { state, events };

  if (byteLength(line) > MAX_GROK_JSONL_LINE_BYTES) {
    state.stats.oversizedLines++;
    events.push({ kind: "malformed", source, reason: "line_too_large" });
    return { state, events };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.stats.malformedLines++;
    events.push({ kind: "malformed", source, reason: "invalid_json" });
    return { state, events };
  }
  const record = asRecord(parsed);
  if (!record) {
    state.stats.malformedLines++;
    events.push({ kind: "malformed", source, reason: "non_object_json" });
    return { state, events };
  }
  state.stats.parsedLines++;

  if (source === "chat_history") reduceChatHistoryRecord(state, record, events);
  else reduceEventsRecord(state, record, events);
  return { state, events };
}

/**
 * Feed arbitrary tail chunks. Partial lines and an overlong-line drop mode are
 * held per file so chat/events reads may be interleaved safely.
 */
export function reduceGrokJsonlChunk(
  state: GrokJsonlState,
  source: GrokJsonlSource,
  chunk: string,
): GrokJsonlReduceResult {
  const events: GrokCopresenceEvent[] = [];
  let incoming = chunk;

  if (state.droppingOversizedLine[source]) {
    const newline = incoming.indexOf("\n");
    if (newline < 0) return { state, events };
    state.droppingOversizedLine[source] = false;
    incoming = incoming.slice(newline + 1);
  }

  let buffered = state.partialLines[source] + incoming;
  state.partialLines[source] = "";
  let newline: number;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const result = reduceGrokJsonlLine(state, source, buffered.slice(0, newline));
    events.push(...result.events);
    buffered = buffered.slice(newline + 1);
  }

  if (byteLength(buffered) > MAX_GROK_JSONL_LINE_BYTES) {
    state.stats.oversizedLines++;
    state.droppingOversizedLine[source] = true;
    events.push({ kind: "malformed", source, reason: "line_too_large" });
  } else {
    state.partialLines[source] = buffered;
  }
  return { state, events };
}

function reduceChatHistoryRecord(
  state: GrokJsonlState,
  record: JsonRecord,
  events: GrokCopresenceEvent[],
): void {
  if (record.type === "user") {
    const query = extractGrokUserQuery(record);
    if (query === undefined) {
      state.stats.ignoredLines++;
      return;
    }
    if (state.activeTurn) {
      events.push({
        kind: "turn_abandoned",
        origin: state.activeTurn.origin,
        reason: "new_user_before_completion",
        task: state.activeTurn.networkTask,
      });
      if (
        state.openTurnNumber !== undefined
        && state.activeTurn.turnNumber === state.openTurnNumber
      ) {
        state.abandonedTurnNumber = state.openTurnNumber;
        state.openTurnNumber = undefined;
      } else if (state.activeTurn.turnNumber === undefined) {
        state.abandonedUnnumberedTurns = (state.abandonedUnnumberedTurns ?? 0) + 1;
      }
    }

    const pendingOrphanCompletion = state.pendingOrphanCompletion;
    const pendingOrphanTurnNumber = state.pendingOrphanTurnNumber;
    const pendingOrphanOrigin = state.pendingOrphanOrigin;
    const pendingOrphanNetworkTask = state.pendingOrphanNetworkTask;
    clearPendingOrphanCompletion(state);
    const envelope = parseAgentNetworkEnvelope(query);
    const ownedIndex = envelope
      ? state.ownedNetworkTasks.findIndex(
        (task) => task.taskId === envelope.taskId && task.from === envelope.from,
      )
      : -1;
    const userOrigin = envelope && ownedIndex >= 0 ? "network" : "human";
    const networkOwnerMatches = userOrigin === "network"
      && ownedIndex >= 0
      && sameOwnedTask(pendingOrphanNetworkTask, state.ownedNetworkTasks[ownedIndex]);
    const matchedOrphanCompletion = (
      (pendingOrphanOrigin === "human" && userOrigin === "human")
      || (pendingOrphanOrigin === "network" && networkOwnerMatches)
    ) ? pendingOrphanCompletion : undefined;
    const turnNumber = matchedOrphanCompletion
      ? pendingOrphanTurnNumber
      : state.openTurnNumber;
    if (envelope && ownedIndex >= 0) {
      if (state.expectedHumanTurn) {
        state.expectedHumanTurn = false;
        state.lifecycleInvalid = true;
      }
      const [task] = state.ownedNetworkTasks.splice(ownedIndex, 1);
      state.activeTurn = {
        origin: "network",
        query: envelope.message,
        ...(turnNumber !== undefined ? { turnNumber } : {}),
        parsedEnvelope: envelope,
        networkTask: task,
        assistantMessages: 0,
        ...(matchedOrphanCompletion ? { pendingCompletion: matchedOrphanCompletion } : {}),
      };
      events.push({
        kind: "network_user",
        query: envelope.message,
        rawQuery: query,
        task,
      });
      if (matchedOrphanCompletion && matchedOrphanCompletion.status !== "completed") {
        events.push({
          kind: "turn_completed",
          origin: "network",
          status: matchedOrphanCompletion.status,
          completion: matchedOrphanCompletion,
          task,
        });
        state.activeTurn = undefined;
      }
      return;
    }

    state.expectedHumanTurn = false;
    state.activeTurn = {
      origin: "human",
      query,
      ...(turnNumber !== undefined ? { turnNumber } : {}),
      parsedEnvelope: envelope,
      assistantMessages: 0,
    };
    events.push(envelope
      ? { kind: "human_user", query, unownedNetworkEnvelope: envelope }
      : { kind: "human_user", query });
    if (matchedOrphanCompletion) {
      events.push({
        kind: "turn_completed",
        origin: "human",
        status: matchedOrphanCompletion.status,
        completion: matchedOrphanCompletion,
      });
      state.activeTurn = undefined;
    }
    return;
  }

  if (record.type === "assistant") {
    const candidate = extractAssistantCandidate(record);
    const turn = state.activeTurn;
    if (!turn) {
      state.stats.orphanAssistants++;
      return;
    }
    turn.assistantMessages++;
    if (candidate.eligibleFinal && candidate.text) turn.finalAssistantText = candidate.text;

    // If events.jsonl became visible first, keep collecting the delayed chat
    // file. The runtime flushes only after chat_history has been quiescent;
    // emitting here would mistake the first intermediate assistant for final.
    return;
  }

  // reasoning, tool_result, system-reminder, and future records are inert.
  state.stats.ignoredLines++;
}

/**
 * Finalize an event-first network completion after the chat tail has stayed
 * quiet for a runtime-controlled settling interval.
 */
export function flushPendingGrokNetworkReply(state: GrokJsonlState): GrokJsonlReduceResult {
  const turn = state.activeTurn;
  if (
    !turn
    || turn.origin !== "network"
    || !turn.networkTask
    || turn.pendingCompletion?.status !== "completed"
  ) {
    return { state, events: [] };
  }
  const text = selectFinalAssistant(turn);
  if (!text) return { state, events: [] };
  const event: GrokCopresenceEvent = {
    kind: "network_reply",
    task: turn.networkTask,
    text,
    completion: turn.pendingCompletion,
  };
  state.activeTurn = undefined;
  return { state, events: [event] };
}

function reduceEventsRecord(
  state: GrokJsonlState,
  record: JsonRecord,
  events: GrokCopresenceEvent[],
): void {
  if (record.type === "turn_started") {
    const turnNumber = parseTurnNumber(record.turn_number);
    if (turnNumber === undefined) {
      state.lifecycleInvalid = true;
      state.stats.ignoredLines++;
      return;
    }
    if ((state.abandonedUnnumberedTurns ?? 0) > 0) {
      if (
        state.openTurnNumber !== undefined
        || state.abandonedTurnNumber !== undefined
        || state.pendingOrphanCompletion
        || state.activeTurn?.pendingCompletion
      ) {
        state.lifecycleInvalid = true;
        state.stats.ignoredLines++;
        return;
      }
      const remaining = (state.abandonedUnnumberedTurns ?? 1) - 1;
      state.abandonedUnnumberedTurns = remaining > 0 ? remaining : undefined;
      state.abandonedTurnNumber = turnNumber;
      return;
    }
    // Only one Grok TUI turn may be open. A repeated or overlapping start is
    // retained as inert evidence rather than overwriting the routing epoch.
    if (
      state.openTurnNumber !== undefined
      || state.abandonedTurnNumber !== undefined
      || state.pendingOrphanCompletion
      || state.activeTurn?.pendingCompletion
      || state.activeTurn?.turnNumber !== undefined
    ) {
      state.lifecycleInvalid = true;
      state.stats.ignoredLines++;
      return;
    }
    state.openTurnNumber = turnNumber;
    if (state.activeTurn) state.activeTurn.turnNumber = turnNumber;
    return;
  }

  const completion = detectGrokCompletionEvent(record);
  if (!completion) {
    state.stats.ignoredLines++;
    return;
  }
  rememberCompletionCandidate(state, completion);
  if (!completion.recognized) {
    state.stats.ignoredLines++;
    return;
  }

  if (state.abandonedTurnNumber !== undefined && state.openTurnNumber === undefined) {
    // chat_history exposed the next user before events.jsonl exposed the old
    // terminal. Consume that stale boundary without attaching it to the new
    // human/network turn.
    state.abandonedTurnNumber = undefined;
    state.lifecycleInvalid = false;
    state.stats.ignoredLines++;
    return;
  }

  const openTurnNumber = state.openTurnNumber;
  state.openTurnNumber = undefined;
  const turn = state.activeTurn;
  const lifecycleMatches = !state.lifecycleInvalid
    && openTurnNumber !== undefined
    && (!turn || turn.turnNumber === openTurnNumber);
  state.lifecycleInvalid = false;
  const routedCompletion = lifecycleMatches
    ? completion
    : { ...completion, status: "unknown" as const };

  if (!turn) {
    state.stats.orphanCompletions++;
    const pendingTask = state.ownedNetworkTasks.length === 1
      ? state.ownedNetworkTasks[0]
      : undefined;
    const pendingOrigin = pendingTask && !state.expectedHumanTurn
      ? "network"
      : (!pendingTask && state.expectedHumanTurn ? "human" : undefined);
    if (openTurnNumber !== undefined && pendingOrigin) {
      state.pendingOrphanCompletion = routedCompletion;
      state.pendingOrphanTurnNumber = openTurnNumber;
      state.pendingOrphanOrigin = pendingOrigin;
      state.pendingOrphanNetworkTask = pendingOrigin === "network" && pendingTask
        ? { ...pendingTask }
        : undefined;
      if (pendingTask && routedCompletion.status === "completed") {
        events.push({
          kind: "completion_pending_reply",
          task: pendingTask,
          completion: routedCompletion,
        });
      }
    } else if (pendingTask) {
      // A terminal record without a preceding start cannot be attached to a
      // future chat row. Fail the sole owned task instead of hanging/replaying.
      state.ownedNetworkTasks.splice(0, 1);
      if (
        state.pendingOrphanOrigin === "network"
        && sameOwnedTask(state.pendingOrphanNetworkTask, pendingTask)
      ) {
        clearPendingOrphanCompletion(state);
      }
      state.expectedHumanTurn = false;
      events.push({
        kind: "turn_completed",
        origin: "network",
        status: "unknown",
        completion: routedCompletion,
        task: pendingTask,
      });
      return;
    } else if (state.pendingOrphanCompletion) {
      // A second terminal before the expected human user row makes the saved
      // epoch ambiguous. Release the trusted human boundary as failed and
      // never let the older completion survive to a later user.
      clearPendingOrphanCompletion(state);
      state.expectedHumanTurn = false;
      events.push({
        kind: "turn_completed",
        origin: "human",
        status: "unknown",
        completion: routedCompletion,
      });
      return;
    }
    events.push({
      kind: "turn_completed",
      origin: "orphan",
      status: routedCompletion.status,
      completion: routedCompletion,
    });
    return;
  }

  if (turn.origin === "human") {
    events.push({
      kind: "turn_completed",
      origin: "human",
      status: routedCompletion.status,
      completion: routedCompletion,
    });
    state.activeTurn = undefined;
    return;
  }

  const task = turn.networkTask;
  if (!task) {
    // A corrupted/restored state must fail closed, never infer routing.
    events.push({
      kind: "turn_completed",
      origin: "network",
      status: routedCompletion.status,
      completion: routedCompletion,
    });
    state.activeTurn = undefined;
    return;
  }

  if (routedCompletion.status !== "completed") {
    events.push({
      kind: "turn_completed",
      origin: "network",
      status: routedCompletion.status,
      completion: routedCompletion,
      task,
    });
    state.activeTurn = undefined;
    return;
  }

  // chat_history and events are distinct files. Even if an assistant is
  // already visible, a later final assistant may still be waiting on the chat
  // file's flush. Every successful completion goes through the runtime's
  // quiescence window before selecting the final candidate.
  turn.pendingCompletion = routedCompletion;
  events.push({ kind: "completion_pending_reply", task, completion: routedCompletion });
}

function selectFinalAssistant(turn: GrokActiveTurn): string | undefined {
  return turn.finalAssistantText;
}

function extractAssistantCandidate(
  record: JsonRecord,
): { text?: string; eligibleFinal: boolean } {
  const content = nonEmpty(extractText(record.content));
  // Verified 0.2.93 schema: every intermediate assistant carries a non-empty
  // flat tool_calls array; the final answer is the last assistant for which
  // tool_calls is absent or []. Unexpected shapes fail closed.
  const eligibleFinal = record.tool_calls === undefined
    || (Array.isArray(record.tool_calls) && record.tool_calls.length === 0);
  return { ...(content ? { text: content } : {}), eligibleFinal };
}

function parseTurnNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function sameOwnedTask(
  left: OwnedNetworkTask | undefined,
  right: OwnedNetworkTask | undefined,
): boolean {
  return !!left && !!right && left.from === right.from && left.taskId === right.taskId;
}

function clearPendingOrphanCompletion(state: GrokJsonlState): void {
  state.pendingOrphanCompletion = undefined;
  state.pendingOrphanTurnNumber = undefined;
  state.pendingOrphanOrigin = undefined;
  state.pendingOrphanNetworkTask = undefined;
}

function rememberCompletionCandidate(state: GrokJsonlState, signal: GrokCompletionSignal): void {
  state.completionCandidates.push(signal);
  if (state.completionCandidates.length > MAX_GROK_COMPLETION_CANDIDATES) {
    state.completionCandidates.splice(
      0,
      state.completionCandidates.length - MAX_GROK_COMPLETION_CANDIDATES,
    );
  }
}

function normalizeDiscriminator(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value;
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    const pieces = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => item !== undefined && item.length > 0);
    return pieces.length ? pieces.join("\n") : undefined;
  }
  const object = asRecord(value);
  if (!object) return undefined;
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  return extractText(object.content, depth + 1);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isSafeEnvelopePart(value: string): boolean {
  return value.length > 0
    && byteLength(value) <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.includes("]")
    && !value.includes("/");
}

function assertEnvelopePart(value: string, name: string): void {
  if (!isSafeEnvelopePart(value)) throw new Error(`invalid network ${name}`);
}

export interface PersistentTailCursor {
  version: 1;
  device: string;
  inode: string;
  offset: number;
}

export interface TailFileSnapshot {
  device: string | number | bigint;
  inode: string | number | bigint;
  size: number;
}

export type TailCursorReason = "continue" | "fresh" | "invalid";

export interface TailCursorPlan {
  cursor: PersistentTailCursor;
  readOffset: number;
  bytesAvailable: number;
  reason: TailCursorReason;
}

/**
 * Reconcile persisted identity/offset with a fresh stat snapshot. Grok session
 * JSONL is append-only: rotation/truncation is fatal and must never rewind to
 * byte zero. A fresh/invalid cursor defaults to EOF to avoid replaying old
 * human delegations.
 */
export function reconcileTailCursor(
  persisted: unknown,
  snapshot: TailFileSnapshot,
  options: { initialPosition?: "start" | "end" } = {},
): TailCursorPlan {
  const file = normalizeTailSnapshot(snapshot);
  const previous = parseTailCursor(persisted);
  let reason: TailCursorReason;
  let readOffset: number;

  if (!previous) {
    reason = persisted == null ? "fresh" : "invalid";
    readOffset = options.initialPosition === "start" ? 0 : file.size;
  } else if (previous.device !== file.device || previous.inode !== file.inode) {
    throw new Error("tail cursor file identity changed");
  } else if (previous.offset > file.size) {
    throw new Error("tail cursor file was truncated");
  } else {
    reason = "continue";
    readOffset = previous.offset;
  }

  return {
    cursor: {
      version: 1,
      device: file.device,
      inode: file.inode,
      offset: readOffset,
    },
    readOffset,
    bytesAvailable: file.size - readOffset,
    reason,
  };
}

/** Return a JSON-safe cursor after a successful read. */
export function advanceTailCursor(
  cursor: PersistentTailCursor,
  bytesRead: number,
): PersistentTailCursor {
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
    throw new Error("tail bytesRead must be a non-negative safe integer");
  }
  const offset = cursor.offset + bytesRead;
  if (!Number.isSafeInteger(offset)) throw new Error("tail cursor offset overflow");
  return { ...cursor, offset };
}

function normalizeTailSnapshot(snapshot: TailFileSnapshot): {
  device: string;
  inode: string;
  size: number;
} {
  const device = normalizeIdentity(snapshot.device, "device");
  const inode = normalizeIdentity(snapshot.inode, "inode");
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0) {
    throw new Error("tail file size must be a non-negative safe integer");
  }
  return { device, inode, size: snapshot.size };
}

function normalizeIdentity(value: string | number | bigint, name: string): string {
  const normalized = String(value);
  if (!normalized || normalized.length > 128) throw new Error(`invalid tail ${name}`);
  return normalized;
}

function parseTailCursor(value: unknown): PersistentTailCursor | undefined {
  const record = asRecord(value);
  if (
    !record
    || record.version !== 1
    || typeof record.device !== "string"
    || !record.device
    || typeof record.inode !== "string"
    || !record.inode
    || typeof record.offset !== "number"
    || !Number.isSafeInteger(record.offset)
    || record.offset < 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    device: record.device,
    inode: record.inode,
    offset: record.offset,
  };
}
