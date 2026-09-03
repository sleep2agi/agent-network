// #1645 第 3 项 —— codex-sdk resume 一条已经很大的线程(实例:last_api_response_total_tokens=195436)
// 时,上游 pre-sampling compaction 会失败,turn 走不下去,最后以 300s 超时收场。
// 线程有多大在 resume 之前就写在 codex 自己的 rollout 文件里:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl
//   最后一条 {"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":N},"model_context_window":W}}}
// 这里只读那一条,超过阈值就在 resume 前警告;只警告、不拦、任何读不到都沉默。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(homedir(), ".codex");
  return join(home, "sessions");
}

/** 在 sessions/ 下找 `rollout-*-<threadId>.jsonl`(按 年/月/日 三层目录走,不递归到别处)。 */
export function findCodexRolloutFile(sessionsRoot: string, threadId: string): string | null {
  if (!threadId || /[\\/\0]/.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`;
  let dirs: string[];
  try {
    dirs = [sessionsRoot];
    for (let depth = 0; depth < 3; depth++) {
      const next: string[] = [];
      for (const dir of dirs) {
        let entries: string[] = [];
        try { entries = readdirSync(dir); } catch { continue; }
        for (const entry of entries) {
          const full = join(dir, entry);
          try {
            if (statSync(full).isDirectory()) next.push(full);
          } catch { /* ignore */ }
        }
      }
      dirs = next;
    }
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    const hit = entries.find((name) => name.startsWith("rollout-") && name.endsWith(suffix));
    if (hit) return join(dir, hit);
  }
  return null;
}

export interface CodexThreadSize {
  lastTurnTokens: number | null;
  contextWindow: number | null;
  fileBytes: number;
}

/** 读最后一条 token_count;文件太大时只读尾部 256 KB(那条记录总在最后几行)。 */
export function readCodexThreadSize(path: string): CodexThreadSize | null {
  let bytes: number;
  let text: string;
  try {
    bytes = statSync(path).size;
    const buf = readFileSync(path);
    const tail = buf.length > 256 * 1024 ? buf.subarray(buf.length - 256 * 1024) : buf;
    text = tail.toString("utf8");
  } catch {
    return null;
  }
  let lastTurnTokens: number | null = null;
  let contextWindow: number | null = null;
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"token_count"')) continue;
    try {
      const rec = JSON.parse(line) as { payload?: { type?: string; info?: { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } } };
      if (rec.payload?.type !== "token_count") continue;
      const t = rec.payload.info?.last_token_usage?.total_tokens;
      const w = rec.payload.info?.model_context_window;
      lastTurnTokens = typeof t === "number" && Number.isFinite(t) ? t : null;
      contextWindow = typeof w === "number" && Number.isFinite(w) ? w : null;
      break;
    } catch {
      continue;
    }
  }
  return { lastTurnTokens, contextWindow, fileBytes: bytes };
}

/** issue 里失败的那一轮是 195436 tokens;阈值取 150k,或上下文窗口的 60%(取小)。 */
export const CODEX_LARGE_THREAD_TOKENS = 150_000;

export function describeLargeCodexThread(
  threadId: string,
  size: CodexThreadSize | null,
  path: string | null,
  thresholdTokens: number = CODEX_LARGE_THREAD_TOKENS,
): string[] {
  if (!size || size.lastTurnTokens === null) return [];
  const windowLimit = size.contextWindow ? Math.floor(size.contextWindow * 0.6) : Number.POSITIVE_INFINITY;
  const limit = Math.min(thresholdTokens, windowLimit);
  if (size.lastTurnTokens < limit) return [];
  const windowText = size.contextWindow ? `,模型上下文窗口 ${size.contextWindow}` : "";
  return [
    `[codex] 即将 resume 的线程 ${threadId} 上一轮已用 ${size.lastTurnTokens} tokens${windowText}(rollout ${Math.round(size.fileBytes / 1024)} KB)。`,
    `[codex] 这么大的线程 resume 时上游 pre-sampling compaction 常失败,表现为 300s 超时(#1645)。宁可 --new-session 起新线程;文件: ${path ?? "?"}`,
  ];
}

/** 一步到位:定位文件 → 读大小 → 生成警告。任何一步拿不到都返回 []。 */
export function describeLargeCodexThreadBeforeResume(threadId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = findCodexRolloutFile(codexSessionsRoot(env), threadId);
  if (!path) return [];
  return describeLargeCodexThread(threadId, readCodexThreadSize(path), path);
}
