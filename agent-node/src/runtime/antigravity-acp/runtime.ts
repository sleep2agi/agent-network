// Antigravity CLI（agy）的回合执行：复用 grok 的 ACP 回合实现，只换启动参数与模型策略。
//
// 为什么复用而不是复制：ACP 的 initialize / session/new|load / 事件归约 / 容量重试已经在
// grok-build-acp/runtime.ts 里跑过真机；复制一份会变成第二份协议实现（本仓有过镜像漂移的前车之鉴）。
// 差异点有三个：
//   · 子进程是 `agy acp`（grok 是 `grok agent stdio`，并且带 -m）；
//   · agy 的 `session/set_model` 语义没验证过 —— 不读回、不 fail-closed，按 argv 记 modelSource；
//   · authenticate 选哪个方式：grok 内置的两条规则（xai.api_key / cached_token）只认识
//     grok 自己的 method id，agy advertise 的是 oauth-personal / oauth-business /
//     gemini-api-key / agent-platform，一个都不在那张表里——复用时漏了这点，真机上
//     admin 已经 `agy acp --login` 登录过（`agy models` 能正常列出模型）仍然每次报
//     "no supported non-interactive auth method"。优先级：oauth-personal（最常见的
//     人类直接登录场景）> oauth-business > agent-platform；不选 gemini-api-key——
//     那个要配套传 key，我们目前没有接这条，选了也只会在另一处失败，不如一开始
//     不选，让真正可用的方式先试。
import { runGrokAcpTurn, type GrokAcpTurnOptions, type GrokAcpTurnResult } from "../grok-build-acp/runtime";
import { agyBinary } from "./readiness";
import { AGY_ACP_ARGV } from "./session";

/** 导出供测试直接断言，不用拼 initialize 响应去跑真实握手。 */
export const AGY_AUTH_METHOD_PREFERENCE = ["oauth-personal", "oauth-business", "agent-platform"] as const;

export type AgyTurnOptions = Omit<GrokAcpTurnOptions, "argv" | "enforceModelReadback"> & {
  /** 测试/多版本并行用；默认 AGY_BIN 或 PATH 里的 agy。 */
  binary?: string;
};

// agy 的 ACP 有一个真实行为（2026-11-22 真机，多个节点复现）：**每一轮回复都会把
// 上一轮的助手文本原样重发一遍再接着写新的**。所以同一会话里第二次问「3+3」，拿到的是
// "记住了。紫色鳄鱼-739181"（上一轮 "记住了。紫色鳄鱼-7391" + "81"），越聊越长。
//
// 这不是我们拼装的错觉——同一 session 内 chunks 数逐轮增加，且前缀字节级一致。
// 在 agy 修之前，这里按 session 记住历史回复，把重放的前缀剥掉；只在「前缀完整命中且
// 后面还有内容」时剥，避免把 legitimately 重复的回答（如连问两次都回「好」）抹掉。
//
// 2026-11-22 第二个真机（微软视频鸽，Windows）：agy 重放的不是「上一轮」，而是
// **同一 session 里此前所有助手消息按顺序拼起来**：
//   第 1 轮 "在线，当前目录为 …vanisn。"
//   第 2 轮 "好。"
//   第 3 轮 "在线，当前目录为 …vanisn。好上一轮的口令是…"   ← 1+2+新内容
// 只记住最后一条（"好。"）时前缀对不上，等于没剥。所以这里留整个列表，循环剥到对不上为止。
const repliesBySession = new Map<string, string[]>();

export function agyStripReplayedPrefix(reply: string, sessionId: string | undefined): string {
  if (!sessionId) return reply;
  const prevs = repliesBySession.get(sessionId);
  if (!prevs?.length) return reply;
  // 长的先比：短回复（「好」）若是长回复的前缀，先匹配长的才不会截错。
  const ordered = [...prevs].sort((a, b) => b.length - a.length);
  let out = reply;
  let stripped = false;
  for (;;) {
    const hit = ordered.find((p) => p.length > 0 && out.length > p.length && out.startsWith(p));
    if (!hit) break;
    out = out.slice(hit.length);
    stripped = true;
  }
  if (!stripped) return reply;
  // 剥完只剩历史内容（这一轮没有新东西）——宁可原样返回，也不要把旧回答当成新回答发出去。
  if (!out.trim() || ordered.includes(out.trim())) return reply;
  return out;
}

export function rememberAgyReply(reply: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  const text = reply.trim();
  if (!text) return;
  const arr = repliesBySession.get(sessionId) ?? [];
  arr.push(text);
  // 只留最近 20 条，节点长跑不要无界增长。
  if (arr.length > 20) arr.shift();
  repliesBySession.set(sessionId, arr);
  if (repliesBySession.size > 8) {
    const first = repliesBySession.keys().next().value;
    if (first) repliesBySession.delete(first);
  }
}

/** 会话被丢弃时一起清掉重放历史，避免新会话（同 id 极端情况）被旧前缀误伤。 */
export function forgetAgySession(sessionId: string | undefined): void {
  if (sessionId) repliesBySession.delete(sessionId);
}

export async function runAgyAcpTurn(opts: AgyTurnOptions): Promise<GrokAcpTurnResult> {
  const result = await runGrokAcpTurn({
    ...opts,
    // 报错/日志里的运行时名必须是 antigravity：共用 ACP 客户端但不能共用文案，
    // 否则 agy 节点报错会写 "grok ACP ... ~/.grok/sessions/"（真机踩过）。
    runtimeLabel: opts.runtimeLabel ?? "antigravity",
    binary: opts.binary ?? agyBinary(),
    argv: [...AGY_ACP_ARGV],
    // 2026-11-20：切模型是真的（负责人真机验证），但 agy 不发 model 事件，只能以
    // session/set_model 调用结果为准；不能再用「不读回、按 argv 记」那套。
    trustSetModelResult: true,
    // 真机实测（2026-11-20）：agy 的 ACP server 是 Go 写的，initialize 的
    // protocolVersion 字段类型是 int，Grok 默认发的字符串 "1" 在这里会被
    // Go 的 JSON 反序列化拒绝（-32602 unmarshal error）。agy 要数字。
    protocolVersion: 1,
    authMethodPreference: opts.authMethodPreference ?? AGY_AUTH_METHOD_PREFERENCE,
  });
  const sessionId = result.sessionId;
  const cleaned = agyStripReplayedPrefix(result.replyText ?? "", sessionId);
  if (cleaned !== result.replyText) {
    opts.onStderr?.(`[antigravity] stripped replayed prefix (${(result.replyText ?? "").length - cleaned.length} chars) from session ${String(sessionId).slice(0, 8)}`);
  }
  rememberAgyReply(cleaned, sessionId);
  return { ...result, replyText: cleaned };
}
