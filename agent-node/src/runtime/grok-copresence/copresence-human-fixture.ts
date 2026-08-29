import { mkdirSync, appendFileSync, rmSync, mkdtempSync, writeFileSync, existsSync, chmodSync } from "fs";
import { PassThrough } from "stream";
import { createConnection } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { connectGrokAttach, type GrokAttachSession } from "../../../../agent-network/src/grok-attach-client";
import {
  grokSessionDirectory,
  openGrokCopresenceRuntime,
  type GrokCopresenceRuntimeSession,
  type GrokPtyLike,
  type GrokPtySpawn,
} from "./runtime";
import { renderGrokCopresenceAgentProfile } from "./policy";

// 共享 fixture。**提取的理由不是整洁,是漂移**:
// 这段原本是 runtime.test.ts 545-982 行的逐字拷贝(见 slash-gate.test.ts 的历史)。
// 再拷第三份必然各自演化 —— 于是"两个文件跑的是同一套搭建"这个前提会悄悄失效,
// 而失效的时候没有任何东西会红。
//
// 🔴 一个搭建坑,踩过:runtime.test.ts 里人类提交能跑通,是因为它先跑过网络任务、
//    `handleNetwork` 顺手建了 session 目录。**纯人类输入的场景必须先调
//    `seedSessionEvents([])` 建空日志文件**,否则 append 到不存在的目录,
//    `humanPrompts` 永远为空 —— 表现为一条看不出原因的红。

export const SESSION = "11111111-1111-4111-8111-111111111111";
export const BLOCK_SUFFIX = "was blocked: Grok co-presence keeps its runtime-owned always-approve policy immutable";

type FakeDelayedWrite = {
  delayMs: number;
  source: "chat_history" | "events";
  value: unknown;
};

export async function withHumanTui(
  run: (context: {
    fixture: RuntimeFixture;
    runtime: GrokCopresenceRuntimeSession;
    input: PassThrough;
    terminalOutput: string[];
    statusWarnings: string[];
    statuses: unknown[];
    // 让用例能在中途主动脱离 —— onHumanDetach() 的效果只有真的断开才测得到。
    detach: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const fixture = new RuntimeFixture();
  let runtime: GrokCopresenceRuntimeSession | undefined;
  let attached: GrokAttachSession | undefined;
  try {
    runtime = await fixture.open();
    // The fake TUI appends a submitted human turn straight into the session
    // dir, which in runtime.test.ts only exists because a network turn ran
    // first. No network traffic here, so create the empty log files up front.
    fixture.seedSessionEvents([]);
    const input = new PassThrough();
    const output = new PassThrough();
    const terminalOutput: string[] = [];
    output.on("data", (chunk) => {
      terminalOutput.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    });
    const statusWarnings: string[] = [];
    const statuses: unknown[] = [];
    attached = await connectGrokAttach({
      socketPath: fixture.attachSocket,
      input,
      output,
      signalSource: fixture.signals,
      terminalSize: () => ({ cols: 100, rows: 30 }),
      onStatus: (frame) => {
        statuses.push(frame.status);
        const status = frame.status as { warning?: unknown } | null;
        if (status && typeof status === "object" && typeof status.warning === "string") {
          statusWarnings.push(status.warning);
        }
      },
    });
    const detach = async () => {
      attached?.detach();
      if (attached) await attached.closed;
      attached = undefined;
    };
    await run({ fixture, runtime, input, terminalOutput, statusWarnings, statuses, detach });
  } finally {
    attached?.detach();
    if (attached) await attached.closed;
    await runtime?.close();
    await fixture.close();
  }
}

export class RuntimeFixture {
  readonly root = mkdtempSync(join(tmpdir(), "grok-copres-runtime-"));
  readonly cwd = join(this.root, "work");
  readonly grokHome = join(this.root, "grok-home");
  readonly authPath = join(this.grokHome, "auth.json");
  readonly agentProfile = join(this.grokHome, "anet-copresence-preview.md");
  readonly fakeGrokBinary = join(this.root, "fake-grok.mjs");
  readonly leaderSocket = join(this.root, "leader.sock");
  readonly attachSocket = join(this.root, "attach.sock");
  readonly writes: string[] = [];
  readonly spawnedArgs: string[][] = [];
  readonly spawnedEnvs: Array<Record<string, string>> = [];
  readonly humanPrompts: string[] = [];
  // Added on top of the runtime.test.ts fixture: the runtime's `warn` sink is
  // where warnBlockedAutoApproval() reports which route it refused.
  readonly warnings: string[] = [];
  readonly signals = new PassThrough();
  spawnGateCalls = 0;
  failSpawnGateOnCall = Number.POSITIVE_INFINITY;
  unsafeModeOnCrash: "auto" | "yolo" | "" = "";
  pollIntervalMs = 25;
  resumeExisting = false;
  spawnEvents: unknown[] = [];
  spawnRawEvents = "";
  recoveryWrites: FakeDelayedWrite[] = [];
  allowedModels: readonly string[] | undefined = ["grok-4-fast", "grok-4.5"];
  acpModelSwitch: ((request: {
    method: string;
    params: { sessionId: string; modelId: string };
  }) => Promise<unknown>) | undefined;
  readonly acpModelSwitchCalls: Array<{
    method: string;
    params: { sessionId: string; modelId: string };
  }> = [];
  private ptys: FakePty[] = [];

  constructor() {
    mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.cwd, ".anet"), { recursive: true, mode: 0o700 });
    mkdirSync(this.grokHome, { recursive: true, mode: 0o700 });
    writeFileSync(this.agentProfile, renderGrokCopresenceAgentProfile(), { mode: 0o600 });
    writeFileSync(this.fakeGrokBinary, [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import net from "node:net";',
      'const args = process.argv.slice(2);',
      'if (args[0] !== "agent" || args[1] !== "leader") process.exit(64);',
      'const socket = process.env.GROK_LEADER_SOCKET || "";',
      'if (!socket || fs.existsSync(socket)) process.exit(65);',
      'const server = net.createServer((client) => client.destroy());',
      'server.listen(socket, () => { try { fs.chmodSync(socket, 0o600); } catch {} });',
      'process.on("SIGTERM", () => process.exit(0));',
      'process.on("SIGINT", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(this.fakeGrokBinary, 0o700);
  }

  options(sessionId = SESSION) {
    const env = this.childEnv();
    return {
      binary: this.fakeGrokBinary,
      cwd: this.cwd,
      grokHome: this.grokHome,
      env,
      sessionId,
      newSession: !this.resumeExisting,
      leaderSocket: this.leaderSocket,
      attachSocket: this.attachSocket,
      alias: "grok-test",
      model: "grok-4",
      agentProfile: this.agentProfile,
      allowedModels: this.allowedModels,
      alwaysApprove: false,
      sandboxProfile: "workspace",
      pollIntervalMs: this.pollIntervalMs,
      reconnectAttempts: 1,
      beforeSpawn: () => {
        this.spawnGateCalls += 1;
        if (this.spawnGateCalls === this.failSpawnGateOnCall) throw new Error("fixture policy injection");
        return env;
      },
      ptySpawn: this.spawn,
      acpModelSwitch: async (request: {
        method: string;
        params: { sessionId: string; modelId: string };
      }) => {
        this.acpModelSwitchCalls.push(request);
        if (this.acpModelSwitch) return this.acpModelSwitch(request);
        return {};
      },
      onHumanPrompt: (prompt: string) => { this.humanPrompts.push(prompt); },
      warn: (message: string) => { this.warnings.push(message); },
    };
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: this.grokHome,
      PWD: this.cwd,
      GROK_HOME: this.grokHome,
      GROK_AUTH_PATH: this.authPath,
      GROK_CLAUDE_SKILLS_ENABLED: "false",
      GROK_CURSOR_SKILLS_ENABLED: "false",
      GROK_CLAUDE_RULES_ENABLED: "false",
      GROK_CURSOR_RULES_ENABLED: "false",
      GROK_CLAUDE_AGENTS_ENABLED: "false",
      GROK_CURSOR_AGENTS_ENABLED: "false",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      GROK_CLAUDE_SESSIONS_ENABLED: "false",
      GROK_CURSOR_SESSIONS_ENABLED: "false",
      GROK_CODEX_SESSIONS_ENABLED: "false",
      GROK_FOLDER_TRUST: "1",
      GROK_DEFAULT_SELECTED_PERMISSION: "always_allow_all_sessions",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_CHANGELOG_OFFLINE: "1",
      GROK_LEADER_LOG: "off",
      GROK_SUBAGENTS: "0",
      GROK_WEB_FETCH: "0",
      GROK_MEMORY: "0",
      ANET_EXPECTED_PARENT_PID: String(process.pid),
      LEAKED_NODE_TOKEN: "ntok_must-not-reach-tui",
    };
  }

  async open(): Promise<GrokCopresenceRuntimeSession> {
    return openGrokCopresenceRuntime(this.options());
  }

  private readonly spawn: GrokPtySpawn = async (_binary, args, options) => {
    this.spawnedArgs.push([...args]);
    this.spawnedEnvs.push({ ...options.env });
    const pty = new FakePty(
      _binary,
      options.cwd,
      options.env,
      this.leaderSocket,
      grokSessionDirectory(this.grokHome, this.cwd, SESSION),
      this.writes,
      this.spawnEvents,
      this.spawnRawEvents,
      this.ptys.length > 0 ? this.recoveryWrites : [],
    );
    await pty.start();
    this.ptys.push(pty);
    return pty;
  };

  async crashCurrent(): Promise<void> {
    await this.ptys.at(-1)?.crash(this.unsafeModeOnCrash);
  }

  approvalDecisionCount(): number {
    return this.ptys.at(-1)?.approvalDecisionWrites ?? 0;
  }

  emitUnsafeApprovalMode(): void {
    const sessionDir = grokSessionDirectory(this.grokHome, this.cwd, SESSION);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    appendJson(join(sessionDir, "events.jsonl"), { type: "yolo_toggled", enabled: true });
  }

  emitUnpolledPermissionRequest(): void {
    const sessionDir = grokSessionDirectory(this.grokHome, this.cwd, SESSION);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    appendJson(join(sessionDir, "events.jsonl"), {
      type: "permission_requested",
      tool_name: "run_terminal_command",
    });
  }

  seedSessionEvents(events: unknown[]): void {
    const sessionDir = grokSessionDirectory(this.grokHome, this.cwd, SESSION);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(sessionDir, "chat_history.jsonl"), "", { mode: 0o600 });
    appendFileSync(join(sessionDir, "events.jsonl"), "", { mode: 0o600 });
    for (const event of events) appendJson(join(sessionDir, "events.jsonl"), event);
  }

  resetSessionFiles(): void {
    rmSync(grokSessionDirectory(this.grokHome, this.cwd, SESSION), {
      recursive: true,
      force: true,
    });
  }

  async close(): Promise<void> {
    for (const pty of this.ptys) await pty.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

export class FakePty implements GrokPtyLike {
  readonly pid = 42;
  private leaderChild: ReturnType<typeof Bun.spawn> | null = null;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  private composer = "";
  private paste = false;
  private awaitingApprovalTask = "";
  private lateCrashTask = "";
  private exited = false;
  approvalDecisionWrites = 0;
  private approvalResolutionScheduled = false;
  private approvalResolutionTimer: ReturnType<typeof setTimeout> | null = null;
  private delayedWrites: Array<ReturnType<typeof setTimeout>> = [];

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly socket: string,
    private readonly sessionDir: string,
    private readonly writes: string[],
    private readonly startupEvents: readonly unknown[],
    private readonly startupRawEvents: string,
    private readonly scheduledWrites: readonly FakeDelayedWrite[],
  ) {}

  async start(): Promise<void> {
    this.leaderChild = Bun.spawn([
      process.execPath,
      this.binary,
      "agent",
      "leader",
      "--no-exit-on-disconnect",
      "--relay-on-demand",
    ], {
      cwd: this.cwd,
      env: {
        ...this.env,
        GROK_LEADER_SOCKET: this.socket,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(() => existsSync(this.socket));
    await waitFor(() => canConnectUnixSocket(this.socket));
    if (this.startupRawEvents || this.startupEvents.length) {
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    }
    if (this.startupRawEvents) {
      appendFileSync(join(this.sessionDir, "events.jsonl"), this.startupRawEvents, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    for (const event of this.startupEvents) {
      appendJson(join(this.sessionDir, "events.jsonl"), event);
    }
    for (const write of this.scheduledWrites) {
      this.delayedWrites.push(setTimeout(() => {
        mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
        appendJson(join(this.sessionDir, `${write.source}.jsonl`), write.value);
      }, write.delayMs));
    }
    setImmediate(() => {
      this.emitData("\x1b[2JShift+\x1b[32mTab\x1b[0m:mode  │  Ctrl+x:shortcuts\r\n");
    });
  }

  write(data: string): void {
    this.writes.push(data);
    if (data.includes("[Agent Network/")) {
      this.handleNetwork(data);
      return;
    }
    this.handleHumanBytes(data);
  }

  resize(): void {}

  kill(): void {
    void this.closeServer().then(() => this.emitExit({ exitCode: 0, signal: 15 }));
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((item) => item !== listener); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((item) => item !== listener); } };
  }

  async crash(unsafeMode: "auto" | "yolo" | "" = ""): Promise<void> {
    for (const timer of this.delayedWrites) clearTimeout(timer);
    this.delayedWrites = [];
    if (this.approvalResolutionTimer) clearTimeout(this.approvalResolutionTimer);
    this.approvalResolutionTimer = null;
    await this.closeServer();
    this.emitExit({ exitCode: 7 });
    if (this.lateCrashTask) {
      const taskId = this.lateCrashTask;
      this.lateCrashTask = "";
      setTimeout(() => {
        appendJson(join(this.sessionDir, "chat_history.jsonl"), {
          type: "assistant",
          content: `STALE FINAL ${taskId}`,
        });
        appendJson(join(this.sessionDir, "events.jsonl"), {
          type: "turn_ended",
          outcome: "completed",
        });
      }, 80);
    }
    if (unsafeMode) {
      mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      setTimeout(() => {
        appendJson(join(this.sessionDir, "events.jsonl"), unsafeMode === "auto"
          ? { type: "phase_changed", phase: "auto" }
          : { type: "yolo_toggled", enabled: true });
      }, 80);
    }
  }

  async close(): Promise<void> {
    for (const timer of this.delayedWrites) clearTimeout(timer);
    this.delayedWrites = [];
    if (this.approvalResolutionTimer) clearTimeout(this.approvalResolutionTimer);
    this.approvalResolutionTimer = null;
    await this.closeServer();
  }

  private handleNetwork(wire: string): void {
    const prompt = wire.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~\r$/, "");
    const match = prompt.match(/^\[Agent Network\/from=([^/]+)\/task=([^\]]+)\] ([\s\S]*)$/);
    if (!match) throw new Error(`bad network envelope: ${JSON.stringify(prompt)}`);
    const [, from, taskId, message] = match;
    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    if (message === "CRASH_ACTIVE") {
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "user",
        content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
      });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 4 });
      this.lateCrashTask = taskId;
      return;
    }
    if (message === "APPROVAL") {
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "user",
        content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
      });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 2 });
      appendJson(join(this.sessionDir, "events.jsonl"), {
        type: "permission_requested",
        tool_name: "run_terminal_command",
      });
      this.awaitingApprovalTask = taskId;
      return;
    }
    if (message === "AUTO_RESOLVE") {
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "user",
        content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
      });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 3 });
      appendJson(join(this.sessionDir, "events.jsonl"), {
        type: "permission_requested",
        tool_name: "run_terminal_command",
      });
      appendJson(join(this.sessionDir, "events.jsonl"), {
        type: "permission_resolved",
        tool_name: "run_terminal_command",
        decision: "allow",
      });
      return;
    }
    if (message === "AUTO_COMPLETE_NO_RESOLVE") {
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "user",
        content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
      });
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "assistant",
        content: "UNAUTHORIZED COMPLETION",
      });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 5 });
      appendJson(join(this.sessionDir, "events.jsonl"), {
        type: "permission_requested",
        tool_name: "run_terminal_command",
      });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_ended", outcome: "completed" });
      return;
    }
    if (message === "DELAYED_FINAL") {
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 10 });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_ended", outcome: "completed" });
      setTimeout(() => {
        appendJson(join(this.sessionDir, "chat_history.jsonl"), {
          type: "user",
          content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
        });
        appendJson(join(this.sessionDir, "chat_history.jsonl"), {
          type: "assistant",
          content: "TOOL-BEARING INTERMEDIATE",
          tool_calls: [{ id: "call-delayed", name: "grep", arguments: "{}" }],
        });
      }, 40);
      setTimeout(() => {
        appendJson(join(this.sessionDir, "chat_history.jsonl"), {
          type: "assistant",
          content: `FINAL ${taskId}`,
        });
      }, 800);
      return;
    }

    // Deliberately expose terminal completion before any chat line. The final
    // assistant also follows an intermediate/tool pair.
    appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 1 });
    appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_ended", outcome: "completed" });
    setTimeout(() => {
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "user",
        content: `<user_query>[Agent Network/from=${from}/task=${taskId}] ${message}</user_query>`,
      });
      appendJson(join(this.sessionDir, "chat_history.jsonl"), {
        type: "assistant",
        content: "INTERMEDIATE",
        tool_calls: [{ id: "call-1", name: "run_terminal_command", arguments: "{}" }],
      });
      appendJson(join(this.sessionDir, "chat_history.jsonl"), { type: "tool_result", content: "ok" });
      appendJson(join(this.sessionDir, "chat_history.jsonl"), { type: "assistant", content: `FINAL ${taskId}` });
    }, 40);
  }

  private handleHumanBytes(data: string): void {
    for (let index = 0; index < data.length;) {
      if (data.startsWith("\x1b[200~", index)) {
        this.paste = true;
        index += 6;
        continue;
      }
      if (data.startsWith("\x1b[201~", index)) {
        this.paste = false;
        index += 6;
        continue;
      }
      const char = data[index++];
      if (this.awaitingApprovalTask && /^[1-9]$/.test(char)) {
        this.resolveApproval();
        continue;
      }
      if (char === "\x03" && !this.paste) {
        this.composer = "";
        continue;
      }
      if ((char !== "\r" && char !== "\n") || this.paste) {
        this.composer += char;
        continue;
      }
      const submitted = this.composer;
      this.composer = "";
      if (this.awaitingApprovalTask) {
        this.resolveApproval();
      } else if (submitted) {
        appendJson(join(this.sessionDir, "chat_history.jsonl"), {
          type: "user",
          content: `<user_query>${submitted}</user_query>`,
        });
        appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_started", turn_number: 6 });
        appendJson(join(this.sessionDir, "chat_history.jsonl"), { type: "assistant", content: "human answer" });
        appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_ended", outcome: "completed" });
      }
    }
  }

  private resolveApproval(): void {
    const taskId = this.awaitingApprovalTask;
    if (!taskId || this.approvalResolutionScheduled) return;
    this.approvalDecisionWrites += 1;
    this.approvalResolutionScheduled = true;
    // A duplicate event after the human key must not reopen the gate.
    appendJson(join(this.sessionDir, "events.jsonl"), {
      type: "permission_requested",
      tool_name: "run_terminal_command",
    });
    this.approvalResolutionTimer = setTimeout(() => {
      this.approvalResolutionTimer = null;
      this.awaitingApprovalTask = "";
      appendJson(join(this.sessionDir, "events.jsonl"), {
        type: "permission_resolved",
        tool_name: "run_terminal_command",
        decision: "allow",
      });
      appendJson(join(this.sessionDir, "chat_history.jsonl"), { type: "assistant", content: `APPROVED ${taskId}` });
      appendJson(join(this.sessionDir, "events.jsonl"), { type: "turn_ended", outcome: "completed" });
    }, 80);
  }

  private emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  private emitExit(event: { exitCode: number; signal?: number }): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(event);
  }

  private async closeServer(): Promise<void> {
    const child = this.leaderChild;
    this.leaderChild = null;
    if (!child) return;
    child.kill();
    await child.exited.catch(() => {});
  }
}

export function appendJson(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function canConnectUnixSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
