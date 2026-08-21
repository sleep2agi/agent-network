// Pure: one inbound inbox row → the meta Claude Code renders as `<channel …>`
// attributes. Split out of node-server.ts because importing that module boots
// an SSE listener and registers against the live Hub — a test that reaches for
// this function must not do that.
/** One inbound inbox row → the meta Claude Code renders as `<channel …>` attrs.
 *
 * Pure so the attribute set is assertable; it used to be inline in the SSE
 * handler, where nothing could see it. */
export function inboundChannelMeta(msg: {
  id: string;
  from_session?: string | null;
  priority?: string | null;
  created_at?: string | null;
}): Record<string, string> {
  return {
    sender: msg.from_session || "hub",
    sender_id: "commhub",
    user: msg.from_session || "hub", // Claude Code 用 meta.user 显示 "commhub · {user}"
    // NOTE: this carries the inbox ROW id (get_inbox's `id`), not the logical
    // `tasks.task_id` the name suggests. That distinction is the only thing
    // separating a Hub re-queue from a node re-read: retry_task inserts a NEW
    // inbox row (fresh uuid) carrying the SAME logical task_id, so this value
    // CHANGES on a Hub re-queue and stays identical when the node re-fetches
    // one still-unacked row. Renaming would break send_reply routing
    // (taskOriginators and ack_inbox are both keyed on msg.id) — document it.
    task_id: msg.id,
    priority: msg.priority || "normal",
    // Hub already returns created_at from get_inbox; it was fetched and then
    // dropped here. Without it a 30-hour-old unacked row and a message sent one
    // second ago read identically on arrival, so a delayed re-read is invisible
    // from the receiving side. The telegram channel on this same surface has
    // carried `ts` all along.
    ts: String(msg.created_at ?? ""),
  };
}
