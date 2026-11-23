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

/**
 * 按 **agy 的真实回放模型** 剥离：回放 =「此前助手消息按原顺序拼接」。
 *
 * 2026-11-23 review（负责人）：原来的实现是「按长度排序、任意顺序、能剥就剥，剥完再看余下是否在历史里」，
 * 会误伤正常回答 —— 历史 ["长回复A","好"]、本轮回放全部再接新回答「好」⇒ 收到 "长回复A好好"，
 * 旧算法剥 A → "好好"，剥「好」→ "好"，余下「好」在历史里 ⇒ 判成「没有新内容」，把正常回合打成失败。
 * 现在：从最近 k 条（k 从全部往下试到 1）按**记录顺序**拼成前缀，取**最长命中**，每条只剥一次。
 * 余下非空 ⇒ 有新内容（哪怕它和某条历史一模一样）；余下为空 ⇒ 这一轮只有回放。
 */
export function agyStripReplayedPrefix(reply: string, sessionId: string | undefined): string {
  return stripOnce(reply, sessionId).text;
}

function stripOnce(reply: string, sessionId: string | undefined): { text: string; stripped: boolean; k: number } {
  if (!sessionId) return { text: reply, stripped: false, k: 0 };
  const prevs = repliesBySession.get(sessionId);
  if (!prevs?.length) return { text: reply, stripped: false, k: 0 };
  // k = 1..n：取最后 k 条按记录顺序拼接，从最长的开始试（n 往下到 1）
  for (let k = prevs.length; k >= 1; k--) {
    const prefix = prevs.slice(prevs.length - k).join("");
    if (!prefix) continue;
    if (reply.length >= prefix.length && reply.startsWith(prefix)) {
      return { text: reply.slice(prefix.length), stripped: true, k };
    }
  }
  return { text: reply, stripped: false, k: 0 };
}

/** 该会话是否**观察到过回放**（曾经剥出过非空余量）。用来消解「历史只有一条且本轮回复恰好相同」的歧义。 */
const sawReplayBySession = new Set<string>();

export function forgetAgyReplayEvidence(sessionId: string | undefined): void {
  if (sessionId) sawReplayBySession.delete(sessionId);
}

/**
 * 剥离结果：`replayOnly=true` 表示这一轮**只有历史回放、没有任何新内容**。
 * 调用方必须把它当失败（`agy_replay_only_no_new_content`），不能当回复发出去。
 *
 * 歧义处理（review 第 2 条）：历史 ["好"]、本轮收到恰好 "好" —— 可能是「只回放了上一条」，
 * 也可能是「没回放、正常重复回答」。两种读法都有代价，所以用**本会话是否见过回放**判定：
 * 见过（曾剥出非空余量）⇒ 按回放处理（判失败）；没见过 ⇒ 当正常回答（原样返回）。
 * 依据：agy 一旦开始回放，在这个会话里就是持续行为；从没见过回放的会话，直接误判会白白毁掉正常回合。
 */
export function agyStripReplay(reply: string, sessionId: string | undefined): { text: string; replayOnly: boolean } {
  const { text, stripped, k } = stripOnce(reply, sessionId);
  if (!stripped) return { text: reply, replayOnly: false };
  const newContent = text.trim();
  if (newContent) {
    if (sessionId) sawReplayBySession.add(sessionId);
    return { text, replayOnly: false };
  }
  // 剥完为空：
  //   k>=2（等于最近两条及以上按记录顺序拼接）⇒ 不可能是巧合的正常回答，**无条件**判回放。
  //     2026-11-23 review：通信鸽那种「历史 2 条、本轮恰好等于两条拼接」的形态必须先命中这条，
  //     否则进程刚重启（没有任何 sawReplay 证据）时旧话会被当正常回答发出去。
  //   k==1（恰好等于最后一条历史）⇒ 才存在歧义，看本会话是否见过回放。
  if (k >= 2) {
    if (sessionId) sawReplayBySession.add(sessionId);
    return { text: "", replayOnly: true };
  }
  if (sessionId && !sawReplayBySession.has(sessionId)) return { text: reply, replayOnly: false };
  return { text: "", replayOnly: true };
}

/**
 * 换新会话重做成功时，回复前面要带这句话（负责人 review 第 3 条）：
 * 否则用户看到的是一条普通回复，实际上下文已经被换掉了 —— 属于「悄悄丢上下文」。
 */
export const AGY_FRESH_SESSION_RETRY_NOTE =
  "（上个会话没有生成新内容，已换新会话重做，之前聊过的内容它可能不记得）";

/** 换会话重做后的回复：带人话前缀，正文原样。 */
export function withFreshSessionRetryNote(reply: string): string {
  return `${AGY_FRESH_SESSION_RETRY_NOTE}\n${reply}`;
}

/** 这一轮只有回放、没有新内容时抛这个（给用户看的是人话，错误码只进结构化字段/日志）。 */
export class AgyReplayOnlyError extends Error {
  readonly code = "agy_replay_only_no_new_content";
  constructor() {
    super("这次没有生成新内容，请重发一次；如果反复出现，换一个新会话");
    this.name = "AgyReplayOnlyError";
  }
}

/**
 * 2026-11-23 review B —— **重启后的种子**：`repliesBySession` 原本只在内存里，节点一重启就空，
 * 续同一个 agy 会话的第一轮既剥不掉回放、也识别不出纯回放（正好是我们验修复的方式）。
 * 续会话时 agy 在 `session/load` 阶段会把历史助手消息回放一遍（#3780 就是这段），
 * 用它给历史做种子：这是 **agy 自己认的历史**，比我们记的更准。
 * 种成一条（拼接文本）即可：下一轮回放 = 这条 + 新消息，按 k>=2 或 k=1 都能命中。
 * 同时记一条「这个会话会回放」的证据。
 */
export function seedAgyReplaysFromLoad(sessionId: string | undefined, replayText: string | undefined): void {
  if (!sessionId) return;
  const text = (replayText ?? "").trim();
  if (!text) return;
  const arr = repliesBySession.get(sessionId) ?? [];
  if (!arr.includes(text)) arr.unshift(text);
  while (arr.length > 20) arr.pop();
  repliesBySession.set(sessionId, arr);
  sawReplayBySession.add(sessionId);
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
  // 续会话时把 session/load 回放出来的历史种进本进程记忆（重启场景也能识别回放）。
  seedAgyReplaysFromLoad(sessionId, result.handshakeReplayText);
  const { text: cleaned, replayOnly } = agyStripReplay(result.replyText ?? "", sessionId);
  if (cleaned !== result.replyText) {
    opts.onStderr?.(`[antigravity] stripped replayed prefix (${(result.replyText ?? "").length - cleaned.length} chars) from session ${String(sessionId).slice(0, 8)}`);
  }
  if (replayOnly) {
    // 2026-11-23 —— 绝不能把旧回复当本轮结果发出去；判失败，让人重发/换会话。
    opts.onStderr?.(`[antigravity] replay-only turn (${(result.replyText ?? "").length} chars of history, no new content) in session ${String(sessionId).slice(0, 8)}`);
    throw new AgyReplayOnlyError();
  }
  rememberAgyReply(cleaned, sessionId);
  return { ...result, replyText: cleaned };
}
