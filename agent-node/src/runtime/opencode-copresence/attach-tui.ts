// #1957 — the human's `opencode attach` TUI outlives a config restart.
//
// The attach launcher (`opencode-attach.sh`) is regenerated per serve
// generation, but the process a human started from the previous generation's
// launcher keeps running against the killed serve: its window still shows
// the old session and the old model bar, and it is the "live descendant"
// that defers launch-root cleanup. This module gives the launcher a way to
// record *itself* (pid + start ticks + tmux pane) so the runtime can stop
// exactly that process on close and relaunch the new launcher in the same
// tmux pane once the next generation is ready.
//
// Identity, not pattern: the record is written by the launcher (`$$`) and
// verified against /proc start ticks before any signal is sent. Nothing here
// greps command lines — see the repo rule about `pgrep -f`/`pkill -f`
// matching unrelated shells.

import { execFileSync } from "child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readProcessGroupIdentity } from "./process-group";

export const ATTACH_GEN_ENV = "ANET_OPENCODE_ATTACH_GEN";
export const ATTACH_RECORD_FILE = "opencode-attach.json";
export const ATTACH_PREVIOUS_RECORD_FILE = "opencode-attach.prev.json";

export interface AttachRecord {
  pid: number;
  /** Linux /proc start ticks of the attach process (string, as process-group.ts keeps it); absent on other platforms. */
  startTicks?: string;
  /** `$TMUX_PANE` at launch, e.g. `%12`; empty when not inside tmux. */
  pane: string;
  /** The serve generation (session id) the launcher belonged to. */
  gen: string;
}

export function attachRecordPath(workDir: string): string {
  return join(workDir, ATTACH_RECORD_FILE);
}

export function previousAttachRecordPath(workDir: string): string {
  return join(workDir, ATTACH_PREVIOUS_RECORD_FILE);
}

/**
 * Shell lines the launcher runs *before* `exec`ing opencode, so the recorded
 * pid is the pid that becomes the attach TUI. Start ticks come from field 22
 * of /proc/self/stat, read after the closing paren so a comm containing
 * spaces cannot shift the field.
 */
export function renderAttachRecordShell(recordPath: string, gen: string): string[] {
  const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [
    `export ${ATTACH_GEN_ENV}=${q(gen)}`,
    `__anet_ticks=$( { cut -d')' -f2- /proc/$$/stat 2>/dev/null || true; } | awk '{print $20}' )`,
    `printf '{"pid":%d,"startTicks":%s,"pane":"%s","gen":"%s"}\\n' "$$" "\${__anet_ticks:-null}" "\${TMUX_PANE:-}" ${q(gen)} > ${q(recordPath)}.tmp-$$ && mv -f ${q(recordPath)}.tmp-$$ ${q(recordPath)}`,
  ];
}

export function readAttachRecord(path: string): AttachRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(raw?.pid) || raw.pid <= 1) return undefined;
    const startTicks = Number.isSafeInteger(raw.startTicks) ? String(raw.startTicks)
      : (typeof raw.startTicks === "string" && /^\d+$/.test(raw.startTicks) ? raw.startTicks : undefined);
    return {
      pid: raw.pid,
      startTicks,
      pane: typeof raw.pane === "string" ? raw.pane : "",
      gen: typeof raw.gen === "string" ? raw.gen : "",
    };
  } catch {
    return undefined;
  }
}

export type StopAttachOutcome =
  | { action: "signalled"; pid: number; pane: string }
  | { action: "gone"; pid: number; pane: string }
  | { action: "skipped"; pid?: number; pane: string; reason: string };

/**
 * Stop the attach TUI *this* runtime's launcher recorded. The record moves
 * to the `.prev` file so the next generation can relaunch into the same
 * tmux pane. A pid whose start ticks differ from the record is a reused pid
 * and is never signalled.
 */
export function stopRecordedAttach(
  workDir: string,
  opts: { signal?: NodeJS.Signals; log?: (m: string) => void; warn?: (m: string) => void; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): StopAttachOutcome {
  const recordPath = attachRecordPath(workDir);
  const record = readAttachRecord(recordPath);
  if (!record) {
    rmSync(recordPath, { force: true });
    return { action: "skipped", pane: "", reason: "no attach record (no human TUI was launched from this generation)" };
  }
  const prev = previousAttachRecordPath(workDir);
  try { renameSync(recordPath, prev); } catch { rmSync(recordPath, { force: true }); }
  const identity = readProcessGroupIdentity(record.pid);
  if (!identity) {
    opts.log?.(`[opencode-copresence] attach TUI pid ${record.pid} already gone`);
    return { action: "gone", pid: record.pid, pane: record.pane };
  }
  if (record.startTicks === undefined || identity.startTicks !== record.startTicks) {
    const reason = record.startTicks === undefined
      ? "record carries no start ticks (non-Linux launcher)"
      : `start ticks differ (record ${record.startTicks}, live ${identity.startTicks}); pid was reused`;
    opts.warn?.(`[opencode-copresence] not signalling attach TUI pid ${record.pid}: ${reason}`);
    return { action: "skipped", pid: record.pid, pane: record.pane, reason };
  }
  const signal = opts.signal ?? "SIGTERM";
  try {
    (opts.kill ?? ((pid, sig) => process.kill(pid, sig)))(record.pid, signal);
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
    return { action: "gone", pid: record.pid, pane: record.pane };
  }
  opts.log?.(`[opencode-copresence] stopped attach TUI pid ${record.pid} (${signal})${record.pane ? ` in tmux pane ${record.pane}` : ""}`);
  return { action: "signalled", pid: record.pid, pane: record.pane };
}

export type RelaunchAttachOutcome =
  | { action: "respawned"; pane: string }
  | { action: "manual"; reason: string };

/** Runs `tmux respawn-pane`; throws when tmux is missing or the pane is gone. */
export function defaultTmuxRespawn(pane: string, scriptPath: string): void {
  execFileSync("tmux", ["respawn-pane", "-k", "-t", pane, `bash ${shellQuote(scriptPath)}`], { stdio: "ignore", timeout: 5_000 });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * After the new generation is ready: if the previous generation's attach ran
 * inside a tmux pane, relaunch the regenerated launcher there; otherwise tell
 * the human what to run. Consumes the `.prev` record either way.
 */
export function relaunchPreviousAttach(
  workDir: string,
  scriptPath: string,
  opts: { log?: (m: string) => void; warn?: (m: string) => void; respawn?: (pane: string, scriptPath: string) => void } = {},
): RelaunchAttachOutcome | undefined {
  const prev = previousAttachRecordPath(workDir);
  const record = readAttachRecord(prev);
  rmSync(prev, { force: true });
  if (!record) return undefined;
  const hint = `previous attach TUI (pid ${record.pid}) stopped; relaunch: ${scriptPath}`;
  if (!record.pane) {
    opts.log?.(`[opencode-copresence] ${hint}`);
    return { action: "manual", reason: "previous attach was not inside a tmux pane" };
  }
  try {
    (opts.respawn ?? defaultTmuxRespawn)(record.pane, scriptPath);
  } catch (error: any) {
    const reason = `tmux respawn-pane ${record.pane} failed: ${error?.code === "ENOENT" ? "tmux not found" : (error?.message ?? error)}`;
    opts.warn?.(`[opencode-copresence] ${hint} (${reason})`);
    return { action: "manual", reason };
  }
  opts.log?.(`[opencode-copresence] relaunched attach TUI in tmux pane ${record.pane}: ${scriptPath}`);
  return { action: "respawned", pane: record.pane };
}
