import { spawn } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { projectGrokChildEnv } from "./grok-child-env";

export interface GrokCliEvent {
  type?: string;
  data?: unknown;
  text?: unknown;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  message?: unknown;
  [key: string]: unknown;
}

export interface GrokCliTurnOptions {
  prompt: string;
  cwd: string;
  sessionId?: string;
  model?: string;
  maxTurns?: number;
  idleTimeoutMs?: number;
  binary?: string;
  /** Optional outer process launcher (for example a one-shot PID namespace). */
  launcher?: { binary: string; args: readonly string[] };
  /** Already-locked fd inherited as child fd 3 by the launcher chain. */
  lockFd?: number;
  env?: NodeJS.ProcessEnv;
  alwaysApprove?: boolean;
  /** Optional agent-node/Claude-style built-in tool allowlist. */
  toolAllowlist?: readonly string[];
  sandboxProfile?: string;
  /** Paths the model must not read through built-in Read/Grep tools. */
  protectedPaths?: readonly string[];
  signal?: AbortSignal;
  /** The exact prompt worker was spawned successfully. */
  onSubmitted?: () => void;
  /** The first parsed JSONL event from this per-turn worker. */
  onConsumed?: () => void;
  onEvent?: (event: GrokCliEvent) => void;
  onStderr?: (line: string) => void;
}

const GROK_TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  read_file: "read_file",
  write: "search_replace",
  edit: "search_replace",
  multiedit: "search_replace",
  notebookedit: "search_replace",
  search_replace: "search_replace",
  bash: "run_terminal_cmd",
  run_terminal_cmd: "run_terminal_cmd",
  run_terminal_command: "run_terminal_cmd",
  grep: "grep",
  glob: "list_dir",
  listdir: "list_dir",
  list_dir: "list_dir",
  websearch: "web_search",
  web_search: "web_search",
  webfetch: "web_fetch",
  web_fetch: "web_fetch",
  task: "task",
  agent: "task",
  spawn_subagent: "task",
  todo_write: "todo_write",
};

export const SAFE_GROK_TOOLS = ["read_file", "grep", "list_dir", "web_search", "web_fetch"] as const;
const REQUIRED_GROK_CLI_FLAGS = [
  "--prompt-file",
  "streaming-json",
  "--cwd",
  "--resume",
  "--tools",
  "--disallowed-tools",
  "--no-subagents",
  "--deny",
  "--always-approve",
  "--sandbox",
];

export function assertGrokCliFeatures(help: string): void {
  const missing = REQUIRED_GROK_CLI_FLAGS.filter((flag) => !help.includes(flag));
  if (missing.length) {
    throw new Error(`Grok CLI is too old for grok-build-cli; missing: ${missing.join(", ")}`);
  }
}

export function assertGrokCliVersion(version: string): void {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`cannot parse Grok CLI version: ${version.trim() || "(empty)"}`);
  const current = match.slice(1).map(Number);
  const minimum = [0, 2, 93];
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] > minimum[i]) return;
    if (current[i] < minimum[i]) {
      throw new Error(`Grok CLI ${current.join(".")} is older than verified minimum 0.2.93`);
    }
  }
}

/** Translate the node profile's Claude-style names to Grok's internal IDs. */
/** grok-build-cli 每个 turn 都在 `unshare --user --map-root-user` 下跑。
 *  调用方已经挡掉了非 Linux,但**「是 Linux」不等于「非特权 userns 可用」**:
 *  Ubuntu 24.04+ 默认 `kernel.apparmor_restrict_unprivileged_userns=1`,
 *  此时写 /proc/self/uid_map 会被拒。
 *
 *  实测(2026-08-13,Ubuntu 24.04.3):
 *    unshare --user --map-root-user … /bin/true
 *      → rc=1  "unshare: write failed /proc/self/uid_map: Operation not permitted"
 *    unshare --user /bin/true
 *      → rc=0   ← 命名空间本身能建,被拒的**只是 uid_map 那一步**
 *
 *  没有这道预检,失败会推迟到第一个 turn,并以内核层的 errno 出现 ——
 *  读到的人会去查内核/权限,而不是「这个 runtime 在这台机上用不了」。
 *
 *  🔴 判据是**真跑一次那个操作**,不是读 sysctl。sysctl 只是一个代理值:
 *  发行版、容器、seccomp、LSM 都可能让两者不一致,而真正决定成败的是操作本身。
 *
 *  `run` 可注入,便于测试;默认用 execFileSync。 */
export function assertUnprivilegedUserNsUsable(
  unshareBinary: string,
  run?: (bin: string, args: string[]) => { ok: boolean; stderr: string },
): void {
  const exec = run ?? ((bin: string, args: string[]) => {
    try {
      require("child_process").execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
      return { ok: true, stderr: "" };
    } catch (e: any) {
      return { ok: false, stderr: String(e?.stderr ?? e?.message ?? e) };
    }
  });
  const probe = exec(unshareBinary, ["--user", "--map-root-user", "/bin/true"]);
  if (probe.ok) return;
  throw new Error(
    "grok-build-cli cannot start: this machine refuses unprivileged user-namespace uid_map writes"
    + (probe.stderr.trim() ? ` (${probe.stderr.trim().split("\n")[0]})` : "")
    + ".\n"
    + "  Ubuntu 24.04+ ships kernel.apparmor_restrict_unprivileged_userns=1, which blocks the\n"
    + "  `unshare --map-root-user` this runtime uses for every turn.\n"
    + "  Check with: sysctl kernel.apparmor_restrict_unprivileged_userns\n"
    + "  Preferred fix: use the `grok-build-acp` runtime instead — it does not need user namespaces.\n"
    + "  (Relaxing the sysctl weakens a host-wide security boundary; that is an operator decision,\n"
    + "   not something this node should require.)",
  );
}

export function normalizeGrokCliTools(tools: readonly string[]): string[] {
  const mapped: string[] = [];
  const unknown: string[] = [];
  for (const raw of tools) {
    const name = String(raw).trim();
    if (!name) continue;
    const grokName = GROK_TOOL_ALIASES[name.toLowerCase()];
    if (!grokName) {
      unknown.push(name);
      continue;
    }
    if (!mapped.includes(grokName)) mapped.push(grokName);
  }
  if (unknown.length) {
    throw new Error(
      `grok-build-cli does not recognize configured tool${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
  return mapped;
}

export interface GrokCliTurnResult {
  replyText: string;
  sessionId: string;
  stopReason?: string;
  requestId?: string;
  eventCount: number;
}

export function buildGrokCliArgs(opts: GrokCliTurnOptions, promptFile: string): string[] {
  if (opts.prompt.includes("\0")) throw new Error("Grok CLI prompt contains a NUL byte");
  const args = [
    "--prompt-file", promptFile,
    "--output-format", "streaming-json",
    "--cwd", opts.cwd,
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (Number.isFinite(opts.maxTurns) && (opts.maxTurns ?? 0) > 0) {
    args.push("--max-turns", String(Math.floor(opts.maxTurns!)));
  }
  const configuredTools = opts.toolAllowlist
    ? normalizeGrokCliTools(opts.toolAllowlist)
    : undefined;

  // Headless mode cannot display an approval prompt. Grok 0.2.93 accepts
  // `--permission-mode dontAsk` but its bundled docs say only
  // bypassPermissions/default are currently enforced. Use a real tool
  // allowlist plus deny rules for the fail-closed path instead.
  if (opts.alwaysApprove) {
    if (configuredTools) {
      if (!configuredTools.length) throw new Error("grok-build-cli configured tool allowlist is empty");
      args.push("--tools", configuredTools.join(","));
    }
    args.push("--sandbox", opts.sandboxProfile || "workspace", "--always-approve");
  } else {
    const safeTools = configuredTools
      ? configuredTools.filter((tool) => SAFE_GROK_TOOLS.includes(tool))
      : SAFE_GROK_TOOLS;
    if (!safeTools.length) {
      throw new Error("grok-build-cli has no read-only tools after applying the configured allowlist");
    }
    args.push(
      "--tools", safeTools.join(","),
      "--sandbox", opts.sandboxProfile || "read-only",
      "--no-subagents",
      "--deny", "Bash",
      "--deny", "Edit",
      "--deny", "Write",
    );
  }

  // agent-node owns CommHub delivery/delegation. Never expose discovered MCP
  // integration tools to the model, including in --always-approve mode. Grok
  // deny rules have precedence over project/user allow rules.
  args.push(
    "--disallowed-tools", "search_tool,use_tool",
    "--deny", "MCPTool",
  );
  for (const path of opts.protectedPaths || []) {
    if (!path) continue;
    args.push("--deny", `Read(${path}/**)`, "--deny", `Grep(${path}/**)`);
  }
  return args;
}

/**
 * Run one turn through Grok's CLI/TUI execution engine in headless mode.
 * The long-lived CommHub node remains agent-node; Grok is a process-per-turn
 * worker whose streaming JSON output is reduced to a normal task reply.
 */
export async function runGrokCliTurn(opts: GrokCliTurnOptions): Promise<GrokCliTurnResult> {
  const binary = opts.binary || "grok";
  const idleTimeoutMs = opts.idleTimeoutMs ?? 300_000;
  if (opts.signal?.aborted) throw new Error("grok CLI turn was aborted");
  // Validate the final projected environment before persisting the prompt.
  // A launcher policy failure must not leave task text behind in /tmp.
  const childEnv = projectGrokChildEnv(opts.env || {});
  if (opts.launcher && childEnv.PWD !== opts.cwd) {
    throw new Error("headless Grok launcher requires an exact PWD matching cwd");
  }

  // Do not expose task/system-prompt contents in argv (`ps`, `/proc/*/cmdline`).
  // The per-turn directory and prompt file are owner-only and removed once
  // the Grok child exits.
  const promptDir = mkdtempSync(join(tmpdir(), ".anet-grok-prompt-"));
  chmodSync(promptDir, 0o700);
  const promptFile = join(promptDir, "prompt.txt");
  writeFileSync(promptFile, opts.prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const cleanupPrompt = () => {
    try { rmSync(promptDir, { recursive: true, force: true }); } catch {}
  };
  let args: string[];
  try {
    args = buildGrokCliArgs(opts, promptFile);
  } catch (error) {
    cleanupPrompt();
    throw error;
  }

  return await new Promise<GrokCliTurnResult>((resolve, reject) => {
    const childBinary = opts.launcher?.binary || binary;
    const childArgs = opts.launcher
      ? [...opts.launcher.args, "--", binary, ...args]
      : args;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(childBinary, childArgs, {
        cwd: opts.cwd,
        env: childEnv,
        stdio: opts.lockFd === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", opts.lockFd],
        shell: false,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      cleanupPrompt();
      reject(error);
      return;
    }
    opts.onSubmitted?.();

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stderrTail = "";
    let replyText = "";
    let replyBytes = 0;
    let sessionId = opts.sessionId || "";
    let stopReason: string | undefined;
    let requestId: string | undefined;
    let eventCount = 0;
    let consumptionReported = false;
    let sawEnd = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: Error | undefined;
    let protocolError: Error | undefined;
    let cliError: string | undefined;
    let settled = false;
    let terminationRequested = false;
    const MAX_STDOUT_LINE_BYTES = 1_048_576;
    const MAX_STDERR_LINE_BYTES = 65_536;
    const MAX_REPLY_BYTES = 4_194_304;
    const MAX_EVENTS = 100_000;

    const killChild = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };

    const terminateChild = () => {
      if (killTimer) return;
      terminationRequested = true;
      killChild("SIGTERM");
      killTimer = setTimeout(() => killChild("SIGKILL"), 1_000);
      killTimer.unref?.();
    };

    const onAbort = () => {
      protocolError = new Error("grok CLI turn was aborted");
      terminateChild();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const cleanupTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      // A successful CLI process can still leave a background tool/hook child
      // behind. Always reap its process group on close, not only on timeout or
      // cancellation. The production launcher also uses a one-shot PID
      // namespace so a setsid() descendant cannot escape this cleanup.
      killChild("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      idleTimer = undefined;
      killTimer = undefined;
      opts.signal?.removeEventListener("abort", onAbort);
      cleanupPrompt();
    };

    const armIdleTimer = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutError = new Error(`grok CLI was idle for ${idleTimeoutMs}ms`);
        terminateChild();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    const consumeEvent = (event: GrokCliEvent) => {
      eventCount++;
      if (eventCount > MAX_EVENTS) {
        protocolError = new Error(`grok CLI emitted more than ${MAX_EVENTS} JSONL events`);
        terminateChild();
        return;
      }
      armIdleTimer();
      if (!consumptionReported) {
        consumptionReported = true;
        opts.onConsumed?.();
      }
      opts.onEvent?.(event);
      if (event.type === "error") {
        cliError = typeof event.message === "string" ? event.message : "unknown Grok CLI error";
      } else if (event.type === "max_turns_reached") {
        cliError = "maximum turn limit reached before Grok completed the task";
      }
      if (event.type === "text" && typeof event.data === "string") {
        replyBytes += Buffer.byteLength(event.data);
        if (replyBytes > MAX_REPLY_BYTES) {
          protocolError = new Error(`grok CLI reply exceeded ${MAX_REPLY_BYTES} bytes`);
          terminateChild();
          return;
        }
        replyText += event.data;
      } else if (typeof event.text === "string") {
        // Compatibility with `--output-format json` and older preview builds
        // that emitted a final object even when streaming-json was requested.
        replyBytes = Buffer.byteLength(event.text);
        if (replyBytes > MAX_REPLY_BYTES) {
          protocolError = new Error(`grok CLI reply exceeded ${MAX_REPLY_BYTES} bytes`);
          terminateChild();
          return;
        }
        replyText = event.text;
      }
      if (typeof event.sessionId === "string" && event.sessionId) sessionId = event.sessionId;
      if (typeof event.stopReason === "string") stopReason = event.stopReason;
      if (typeof event.requestId === "string") requestId = event.requestId;
      if (event.type === "end" || (typeof event.text === "string" && !!event.sessionId)) sawEnd = true;
    };

    const consumeLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      try {
        consumeEvent(JSON.parse(line) as GrokCliEvent);
      } catch {
        // Grok occasionally writes diagnostic banners to stdout on upgrades.
        // Do not turn those into user replies; retain a bounded tail for the
        // eventual error if the process never produces a valid end event.
        stderrTail = `${stderrTail}\n[stdout] ${line}`.slice(-4_000);
      }
    };

    const flushStdout = () => {
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      stdoutBuffer = "";
    };
    const flushStderr = () => {
      if (stderrBuffer.trim()) opts.onStderr?.(stderrBuffer.trim());
      stderrBuffer = "";
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_STDOUT_LINE_BYTES) {
        protocolError = new Error(`grok CLI emitted a JSONL line larger than ${MAX_STDOUT_LINE_BYTES} bytes`);
        terminateChild();
        return;
      }
      let nl: number;
      while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
        consumeLine(stdoutBuffer.slice(0, nl));
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4_000);
      if (
        !protocolError
        && /not authenticated|signing in with grok|open this url to sign in|device code/i.test(chunk)
      ) {
        protocolError = new Error("Grok CLI authentication is unavailable; run `grok login` and retry");
        terminateChild();
      }
      stderrBuffer += chunk;
      if (stderrBuffer.length > MAX_STDERR_LINE_BYTES) {
        opts.onStderr?.(`${stderrBuffer.slice(0, MAX_STDERR_LINE_BYTES)}…[truncated]`);
        stderrBuffer = "";
      }
      let nl: number;
      while ((nl = stderrBuffer.indexOf("\n")) >= 0) {
        const line = stderrBuffer.slice(0, nl).trim();
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line) opts.onStderr?.(line);
      }
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      flushStdout();
      flushStderr();
      if (timeoutError) return reject(timeoutError);
      if (protocolError) return reject(protocolError);
      if (code !== 0) {
        return reject(new Error(
          `grok CLI exited with code ${String(code)}${signal ? ` signal=${signal}` : ""}` +
          (stderrTail.trim() ? `: ${stderrTail.trim()}` : ""),
        ));
      }
      if (cliError) return reject(new Error(`grok CLI error: ${cliError}`));
      if (!sawEnd) {
        return reject(new Error(
          `grok CLI exited without a final end event` +
          (stderrTail.trim() ? `: ${stderrTail.trim()}` : ""),
        ));
      }
      if (/cancel/i.test(stopReason || "")) {
        return reject(new Error(`grok CLI turn was cancelled (stopReason=${stopReason})`));
      }
      if (!sessionId) return reject(new Error("grok CLI final event did not include sessionId"));
      resolve({
        replyText: replyText.trim(),
        sessionId,
        stopReason,
        requestId,
        eventCount,
      });
    });

    armIdleTimer();
  });
}
