// reply-2000 —— 回执正文上限。
//
// 现场（chuqi 2026-11-11）：客户端看到的回复**末尾被截断**。根因不在 Hub、不在客户端，
// 而是节点自己把正文砍在 2000 字（agent-node/src/cli.ts 里四处 `.slice(0, 2000)`）。
// 现在与 Hub 的 send_reply 上限对齐（100_000），且**超出时留下可读标记** —— 静默切掉半句话
// 才是这条反馈里真正让人困惑的部分。
export const REPLY_TEXT_MAX = (() => {
  const raw = Number(process.env.ANET_REPLY_TEXT_MAX);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 100_000;
})();

export function capReplyText(text: string | null | undefined): string {
  const s = typeof text === "string" ? text : "";
  if (s.length <= REPLY_TEXT_MAX) return s;
  return `${s.slice(0, REPLY_TEXT_MAX)}\n\n…（正文共 ${s.length} 字，已截断到 ${REPLY_TEXT_MAX}；完整内容见该节点日志）`;
}
