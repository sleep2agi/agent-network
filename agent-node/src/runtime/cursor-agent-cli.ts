// cursor-agent preview — one Hub task, one headless Cursor Agent CLI turn.
//
// Same shape as the other CLI runtimes that already own the CommHub
// connection in agent-node (opencode print/ACP, grok `grok -p`): the parent
// receives the task and sends the reply; the local CLI is only the model.
// This is print mode (`agent -p`), not `agent acp` and not a shared TUI.
//
// Auth is whatever the operator already has: a `agent login` store under
// their home, or CURSOR_API_KEY already in the environment. This module
// never writes a key and never puts the Hub token in the child environment.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";

export const CURSOR_AGENT_RUNTIME = "cursor-agent";
export const CURSOR_AGENT_TIMEOUT_MS = 600_000;
export const CURSOR_AGENT_STDOUT_CAP = 2_000_000;
export const CURSOR_AGENT_PROMPT_CAP = 100_000;

export type CursorAgentBinarySource = "CURSOR_AGENT_BIN" | "cursor-agent" | "agent";

export interface ResolvedCursorAgentBinary {
  binary: string;
  source: CursorAgentBinarySource;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** True when `name` is an executable path or a command on PATH. */
export function cursorAgentOnPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\")) {
    try {
      accessSync(name, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (process.platform === "win32") {
      execFileSync("where", [name], { stdio: "ignore", env });
    } else {
      execFileSync("/bin/sh", ["-c", `command -v ${shellQuote(name)}`], { stdio: "ignore", env });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer the explicit `cursor-agent` binary. Fall back to `agent` (the name
 * the current Cursor install script puts on PATH). `CURSOR_AGENT_BIN` wins
 * when set, so a test or a non-PATH install can point at one file.
 */
export function resolveCursorAgentBinary(input: {
  env?: NodeJS.ProcessEnv;
  lookup?: (name: string) => boolean;
  /** Used only for the generic `agent` name. `cursor-agent` and CURSOR_AGENT_BIN are explicit. */
  identify?: (name: string) => boolean;
} = {}): ResolvedCursorAgentBinary {
  const env = input.env ?? process.env;
  const lookup = input.lookup ?? ((name: string) => cursorAgentOnPath(name, env));
  const fromEnv = typeof env.CURSOR_AGENT_BIN === "string" ? env.CURSOR_AGENT_BIN.trim() : "";
  if (fromEnv) {
    if (!lookup(fromEnv)) {
      throw new Error("CURSOR_AGENT_BIN is set but is not executable. Unset it or point it at the Cursor Agent CLI.");
    }
    return { binary: fromEnv, source: "CURSOR_AGENT_BIN" };
  }
  if (lookup("cursor-agent")) return { binary: "cursor-agent", source: "cursor-agent" };
  if (lookup("agent")) {
    const identify = input.identify ?? ((name: string) => defaultCursorAgentIdentity(name, env));
    if (!identify("agent")) {
      throw new Error(
        "An executable named `agent` is on PATH, but it did not identify itself as the Cursor Agent CLI. " +
        "Install Cursor's CLI, or set CURSOR_AGENT_BIN to that executable.",
      );
    }
    return { binary: "agent", source: "agent" };
  }
  throw new Error(
    "cursor-agent runtime needs the Cursor Agent CLI on PATH (`cursor-agent`, or `agent`). " +
    "Install: https://cursor.com/docs/cli/overview — then `agent login`.",
  );
}

/** Hub credentials stay in agent-node. The CLI keeps its own login env. */
export function cursorAgentChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith("COMMHUB_")) continue;
    env[key] = value;
  }
  return env;
}

export function cursorCliOutputLooksLikeCursor(text: string): boolean {
  return /\bcursor\b/i.test(text);
}

/** `0` is the shared validator's "no limit". Any other non-finite or negative value uses the default. */
export function resolveCursorAgentTimeoutMs(flag: unknown, fallback = CURSOR_AGENT_TIMEOUT_MS): number {
  if (typeof flag === "number" && Number.isFinite(flag) && flag >= 0) return flag;
  return fallback;
}

export function buildCursorAgentArgs(input: {
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  /** `false` omits `--force`. Omitted means the unattended preview default, which is on. */
  force?: boolean;
}): string[] {
  const args = ["-p", "--output-format", "json", "--trust"];
  if (input.force !== false) args.push("--force");
  args.push("--workspace", input.cwd);
  if (input.model) args.push("--model", input.model);
  if (input.sessionId) args.push("--resume", input.sessionId);
  args.push("--", input.prompt);
  return args;
}

export function parseCursorAgentJson(stdout: string): { result: string; sessionId?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("cursor-agent produced no stdout");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
    const last = lines[lines.length - 1];
    if (!last) throw new Error("cursor-agent stdout was not JSON");
    parsed = JSON.parse(last);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("cursor-agent JSON was not an object");
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "result" || obj.subtype !== "success" || obj.is_error !== false) {
    throw new Error("cursor-agent JSON was not a successful result");
  }
  if (typeof obj.result !== "string" || !obj.result.trim()) {
    throw new Error("cursor-agent returned an empty result");
  }
  const sessionId = typeof obj.session_id === "string" && obj.session_id.trim()
    ? obj.session_id.trim()
    : undefined;
  return { result: obj.result, sessionId };
}

/** Only a rejected resume id is retried. A later outage that merely mentions
 *  "session" or "chat" must not start a second forced turn. */
export function cursorAgentResumeRejected(message: string): boolean {
  return /unknown session|no such session|session not found|session does not exist|invalid session|stale session/i.test(message);
}

function captureCommandText(binary: string, args: string[], env: NodeJS.ProcessEnv): string {
  try {
    return String(execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 5_000,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error: any) {
    return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  }
}

function defaultCursorAgentIdentity(binary: string, env: NodeJS.ProcessEnv): boolean {
  for (const args of [["--version"], ["--help"]]) {
    if (cursorCliOutputLooksLikeCursor(captureCommandText(binary, args, env))) return true;
  }
  return false;
}

export function cursorAgentKillPlan(platform: NodeJS.Platform, pid: number):
  | { kind: "process-group" }
  | { kind: "taskkill"; file: "taskkill.exe"; args: string[] } {
  if (platform === "win32") {
    return { kind: "taskkill", file: "taskkill.exe", args: ["/PID", String(pid), "/T", "/F"] };
  }
  return { kind: "process-group" };
}

function killChild(child: ChildProcess) {
  const pid = child.pid;
  if (pid) {
    const plan = cursorAgentKillPlan(process.platform, pid);
    if (plan.kind === "taskkill") {
      try { execFileSync(plan.file, plan.args, { stdio: "ignore" }); return; } catch { /* fall through */ }
    } else {
      try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall through */ }
    }
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

// One turn at a time (think() is serialized). `detached` puts the CLI in its
// own process group so a timeout can kill the group; that also means a
// SIGTERM to agent-node does not reap it. shutdown() calls this. No signal
// listener is installed here — this module is imported by every runtime.
let activeChild: ChildProcess | null = null;

export function killActiveCursorAgentTurn(): boolean {
  const child = activeChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  killChild(child);
  return true;
}

function runOnce(input: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err?: Error, result?: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = input.timeoutMs > 0 ? setTimeout(() => {
      killChild(child);
      finish(new Error(`cursor-agent timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs) : undefined;
    child.stdout?.on("data", (buf: Buffer) => {
      stdout += buf.toString("utf8");
      if (stdout.length > CURSOR_AGENT_STDOUT_CAP) {
        killChild(child);
        finish(new Error("cursor-agent stdout exceeded 2MB"));
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (stderr.length < 4_000) stderr += buf.toString("utf8");
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => finish(undefined, { stdout, stderr, code }));
  });
}

export async function runCursorAgentTurn(input: {
  binary: string;
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  force?: boolean;
}): Promise<{ result: string; sessionId?: string }> {
  if (input.prompt.length > CURSOR_AGENT_PROMPT_CAP) {
    throw new Error(`cursor-agent prompt is ${input.prompt.length} chars; this preview accepts at most ${CURSOR_AGENT_PROMPT_CAP}`);
  }
  const env = input.env ?? cursorAgentChildEnv(process.env);
  const timeoutMs = input.timeoutMs ?? CURSOR_AGENT_TIMEOUT_MS;
  const attempt = async (sessionId?: string) => {
    const args = buildCursorAgentArgs({
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      sessionId,
      force: input.force,
    });
    let ran: { stdout: string; stderr: string; code: number | null };
    try {
      ran = await runOnce({ binary: input.binary, args, cwd: input.cwd, env, timeoutMs });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(`cursor-agent binary not found (${input.binary}). Install the Cursor Agent CLI and run \`agent login\`.`);
      }
      throw err;
    }
    if (ran.code !== 0) {
      const detail = ran.stderr.trim().replace(/\s+/g, " ").slice(0, 300);
      const message = detail
        ? `cursor-agent exited ${ran.code}: ${detail}`
        : `cursor-agent exited ${ran.code} with no stderr`;
      const error = new Error(message) as Error & { retryWithoutSession?: boolean };
      error.retryWithoutSession = !!sessionId && cursorAgentResumeRejected(message);
      throw error;
    }
    return parseCursorAgentJson(ran.stdout);
  };

  try {
    return await attempt(input.sessionId);
  } catch (err: any) {
    if (!err?.retryWithoutSession) throw err;
    return await attempt(undefined);
  }
}
