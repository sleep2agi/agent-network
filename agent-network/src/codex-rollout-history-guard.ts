// Board #734 — never let a codex older than 0.145 append to a "paginated" rollout.
//
// 🔴 This file has a byte-identical copy in agent-network/src/codex-rollout-history-guard.ts
//    (the two packages ship separately). codex-rollout-history-guard.test.ts in each
//    package asserts the copies are identical — edit both.
//
// codex >= 0.145 (upstream PR #32332) writes rollouts in "paginated" mode: the first
// line is the session meta with `payload.history_mode == "paginated"`, and every line
// carries an `ordinal`. A codex older than 0.145 does not know about ordinals; when it
// resumes such a thread it appends lines WITHOUT one. From then on codex >= 0.145
// refuses the thread for good:
//
//   final paginated rollout record at <path> is missing an ordinal
//
// So the safe order is: look before starting. We read ONLY the first line of the
// rollout (bounded — rollouts reach hundreds of MB), compare with the codex binary's
// version, and refuse to start the old binary on a paginated thread. Anything we
// cannot determine (file missing, first line unparsable, version unknown) does NOT
// block — the caller keeps its existing behavior and logs a warning.
//
// Nothing here ever writes to the rollout.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** First codex release that writes paginated rollouts with per-line ordinals. */
export const PAGINATED_ROLLOUT_MIN_CODEX = "0.145.0";
/** Read the first line in chunks of this size … */
export const FIRST_LINE_CHUNK_BYTES = 64 * 1024;
/** … and give up (do not block) when no newline shows up within this many bytes. */
export const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;
export const BOARD_REF = "board #734";

export interface FirstLineRead {
  /** The first line without its newline; null when it could not be read. */
  line: string | null;
  /** How many bytes were actually read from the file. */
  bytesRead: number;
  /** Why `line` is null. */
  reason?: string;
}

/** Bounded read of the first line. Never reads past `maxBytes`. */
export function readRolloutFirstLine(
  path: string,
  maxBytes: number = FIRST_LINE_MAX_BYTES,
  chunkBytes: number = FIRST_LINE_CHUNK_BYTES,
): FirstLineRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    return { line: null, bytesRead: 0, reason: `cannot open: ${(e as Error).message}` };
  }
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const want = Math.min(chunkBytes, maxBytes - bytesRead);
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, bytesRead);
      if (n <= 0) break;
      bytesRead += n;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        return { line: Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""), bytesRead };
      }
      chunks.push(buf.subarray(0, n));
    }
  } catch (e) {
    return { line: null, bytesRead, reason: `read failed: ${(e as Error).message}` };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  if (bytesRead >= maxBytes) return { line: null, bytesRead, reason: `no newline within the first ${maxBytes} bytes` };
  // EOF without newline: a one-line file is still a complete first line.
  if (bytesRead === 0) return { line: null, bytesRead, reason: "file is empty" };
  return { line: Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""), bytesRead };
}

export type HistoryModeParse =
  | { ok: true; historyMode: string | null }
  | { ok: false; reason: string };

/** `payload.history_mode` of the session-meta line; null when the field is absent (legacy rollout). */
export function parseRolloutHistoryMode(line: string): HistoryModeParse {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return { ok: false, reason: "first line is not JSON" };
  }
  if (!rec || typeof rec !== "object") return { ok: false, reason: "first line is not a JSON object" };
  const r = rec as { type?: unknown; payload?: { history_mode?: unknown } };
  if (r.type !== "session_meta") return { ok: false, reason: `first line is type=${JSON.stringify(r.type)}, not session_meta` };
  const hm = r.payload?.history_mode;
  if (hm === undefined || hm === null) return { ok: true, historyMode: null };
  if (typeof hm !== "string") return { ok: false, reason: "payload.history_mode is not a string" };
  return { ok: true, historyMode: hm };
}

function parseVersion(text: string | undefined | null): [number, number, number] | null {
  if (!text) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0, 0, >0 — numeric `x.y.z` compare; null when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Version from `codex --version` output. Only a codex-identifying token counts
 * (`codex-cli 0.159.2`, `codex 0.145.0`): a wrapper that prints its own version
 * first (`nvm 0.39.7`) must not be read as the codex version. No match = unknown.
 */
export function parseCodexVersionOutput(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = /\bcodex(?:-cli)?\s+v?(\d+\.\d+\.\d+)/i.exec(text);
  return m ? m[1] : null;
}

const versionCache = new Map<string, string | null>();

/** `<bin> --version` → `x.y.z`, cached per binary for the life of the process. */
export function probeCodexVersionCached(bin: string, timeoutMs = 5_000): string | null {
  if (versionCache.has(bin)) return versionCache.get(bin) ?? null;
  let version: string | null = null;
  try {
    // Windows npm installs `codex.cmd`, which spawnSync can only start through a shell.
    // The callers already reject cmd.exe metacharacters in the binary path there.
    const r = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (!r.error && r.status === 0) version = parseCodexVersionOutput(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    version = null;
  }
  versionCache.set(bin, version);
  return version;
}

const ROLLOUT_NAME_RE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl$/i;
const MAX_ROLLOUT_DEPTH = 6;

/** Newest `rollout-<ts>-<thread>[_<rollout-id>].jsonl` under `root` (recursive), by timestamp then rollout id. */
function newestRolloutUnder(root: string, threadId: string): string | null {
  const want = threadId.toLowerCase();
  let best: { key: string; path: string } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_ROLLOUT_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      const m = ROLLOUT_NAME_RE.exec(name);
      if (m) {
        if (m[2].toLowerCase() !== want) continue;
        try { if (!statSync(full).isFile()) continue; } catch { continue; }
        const key = `${m[1]} ${(m[3] ?? m[2]).toLowerCase()}`;
        if (!best || key > best.key) best = { key, path: full };
        continue;
      }
      try { if (statSync(full).isDirectory()) walk(full, depth + 1); } catch { /* ignore */ }
    }
  };
  walk(root, 0);
  return best ? (best as { path: string }).path : null;
}

/**
 * The rollout codex would resume for `threadId`, following codex's own filesystem
 * order (codex-rs thread-store thread_rollout_resolver): `sessions/` first, newest
 * matching file wins; `archived_sessions/` only when nothing is in `sessions/`.
 * (codex consults its SQLite index before the filesystem; that index is not read here.)
 * The ONE resolver every anet guard uses (co-presence launchers and agent-node).
 */
export function resolveCodexResumeRollout(codexHome: string, threadId: string): string | null {
  if (!threadId || /[\\/\0]/.test(threadId)) return null;
  return newestRolloutUnder(join(codexHome, "sessions"), threadId)
    ?? newestRolloutUnder(join(codexHome, "archived_sessions"), threadId);
}

export interface RolloutCompatInput {
  threadId: string;
  /** Exact rollout path, or null when the caller could not find one. */
  rolloutPath: string | null;
  /** How the operator would name the binary (path or command). */
  codexBin: string;
  /** Parsed version of `codexBin`; null/undefined = unknown. */
  codexVersion: string | null | undefined;
  /** How to point THIS node at another codex (one line per option). */
  pointAtNewerCodex: string[];
  /** Injected for tests; defaults to the bounded reader. */
  readFirstLine?: (path: string) => FirstLineRead;
}

export type RolloutCompatVerdict =
  | { verdict: "block"; lines: string[]; historyMode: string; codexVersion: string }
  | { verdict: "allow"; historyMode: string | null; codexVersion: string | null }
  | { verdict: "unknown"; lines: string[] };

/**
 * Decide whether starting `codexBin` on `threadId` is safe.
 * block   — paginated rollout + codex < 0.145: starting would make the thread unresumable.
 * allow   — legacy rollout, or codex new enough.
 * unknown — could not tell; caller must NOT block (warn and continue as before).
 */
export function checkRolloutCodexCompat(input: RolloutCompatInput): RolloutCompatVerdict {
  const tag = `[codex] ${BOARD_REF}:`;
  if (!input.rolloutPath) {
    return { verdict: "unknown", lines: [`${tag} rollout for thread ${input.threadId} not found; skipping the codex-version check (start continues).`] };
  }
  const read = (input.readFirstLine ?? ((p: string) => readRolloutFirstLine(p)))(input.rolloutPath);
  if (read.line === null) {
    return { verdict: "unknown", lines: [`${tag} cannot read the first line of ${input.rolloutPath} (${read.reason ?? "unknown"}); skipping the codex-version check (start continues).`] };
  }
  const parsed = parseRolloutHistoryMode(read.line);
  if (!parsed.ok) {
    return { verdict: "unknown", lines: [`${tag} ${parsed.reason} in ${input.rolloutPath}; skipping the codex-version check (start continues).`] };
  }
  if (parsed.historyMode !== "paginated") {
    // Legacy rollouts are readable by every codex; the version is not consulted (no probe).
    return { verdict: "allow", historyMode: parsed.historyMode, codexVersion: null };
  }
  const version = input.codexVersion ?? null;
  const cmp = version ? compareVersions(version, PAGINATED_ROLLOUT_MIN_CODEX) : null;
  if (cmp === null || version === null) {
    return { verdict: "unknown", lines: [`${tag} thread ${input.threadId} is a paginated rollout but the version of ${input.codexBin} is unknown; it must be >= ${PAGINATED_ROLLOUT_MIN_CODEX} (start continues).`] };
  }
  if (cmp >= 0) return { verdict: "allow", historyMode: parsed.historyMode, codexVersion: version };
  return {
    verdict: "block",
    historyMode: parsed.historyMode,
    codexVersion: version,
    lines: [
      `[codex] ❌ refusing to start codex ${version} (${input.codexBin}) on thread ${input.threadId} (${BOARD_REF}).`,
      `[codex]    The thread was written by codex >= ${PAGINATED_ROLLOUT_MIN_CODEX} ("paginated" history): ${input.rolloutPath}`,
      `[codex]    codex ${version} would append lines without an ordinal, and from then on every newer codex refuses`,
      `[codex]    the thread for good ("final paginated rollout record ... is missing an ordinal").`,
      `[codex]    Nothing was started and the rollout was not touched. Use codex >= ${PAGINATED_ROLLOUT_MIN_CODEX} for this node:`,
      ...input.pointAtNewerCodex.map((l) => `[codex]      ${l}`),
      `[codex]    Never mix codex versions on one thread. Details: ${BOARD_REF}.`,
    ],
  };
}

export const MISSING_ORDINAL_RE = /paginated rollout record at (.+?) is missing an ordinal/;

export function isMissingOrdinalError(text: string): boolean {
  return /is missing an ordinal/.test(text);
}

/** Explanation for the upstream "missing an ordinal" resume failure; [] when `text` is something else. */
export function describeMissingOrdinalFailure(text: string, ctx: { threadId?: string; rolloutPath?: string | null } = {}): string[] {
  if (!isMissingOrdinalError(text)) return [];
  const path = MISSING_ORDINAL_RE.exec(text)?.[1] ?? ctx.rolloutPath ?? "<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl";
  const q = `'${path.replace(/'/g, `'\\''`)}'`;
  return [
    `[codex] ❌ thread ${ctx.threadId ?? "?"} cannot be resumed: its rollout mixes codex versions (${BOARD_REF}).`,
    `[codex]    Cause: the thread was written by codex >= ${PAGINATED_ROLLOUT_MIN_CODEX} ("paginated" history, every line has an ordinal),`,
    `[codex]    then an older codex (< ${PAGINATED_ROLLOUT_MIN_CODEX}) appended lines without one. codex >= ${PAGINATED_ROLLOUT_MIN_CODEX} rejects that file.`,
    `[codex]    The original file is untouched: ${path}`,
    `[codex]    Safe options: wait for fork recovery (${BOARD_REF}), or — after a human decides the history may be left behind —`,
    `[codex]    start a fresh thread (anet node start <node> --new-session). Do not edit or delete the rollout.`,
    `[codex]    Read-only check: head -n 1 ${q} | grep -o '"history_mode":"[a-z]*"'; tail -n 1 ${q} | grep -c '"ordinal"'`,
    `[codex]      (paginated + last line count 0 = this failure)`,
  ];
}
