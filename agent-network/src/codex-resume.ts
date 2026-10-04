/**
 * #536 — `anet resume <alias>` for codex nodes (codex-sdk and codex co-presence),
 * plus a thread picker over the node's own CODEX_HOME.
 *
 * The owner asked: "能用 anet cli Resume 吗？" — and the audit (#531 items 4, 5, 10)
 * found three ways a resume went wrong without saying so:
 *   - a stale / foreign / mistyped thread id was saved as-is; codex then failed
 *     with "no rollout found" and agent-node quietly started a FRESH thread;
 *   - a co-presence node got `session` written instead of `codexThreadId` and
 *     its bridge ran against a dead app-server;
 *   - nothing listed the thread ids, so nobody could pick one.
 *
 * The rule here: a resume either continues the thread that exists in THIS node's
 * CODEX_HOME, or refuses with one line that says what to do. It never falls
 * through to "start a fresh conversation" — that is `anet node start`, typed on
 * purpose.
 *
 * Pure: the CLI gathers facts (rows from codex-menu's collectCodexRows, the
 * rollout listing from codex-adopt's listExternalThreads) and acts on the
 * decision. Nothing here reads a token: login is "auth.json has tokens/api key".
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ExternalThread, listExternalThreads, resolveExternalThread, shortIds } from "./codex-adopt";
import { type CollectEnv, type CodexMenuNode, collectCodexRows, displayQuote } from "./codex-menu";
import { effectiveCodexHome } from "./codex-node-login";

export type CodexResumeKind = "co-presence" | "codex-sdk";

export interface CodexResumeFacts {
  readonly alias: string;
  readonly kind: CodexResumeKind;
  /** "running" | "stopped" | "partial 1/3" (codex-menu's row.state). */
  readonly state: string;
  readonly running: boolean;
  /** The CODEX_HOME the node's codex runs with (its own, or the host ~/.codex for a codex-sdk node). */
  readonly codexHome: string;
  readonly homeExists: boolean;
  /** true = codex's default ~/.codex (no CODEX_HOME needed to log it in). */
  readonly homeIsHost: boolean;
  readonly loggedIn: boolean;
  /** codexThreadId (co-presence) / session (codex-sdk) from the node config. */
  readonly recordedThread: string | null;
  /** Every rollout under `<codexHome>/sessions`, newest first. */
  readonly threads: readonly ExternalThread[];
}

export interface CodexResumeRequest {
  /** --thread <id|unique prefix> (also --session <id>, the old spelling). */
  readonly thread?: string | null;
  readonly pick?: boolean;
  /** stdin and stdout are both a terminal. */
  readonly tty: boolean;
}

export type CodexResumeDecision =
  /** Nothing was done. `lines[0]` is the reason with the fix; exit with `code`. */
  | { readonly kind: "refuse"; readonly code: number; readonly lines: readonly string[] }
  /** --pick without a terminal: the list plus a copy-paste command. Nothing was done. */
  | { readonly kind: "list"; readonly code: number; readonly lines: readonly string[] }
  /** --pick in a terminal: show `lines`, ask for a number in 1..`choices.length`. */
  | { readonly kind: "ask"; readonly lines: readonly string[]; readonly choices: readonly string[] }
  /** Already running on exactly that thread — attach instead (exit 0). */
  | { readonly kind: "already"; readonly lines: readonly string[] }
  /** Go: record `threadId` (when `changed`) and start the node. */
  | { readonly kind: "resume"; readonly threadId: string; readonly changed: boolean; readonly rolloutPath: string };

/** How many threads the picker numbers; older ones are reachable with --thread. */
export const PICK_LIMIT = 20;

const q = displayQuote;

export function freshStartCommand(f: Pick<CodexResumeFacts, "alias" | "kind">): string {
  return f.kind === "co-presence" ? `anet node codex start ${q(f.alias)}` : `anet node start ${q(f.alias)}`;
}

export function codexLoginCommand(f: Pick<CodexResumeFacts, "codexHome" | "homeIsHost">): string {
  return f.homeIsHost ? "codex login --device-auth" : `CODEX_HOME=${q(f.codexHome)} codex login --device-auth`;
}

function stamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "Z").slice(0, 20);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Numbered rows: time (UTC, as codex wrote it), short id, first user line. The recorded thread is marked. */
export function formatNodeThreadList(threads: readonly ExternalThread[], recorded: string | null, limit = PICK_LIMIT): string[] {
  const shown = threads.slice(0, limit);
  const short = shortIds([...new Set(threads.map((t) => t.threadId))]);
  const rec = recorded?.toLowerCase() ?? null;
  const lines = shown.map((t, i) => {
    const prompt = t.firstPrompt ? JSON.stringify(truncate(t.firstPrompt, 60)) : "(no prompt yet)";
    const mark = t.threadId === rec ? "  ← recorded (what plain `anet resume` continues)" : "";
    return `  ${String(i + 1).padStart(2)}. ${stamp(t.startedAt)}  ${short.get(t.threadId)}  ${prompt}${mark}`;
  });
  if (threads.length > shown.length) lines.push(`  … ${threads.length - shown.length} older thread(s) not shown; pass --thread <id> for any of them`);
  return lines;
}

export function resumeCommandFor(alias: string, threadId: string): string {
  return `anet resume ${q(alias)} --thread ${threadId}`;
}

/** The whole decision. Order: request shape → home → which thread → login → process state. */
export function decideCodexResume(f: CodexResumeFacts, req: CodexResumeRequest): CodexResumeDecision {
  const a = q(f.alias);
  const refuse = (code: number, ...lines: string[]): CodexResumeDecision => ({ kind: "refuse", code, lines });
  const requested = typeof req.thread === "string" && req.thread.trim() && req.thread !== "true" ? req.thread.trim() : null;

  if (req.thread === "true") return refuse(2, `--thread needs a thread id: anet resume ${a} --thread <id>  (list them: anet resume ${a} --pick)`);
  if (requested && req.pick) return refuse(2, `--thread and --pick contradict each other — give one: anet resume ${a} --pick`);

  if (!f.homeExists) {
    return refuse(2,
      `${f.alias}'s CODEX_HOME ${f.codexHome} does not exist — no conversation to resume here (wrong directory, or the node was moved?).`,
      `  start a fresh conversation instead: ${freshStartCommand(f)}`);
  }

  if (req.pick) {
    if (f.threads.length === 0) {
      return refuse(2, `no codex conversations under ${f.codexHome}/sessions — nothing to pick. Start one: ${freshStartCommand(f)}`);
    }
    const list = formatNodeThreadList(f.threads, f.recordedThread);
    const head = `Conversations of ${f.alias} in ${f.codexHome} (newest first):`;
    if (!req.tty) {
      return {
        kind: "list",
        code: 2,
        lines: [
          head,
          ...list,
          `Nothing was resumed (no terminal to ask in). Copy one, e.g. the newest:`,
          `  ${resumeCommandFor(f.alias, f.threads[0].threadId)}`,
          `  (any id or unique prefix from the list works after --thread)`,
        ],
      };
    }
    return { kind: "ask", lines: [head, ...list], choices: f.threads.slice(0, PICK_LIMIT).map((t) => t.threadId) };
  }

  const target = requested ?? f.recordedThread;
  if (!target) {
    return refuse(2,
      `${f.alias} has no recorded codex thread — nothing to resume. Pick one: anet resume ${a} --pick`,
      `  or start a fresh conversation on purpose: ${freshStartCommand(f)}`);
  }
  const res = resolveExternalThread(f.threads, target);
  if (res.kind === "invalid") return refuse(2, `${res.reason}. List the threads: anet resume ${a} --pick`);
  if (res.kind === "none") {
    if (requested) {
      return refuse(2, `thread ${target} is not in ${f.alias}'s CODEX_HOME (${f.codexHome}) — list what is there: anet resume ${a} --pick`);
    }
    return refuse(2,
      `${f.alias}'s recorded thread ${target} has no rollout under ${f.codexHome}/sessions (moved or deleted?) — refusing to start a fresh thread in its place.`,
      `  pick another: anet resume ${a} --pick   ·   start fresh on purpose: ${freshStartCommand(f)}`);
  }
  if (res.kind === "ambiguous") {
    return refuse(2, `"${target}" matches ${new Set(res.matches.map((t) => t.threadId)).size} threads — give more of the id: anet resume ${a} --pick`);
  }
  if (res.kind === "duplicate") {
    return refuse(2, `thread ${res.matches[0].threadId} has ${res.matches.length} rollout files in ${f.codexHome} — need exactly one; refusing: ${res.matches.map((t) => t.path).join(", ")}`);
  }
  const thread = res.thread;

  if (!f.loggedIn) {
    return refuse(1, `${f.alias} has no codex login in ${f.codexHome} — the thread cannot be resumed without one. Log in first: ${codexLoginCommand(f)}`);
  }

  const changed = (f.recordedThread ?? "").toLowerCase() !== thread.threadId;
  if (f.running || f.state.startsWith("partial")) {
    if (!changed && f.state === "running") {
      return { kind: "already", lines: [`${f.alias} is already running thread ${thread.threadId} — attach to it: anet attach ${a}`] };
    }
    return refuse(2, `${f.alias} is ${f.state} — stop it first so the thread can be switched: anet node stop ${a}  (then rerun this command)`);
  }
  return { kind: "resume", threadId: thread.threadId, changed, rolloutPath: thread.path };
}

/** A typed answer to the picker: a number from the list; empty / q = cancel. */
export function parsePickAnswer(answer: string | null, choices: readonly string[]): { kind: "ok"; threadId: string } | { kind: "cancel" } | { kind: "bad"; message: string } {
  const t = (answer ?? "").trim().toLowerCase();
  if (!t || t === "q" || t === "quit") return { kind: "cancel" };
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return { kind: "ok", threadId: choices[n - 1] };
  return { kind: "bad", message: `"${answer?.trim()}" is not one of the numbers 1-${choices.length}` };
}

/**
 * `anet node codex resume` records the thread in config before its state
 * machine runs. If the run stops before anything was touched, the old value
 * goes back — the config must not name a thread the node is not running (#531 §5).
 */
export function resumeConfigShouldRollBack(stoppedAt: string): boolean {
  return stoppedAt === "preflight_before" || stoppedAt === "goal_state" || stoppedAt === "live_sessions";
}

/**
 * The facts for one node, from the same helpers the codex menu uses
 * (collectCodexRows: kind / state / login; effectiveCodexHome: which home).
 * Read-only. null = not a codex node.
 */
export function gatherCodexResumeFacts(node: CodexMenuNode, env: CollectEnv): CodexResumeFacts | null {
  const row = collectCodexRows([node], env)[0];
  if (!row) return null;
  const eff = effectiveCodexHome(join(env.nodesDir, node.id), node.profile, env.env ?? process.env, env.home);
  let homeExists = false;
  try { homeExists = existsSync(eff.codexHome) && statSync(eff.codexHome).isDirectory(); } catch { homeExists = false; }
  return {
    alias: row.alias,
    kind: row.kind,
    state: row.state,
    running: row.running,
    codexHome: eff.codexHome,
    homeExists,
    homeIsHost: eff.source === "default",
    loggedIn: row.loggedIn,
    recordedThread: row.threadId,
    threads: homeExists ? listExternalThreads(eff.codexHome) : [],
  };
}
