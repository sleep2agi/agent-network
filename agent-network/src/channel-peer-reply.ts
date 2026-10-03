// #519 / RFC-030 — commhub_send_peer_reply for the Claude Code channel.
//
// The channel acks a task as soon as it injects it. The task only becomes
// terminal when the model later sends a terminal reply with that exact id.
// For agent peers the house rule used to be two calls (send_task to wake,
// commhub_reply to close) and models routinely skipped the second one, so
// the original stayed `acked` forever (~92% of the never-closed rows).
//
// This tool does both in one call:
//   1. Hub `send_peer_reply` (atomic: terminalizes the original and enqueues
//      one no-response result that a capable peer wakes on).
//   2. If the Hub reports the capability is unavailable for this pair
//      (recipient not peer_reply_inbox_capable, unbound token, old Hub without
//      the tool, …) the Hub has written nothing. Then:
//        - origin is not a node (Dashboard/human)  → terminal send_reply only;
//        - otherwise → send_task to wake the peer, THEN terminal send_reply on
//          the original. If the wake fails nothing is closed; if the close fails
//          after the wake, the result says so explicitly.
//   Any other rejection (task terminal / not found / not owned / target
//   mismatch / transport) is returned as-is with no further writes.
//
// Pure (deps injected) so it is testable without importing node-server.ts,
// which connects a stdio transport and an SSE listener at module load.

export const PEER_REPLY_TOOL_NAME = "commhub_send_peer_reply";

export interface ChannelPeerReplyInput {
  task_id?: unknown;
  text?: unknown;
  status?: unknown;
  alias?: unknown;
}

export interface ChannelPeerReplyDeps {
  /** One Hub MCP tool call. Returns the parsed tool payload (ok:false on rejection); may throw on transport failure. */
  call: (tool: string, args: Record<string, unknown>) => Promise<any>;
  fromAlias: string;
  /** Sender alias the channel recorded when it injected this task_id (in-memory; may be unknown after a restart). */
  originatorOf?: (taskId: string) => string | undefined;
  /** channel meta task_id is the inbox ROW id; map it to the logical tasks.task_id when known. */
  logicalTaskIdOf?: (taskId: string) => string | undefined;
}

export type ChannelPeerReplyRoute = "atomic" | "wake-then-close" | "reply-only";

export interface ChannelPeerReplyResult {
  ok: boolean;
  route?: ChannelPeerReplyRoute;
  /** The original task is now terminal. */
  closed: boolean;
  /** A wake was delivered to the peer (atomic result row or fallback send_task). */
  woke: boolean;
  task_id?: string;
  error?: string;
  message?: string;
  wake_task_id?: string | null;
  fallback_reason?: string;
  upstream?: unknown;
}

const MAX_ID = 200;
const MAX_TEXT = 10_000;

function errorCodeOf(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  return typeof payload.error === "string" ? payload.error : "";
}

function failed(payload: any): boolean {
  return !payload || typeof payload !== "object" || payload.ok === false || (typeof payload.error === "string" && payload.error !== "");
}

/** Old Hub: the MCP server does not know the tool. The SDK surfaces it as an
 *  isError text or a JSON-RPC error envelope, both mentioning the tool name. */
function isUnknownTool(code: string): boolean {
  return /send_peer_reply/.test(code) && /(?:not found|unknown|does not exist|-32601)/i.test(code);
}

/** The Hub rejected the ATOMIC route for a capability reason and wrote nothing. */
export function peerReplyFallbackReason(payload: any): string | null {
  const code = errorCodeOf(payload);
  if (code === "peer_reply_origin_not_node") return code;
  if (code === "peer_reply_unsupported") return code;
  if (code === "peer_reply_node_token_required") return code;
  // Matches agent-node's classification: a bound node id that differs from the
  // task's to_node_id (node-id rotation) is re-checked by alias on send_reply.
  if (code === "reply_task_not_owned") return code;
  if (isUnknownTool(code)) return "hub_without_send_peer_reply";
  return null;
}

function reject(error: string, message: string, extra: Partial<ChannelPeerReplyResult> = {}): ChannelPeerReplyResult {
  return { ok: false, closed: false, woke: false, error, message, ...extra };
}

export function validatePeerReplyInput(input: ChannelPeerReplyInput):
  | { ok: true; taskId: string; text: string; status: "completed" | "failed"; alias?: string }
  | ChannelPeerReplyResult {
  const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
  if (!taskId) return reject("task_id_required", "task_id is required: pass the task_id attribute of the <channel> message you are answering");
  if (taskId.length > MAX_ID || /\s/.test(taskId)) return reject("task_id_invalid", "task_id must be the single id from the <channel> message");
  if (taskId === "hub") return reject("task_id_invalid", "task_id 'hub' is not a task; use commhub_send_task for a new message");
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) return reject("text_required", "text is required");
  if (text.length > MAX_TEXT) return reject("text_too_long", `text exceeds ${MAX_TEXT} characters`);
  const rawStatus = input.status ?? "completed";
  if (rawStatus !== "completed" && rawStatus !== "failed") {
    return reject("status_invalid", "status must be 'completed' or 'failed' (this tool always closes the task)");
  }
  const alias = typeof input.alias === "string" && input.alias.trim() ? input.alias.trim() : undefined;
  if (alias && alias.length > MAX_ID) return reject("alias_invalid", "alias too long");
  return { ok: true, taskId, text, status: rawStatus, ...(alias ? { alias } : {}) };
}

export async function sendChannelPeerReply(
  input: ChannelPeerReplyInput,
  deps: ChannelPeerReplyDeps,
): Promise<ChannelPeerReplyResult> {
  const v = validatePeerReplyInput(input);
  if (!("taskId" in v)) return v;
  const taskId = deps.logicalTaskIdOf?.(v.taskId) || v.taskId;
  const target = v.alias || deps.originatorOf?.(v.taskId) || undefined;
  const replyStatus = v.status === "completed" ? "replied" : "failed";
  const replyArgs = {
    ...(target ? { alias: target } : {}),
    text: v.text,
    in_reply_to: taskId,
    status: replyStatus,
    from_session: deps.fromAlias,
  };

  let atomic: any;
  try {
    atomic = await deps.call("send_peer_reply", replyArgs);
  } catch (error) {
    // Ambiguous: the Hub may or may not have applied it. Do NOT fall back
    // (that could wake the peer twice). A retry is safe: an applied reply
    // makes the retry return reply_task_terminal with zero writes.
    return reject("transport_error", `Hub unreachable during send_peer_reply; state unknown. Retry this same call — if it then says reply_task_terminal, the first attempt already closed it. (${error instanceof Error ? error.message : String(error)})`, { task_id: taskId });
  }
  if (!failed(atomic)) {
    return { ok: true, route: "atomic", closed: true, woke: true, task_id: taskId, upstream: atomic };
  }

  const reason = peerReplyFallbackReason(atomic);
  if (!reason) {
    // reply_task_terminal / reply_task_not_found / reply_target_mismatch / … :
    // the Hub wrote nothing; there is nothing safe to retry automatically.
    return reject(errorCodeOf(atomic) || "peer_reply_rejected", String(atomic?.message || atomic?.error || "Hub rejected the reply"), { task_id: taskId, upstream: atomic });
  }

  if (reason === "peer_reply_origin_not_node") {
    // Dashboard/human origin: the terminal reply IS the delivery (new_reply).
    const closed = await safeCall(deps, "send_reply", replyArgs);
    if (failed(closed.payload)) {
      return reject(closed.code, `Could not close the task: ${closed.message}`, { task_id: taskId, route: "reply-only", fallback_reason: reason, upstream: closed.payload });
    }
    return { ok: true, route: "reply-only", closed: true, woke: true, task_id: taskId, fallback_reason: reason, upstream: closed.payload };
  }

  if (!target) {
    return reject("peer_alias_unknown", "The Hub cannot deliver this atomically and this channel no longer knows who sent the task (restarted?). Call again with alias=<the sender attribute of the <channel> message>. Nothing was sent.", { task_id: taskId, fallback_reason: reason });
  }

  // 1. Wake first. If it fails, do not close: a closed task the peer never
  //    hears about is worse than an open one the model can retry.
  const wake = await safeCall(deps, "send_task", { alias: target, task: v.text, priority: "normal", from_session: deps.fromAlias });
  if (failed(wake.payload)) {
    return reject(wake.code, `Could not wake ${target}: ${wake.message}. Nothing was closed; the original task is still open.`, { task_id: taskId, route: "wake-then-close", fallback_reason: reason, upstream: wake.payload });
  }
  const wakeTaskId = wake.payload?.task_id ?? wake.payload?.message_id ?? null;

  // 2. Close the original.
  const close = await safeCall(deps, "send_reply", replyArgs);
  if (failed(close.payload)) {
    return {
      ok: false,
      route: "wake-then-close",
      closed: false,
      woke: true,
      task_id: taskId,
      wake_task_id: wakeTaskId,
      fallback_reason: reason,
      error: `close_failed_after_wake:${close.code}`,
      message: `${target} WAS woken (task ${wakeTaskId ?? "?"}), but the original task ${taskId} ${close.code === "transport_error" ? "may not be closed (Hub unreachable)" : "was NOT closed"}: ${close.message}. Do not resend the reply; close it with commhub_reply(task_id="${v.taskId}", status="${v.status}") (reply_task_terminal there means it is already closed).`,
      upstream: close.payload,
    };
  }
  return { ok: true, route: "wake-then-close", closed: true, woke: true, task_id: taskId, wake_task_id: wakeTaskId, fallback_reason: reason, upstream: close.payload };
}

async function safeCall(deps: ChannelPeerReplyDeps, tool: string, args: Record<string, unknown>): Promise<{ payload: any; code: string; message: string }> {
  try {
    const payload = await deps.call(tool, args);
    return { payload, code: errorCodeOf(payload) || `${tool}_failed`, message: String(payload?.message || payload?.error || `${tool} failed`) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { payload: { ok: false, error: "transport_error", message }, code: "transport_error", message };
  }
}
