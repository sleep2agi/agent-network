// The words of the "nobody answered" notice. No database here: pure text, testable on its own.

/** "62" → "1 小时"; "25" → "25 分钟". For people, not for logs. */
function waitedFor(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest >= 10 && hours < 24 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/**
 * Two readers, two texts.
 *
 * An agent that dispatched the task needs the task id, the status words and what to do with them.
 * A person who sent a chat message needs none of that: they do not know what `acked` or
 * `cancel_task` is, and an id is noise (admin 2026-11-23, on seeing the agent text in their chat:
 * "这个是给人看的还是给谁看的？"). For a person it is one sentence about their own message.
 */
export function orphanNoticeText(
  r: { task_id: string; to_name: string; status: string; content: string | null; node_status: string },
  openMin: number | null,
  audience: "agent" | "user" = "agent",
): { title: string; text: string } {
  const preview = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (audience === "user") {
    const quoted = preview ? `：「${preview}${(r.content ?? "").trim().length > 60 ? "…" : ""}」` : "";
    const waited = openMin === null ? "" : ` ${waitedFor(openMin)}前`;
    return {
      title: "还没收到回复",
      text: `${r.to_name} 还没有回复你${waited}的消息${quoted}。可以再发一句催一下。`,
    };
  }
  const m = openMin === null ? "?" : String(openMin);
  return {
    title: "任务可能没人收尾",
    text: `[Hub] 任务可能没人收尾:你派给 ${r.to_name} 的任务 ${r.task_id} 停在 ${r.status} 已 ${m} 分钟,但 ${r.to_name} 之后已回到 ${r.node_status},一直没有回复。`
      + `Hub 没有改这条任务的状态。\n内容:${preview}\n`
      + `建议:问 ${r.to_name} 一句,或 cancel_task 后换个节点重派。\n`
      + `Task ${r.task_id} to ${r.to_name} has been ${r.status} for ${m} min while ${r.to_name} went ${r.node_status} without replying. Its status was not changed.`,
  };
}
