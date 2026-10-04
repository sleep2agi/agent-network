/**
 * #528 — `anet node codex adopt <new-name> --thread <id|prefix> [--from-home <dir>]` 的纯逻辑。
 *
 * adopt = fork,但源不是 anet 节点,而是一个裸 CODEX_HOME(默认 ~/.codex)里的一个 thread:
 * 用户在 anet 之外开的 codex TUI 对话,收编成一个新的 codex 共存节点。
 *
 * 这里只做「找到那一个 rollout」:列出源 home 里的 thread(时间 / cwd / 首条提问 / 短 id)、
 * 按完整 id 或唯一前缀解析。复制与改写复用 codex-lifecycle-fork 的 rewriteRollout。
 * 全程只读源 home:只 readdir / lstat / 读文件头,不写、不改 mtime 之外的任何东西(读也不改 mtime)。
 */
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "fs";
import { join } from "path";

/** `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` → uuid。 */
const ROLLOUT_NAME_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const FULL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A prefix is hex digits and dashes. Shorter than this matches too much to be a deliberate choice. */
export const MIN_THREAD_PREFIX = 4;

export interface ExternalThread {
  readonly threadId: string;
  readonly path: string;
  readonly bytes: number;
  readonly inode: number | bigint;
  readonly mtimeMs: number;
  /** session_meta timestamp (falls back to the file's mtime when missing). */
  readonly startedAt: string;
  readonly cwd: string | null;
  readonly firstPrompt: string | null;
}

/** Read at most `max` bytes from the start of a file; returns only complete lines when truncated. */
function readHeadLines(path: string, max: number): string[] {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const lines = text.split("\n");
    if (n === max) lines.pop(); // last line may be cut
    return lines.filter((l) => l.length > 0);
  } finally {
    closeSync(fd);
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The first thing the human typed: event_msg user_message, else a user message item that is not injected context. */
export function firstPromptOf(lines: readonly string[]): string | null {
  let fallback: string | null = null;
  for (const line of lines) {
    if (!line.includes('"user')) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    const p = j?.payload ?? {};
    if (j?.type === "event_msg" && p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
      return oneLine(p.message);
    }
    if (fallback === null && j?.type === "response_item" && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      for (const c of p.content) {
        const t = typeof c?.text === "string" ? c.text.trim() : "";
        // codex injects <environment_context> / <user_instructions> as user items; those are not the prompt.
        if (t && !t.startsWith("<")) { fallback = oneLine(t); break; }
      }
    }
  }
  return fallback;
}

export function threadFactsOf(path: string, threadId: string, mtimeMs: number, headBytes = 1 << 20): { startedAt: string; cwd: string | null; firstPrompt: string | null } {
  let lines: string[] = [];
  try { lines = readHeadLines(path, headBytes); } catch { lines = []; }
  let startedAt: string | null = null, cwd: string | null = null;
  if (lines.length > 0) {
    try {
      const meta = JSON.parse(lines[0]);
      if (meta?.type === "session_meta") {
        const p = meta.payload ?? {};
        const id = p.session_id ?? p.id;
        if (typeof id === "string" && id.toLowerCase() === threadId.toLowerCase()) {
          startedAt = typeof p.timestamp === "string" ? p.timestamp : typeof meta.timestamp === "string" ? meta.timestamp : null;
          cwd = typeof p.cwd === "string" ? p.cwd : null;
        }
      }
    } catch { /* not a rollout header — listed with mtime only */ }
  }
  return { startedAt: startedAt ?? new Date(mtimeMs).toISOString(), cwd, firstPrompt: firstPromptOf(lines) };
}

/** Every rollout under `<codexHome>/sessions` (read-only), newest first. */
export function listExternalThreads(codexHome: string): ExternalThread[] {
  const root = join(codexHome, "sessions");
  const out: ExternalThread[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!st.isFile()) continue; // symlinks are not followed
      const m = ROLLOUT_NAME_RE.exec(name);
      if (!m) continue;
      const threadId = m[1].toLowerCase();
      out.push({ threadId, path: p, bytes: st.size, inode: st.ino, mtimeMs: st.mtimeMs, ...threadFactsOf(p, threadId, st.mtimeMs) });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

export type ThreadResolution =
  | { kind: "ok"; thread: ExternalThread }
  | { kind: "invalid"; reason: string }
  | { kind: "none" }
  /** The prefix names more than one thread. */
  | { kind: "ambiguous"; matches: readonly ExternalThread[] }
  /** One thread id, but more than one rollout file carries it — which one is the conversation is a guess. */
  | { kind: "duplicate"; matches: readonly ExternalThread[] };

export function resolveExternalThread(threads: readonly ExternalThread[], query: string): ThreadResolution {
  const q = query.trim().toLowerCase();
  if (!/^[0-9a-f-]+$/.test(q)) return { kind: "invalid", reason: `"${query}" is not a thread id (hex digits and dashes)` };
  if (!FULL_ID_RE.test(q) && q.replace(/-/g, "").length < MIN_THREAD_PREFIX) {
    return { kind: "invalid", reason: `"${query}" is too short — give at least ${MIN_THREAD_PREFIX} characters of the thread id` };
  }
  const matches = FULL_ID_RE.test(q) ? threads.filter((t) => t.threadId === q) : threads.filter((t) => t.threadId.startsWith(q));
  if (matches.length === 0) return { kind: "none" };
  const ids = new Set(matches.map((t) => t.threadId));
  if (ids.size > 1) return { kind: "ambiguous", matches };
  if (matches.length > 1) return { kind: "duplicate", matches };
  return { kind: "ok", thread: matches[0] };
}

/** Shortest prefix (≥ minLen) of each id that no other id in the list shares. */
export function shortIds(ids: readonly string[], minLen = 8): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let n = Math.min(minLen, id.length);
    while (n < id.length && ids.some((o) => o !== id && o.startsWith(id.slice(0, n)))) n += 1;
    out.set(id, id.slice(0, n));
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Numbered table for the picker / the non-TTY listing. Local time is not used: the stamp is the UTC one codex wrote. */
export function formatThreadList(threads: readonly ExternalThread[], limit = 20): string[] {
  const shown = threads.slice(0, limit);
  const short = shortIds([...new Set(threads.map((t) => t.threadId))]);
  const lines = shown.map((t, i) => {
    const when = t.startedAt.replace("T", " ").replace(/\.\d+Z$|Z$/, "Z").slice(0, 20);
    const prompt = t.firstPrompt ? JSON.stringify(truncate(t.firstPrompt, 60)) : "(no prompt yet)";
    return `  ${String(i + 1).padStart(2)}. ${when}  ${short.get(t.threadId)}  ${t.cwd ?? "(cwd unknown)"}  ${prompt}`;
  });
  if (threads.length > shown.length) lines.push(`  … ${threads.length - shown.length} older thread(s) not shown; pass --thread <id> for any of them`);
  return lines;
}
