import { spawn as spawnChild, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import { StringDecoder } from "string_decoder";
import { startGrokAttachServer, type GrokAttachServer } from "./attach";
import {
  newGrokJsonlState,
  flushPendingGrokNetworkReply,
  reduceGrokJsonlChunk,
  registerExpectedGrokHumanTurn,
  registerOwnedNetworkTask,
  unregisterOwnedNetworkTask,
  type GrokCopresenceEvent as GrokLogEvent,
  type GrokJsonlSource,
  type GrokJsonlState,
} from "./jsonl";
import {
  newGrokCopresenceState,
  reduceGrokCopresenceState,
  snapshotGrokCopresenceState,
  type GrokCopresenceEvent,
  type GrokCopresenceNetworkTask,
  type GrokCopresenceState,
} from "./state";
import { buildGrokHelperEnv, buildGrokPtyEnv, projectGrokChildEnv } from "../grok-child-env";
import {
  assertGrokCopresenceAgentProfile,
  GROK_COPRESENCE_EFFECTIVE_TOOLS,
} from "./policy";
import {
  captureOwnedGrokLeader,
  terminateOwnedGrokLeader,
  type OwnedGrokLeaderIdentity,
} from "./leader-lifecycle";

// Keep enough headroom for Grok's XML wrapper plus JSON string escaping; the
// reducer's hard JSONL line cap is 1 MiB.
const MAX_NETWORK_PROMPT_BYTES = 384 * 1024;
const MAX_DEFERRED_HUMAN_BYTES = 128 * 1024;
const MAX_TUI_READINESS_BUFFER = 128 * 1024;
const MAX_TAIL_READ_BYTES = 4 * 1024 * 1024;
const MAX_LIFECYCLE_LINE_BYTES = 256 * 1024;
const MAX_RESUME_AUDIT_BYTES = 64 * 1024 * 1024;
const UNIX_SOCKET_PATH_MAX_BYTES = 100;
const GROK_TUI_READY_TEXT = "Shift+Tab:mode";
const GROK_TUI_SHORTCUTS_TEXT = "Ctrl+x:shortcuts";

/**
 * Grok 0.2.93 creates its Leader socket before the interactive editor has
 * finished terminal negotiation. Input written in that window is silently
 * discarded. The pinned TUI renders this footer only after its composer is
 * accepting input. Strip terminal control framing so ANSI fragmentation
 * cannot hide a marker that spans multiple PTY chunks.
 */
export function hasGrokTuiReadyMarker(raw: string): boolean {
  let visible = "";
  let state: "text" | "escape" | "csi" | "osc" | "control-string" = "text";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = raw[index];
    if (state === "text") {
      if (code === 0x1b) state = "escape";
      else if (code === 0x9b) state = "csi";
      else if (code === 0x9d) state = "osc";
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        state = "control-string";
      } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
        visible += char;
      }
      continue;
    }
    if (state === "escape") {
      if (char === "[") state = "csi";
      else if (char === "]") state = "osc";
      else if (char === "P" || char === "X" || char === "^" || char === "_") {
        state = "control-string";
      } else state = "text";
      continue;
    }
    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "text";
      continue;
    }
    if (state === "osc" && code === 0x07) {
      state = "text";
      continue;
    }
    if (code === 0x1b && raw[index + 1] === "\\") {
      index += 1;
      state = "text";
    }
  }
  return visible.includes(GROK_TUI_READY_TEXT)
    && visible.includes(GROK_TUI_SHORTCUTS_TEXT);
}
const COMPLETION_CHAT_SETTLE_MS = 500;

export interface GrokPtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type GrokPtySpawn = (
  binary: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => GrokPtyLike | Promise<GrokPtyLike>;

export interface GrokCopresenceOpenOptions {
  binary?: string;
  cwd: string;
  grokHome: string;
  env: NodeJS.ProcessEnv;
  sessionId?: string;
  newSession?: boolean;
  leaderSocket: string;
  attachSocket: string;
  alias: string;
  model?: string;
  agentProfile: string;
  maxTurns?: number;
  alwaysApprove?: boolean;
  toolAllowlist?: readonly string[];
  sandboxProfile: string;
  protectedPaths?: readonly string[];
  flockBinary?: string;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  reconnectAttempts?: number;
  ptySpawn?: GrokPtySpawn;
  /** Rebuild and audit the isolated Grok environment before every TUI spawn. */
  beforeSpawn?: (context: { resume: boolean }) =>
    NodeJS.ProcessEnv | void | Promise<NodeJS.ProcessEnv | void>;
  onSession?: (sessionId: string) => void | Promise<void>;
  onHumanPrompt?: (prompt: string) => void | Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface GrokCopresenceThinkOptions {
  taskId: string;
  from: string;
  text: string;
  timeoutMs?: number;
}

export interface GrokCopresenceThinkResult {
  replyText: string;
  sessionId: string;
  queued: boolean;
}

export interface GrokCopresenceRuntimeSession {
  readonly sessionId: string;
  readonly leaderSocket: string;
  readonly attachSocket: string;
  readonly isRunning: boolean;
  readonly state: GrokCopresenceState;
  submit(opts: GrokCopresenceThinkOptions): Promise<GrokCopresenceThinkResult>;
  close(): Promise<void>;
}

export interface BuildGrokCopresenceArgsOptions {
  cwd: string;
  sessionId: string;
  resume: boolean;
  leaderSocket: string;
  model?: string;
  agentProfile: string;
  maxTurns?: number;
  alwaysApprove?: boolean;
  toolAllowlist?: readonly string[];
  sandboxProfile: string;
  protectedPaths?: readonly string[];
}

/** Interactive TUI argv. No prompt/output JSON flags and no CommHub MCP. */
export function buildGrokCopresenceArgs(opts: BuildGrokCopresenceArgsOptions): string[] {
  assertSessionId(opts.sessionId);
  assertSocketPath(opts.leaderSocket, "leader");
  if (!isAbsolute(opts.agentProfile) || opts.agentProfile.includes("\0")) {
    throw new Error("grok copresence requires an absolute runtime-owned agent profile");
  }
  const args = [
    // Hidden in 0.2.93 help but required by the captured live TUI path:
    // --leader-socket alone merely names a socket and does not join/spawn the
    // shared backend. The exact binary pin below is the compatibility gate.
    "--leader",
    "--leader-socket", opts.leaderSocket,
    "--cwd", opts.cwd,
    opts.resume ? "--resume" : "--session-id", opts.sessionId,
    // Unlike --tools, this flag is honored by the pinned interactive TUI.
    "--agent", opts.agentProfile,
    // Reset a resumed process to the interactive approval policy. The PTY
    // proxy separately blocks every TUI route that could turn YOLO back on.
    "--permission-mode", "default",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxTurns !== undefined) {
    throw new Error("grok copresence does not support maxTurns; Grok 0.2.93 ignores it in interactive TUI mode");
  }

  if (opts.alwaysApprove) {
    throw new Error(
      "grok copresence forbids dangerouslySkipPermissions; approvals must be owned by the human TUI",
    );
  }
  if (opts.toolAllowlist !== undefined) {
    throw new Error(
      `grok copresence uses a fixed preview tool profile (${GROK_COPRESENCE_EFFECTIVE_TOOLS.join(",")}); custom tools are unsupported`,
    );
  }
  args.push(
    "--sandbox", opts.sandboxProfile,
    "--no-auto-update",
    "--disable-web-search",
    "--no-subagents",
    "--no-memory",
  );

  // A2 trust boundary: the TUI never receives the node bearer token and is
  // never allowed to call a discovered MCP tool. Human delegation is parsed
  // from chat_history by agent-node instead.
  args.push(
    // The shared process must read its owner-only GROK_AUTH_PATH after its
    // sandbox re-exec. Shell access would bypass path-specific Read/Grep/Edit
    // rules, so the experimental preview gives up terminal tools entirely.
    "--deny", "Bash",
    "--deny", "Write",
    "--deny", "MCPTool",
    "--deny", "WebFetch",
  );
  for (const path of opts.protectedPaths ?? []) {
    if (path) {
      if (!isAbsolute(path) || /[\0\r\n\\*?()[\]{},]/.test(path)) {
        throw new Error("grok copresence protected path cannot be represented safely as a permission rule");
      }
      args.push(
        "--deny", `Read(${path})`,
        "--deny", `Read(${path}/**)`,
        "--deny", `Grep(${path})`,
        "--deny", `Grep(${path}/**)`,
        "--deny", `Edit(${path})`,
        "--deny", `Edit(${path}/**)`,
      );
    }
  }
  return args;
}

export function assertGrokCopresenceFeatures(help: string): void {
  const required = [
    "--leader-socket", "--session-id", "--resume", "--cwd", "--sandbox",
    "--agent", "--deny", "--permission-mode",
    "--disable-web-search", "--no-subagents", "--no-memory",
  ];
  const missing = required.filter((flag) => !help.includes(flag));
  if (missing.length) throw new Error(`Grok CLI is too old for copresence; missing: ${missing.join(", ")}`);
}

/** The PTY/menu/event security contract was black-box verified for this build. */
export function assertGrokCopresenceVersion(version: string): void {
  const observed = version.trim();
  if (
    observed !== "grok 0.2.93 (f00f96316d)"
    && observed !== "grok 0.2.93 (f00f96316d) [stable]"
  ) {
    throw new Error(
      `grok copresence requires exactly grok 0.2.93 (f00f96316d); received ${observed || "empty version"}`,
    );
  }
}

/** Fail closed when project/user config could pre-authorize TUI tool calls. */
export function assertGrokCopresenceApprovalOwnership(
  inspectionJson: string,
  isolatedGrokHome: string,
): void {
  let inspection: Record<string, unknown>;
  try {
    const parsed = JSON.parse(inspectionJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("non-object");
    inspection = parsed as Record<string, unknown>;
  } catch {
    throw new Error("grok copresence inspect returned invalid JSON");
  }
  const permissions = inspection.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error("grok copresence inspect is missing permissions metadata");
  }
  const record = permissions as Record<string, unknown>;
  if (!Array.isArray(record.sources)) {
    throw new Error("grok copresence inspect is missing permission sources");
  }
  const allowedRoot = resolve(isolatedGrokHome);
  for (const source of record.sources) {
    // Grok 0.2.93 annotates these strings, for example
    // `/path/config.toml (config)`. Strip only that trailing display label
    // before applying the filesystem boundary check.
    const sourcePath = typeof source === "string"
      ? source.match(/^(.*?)(?: \([^)]+\))?$/)?.[1]
      : undefined;
    if (!sourcePath || !isAbsolute(sourcePath)) {
      throw new Error("grok copresence inspect contains an unknown permission source");
    }
    const candidate = resolve(sourcePath);
    if (candidate !== allowedRoot && !candidate.startsWith(`${allowedRoot}/`)) {
      throw new Error(
        `grok copresence refuses external permission source ${candidate}; approvals must stay human-owned`,
      );
    }
  }
  // `inspect` intentionally does not expose rule actions. In 0.2.93 both an
  // allow and a deny rule appear only as loaded > 0, so accepting any loaded
  // rule could silently accept a per-tool preauthorization. The runtime adds
  // its own deny flags after this audit; the isolated home itself must be
  // rule-free.
  if (!Number.isSafeInteger(record.loaded) || record.loaded !== 0 || record.sources.length !== 0) {
    throw new Error("grok copresence refuses preloaded permission rules; approvals must stay human-owned");
  }
  if (!Array.isArray(record.skipped) || record.skipped.length !== 0) {
    throw new Error("grok copresence inspect reports skipped or unknown permission rules");
  }
  for (const field of ["mcpServerAllowlist", "marketplaceAllowlist"] as const) {
    if (!Array.isArray(record[field]) || record[field].length !== 0) {
      throw new Error(`grok copresence refuses nonempty ${field}`);
    }
  }
  if (!Array.isArray(inspection.mcpServers) || inspection.mcpServers.length !== 0) {
    throw new Error("grok copresence refuses discovered MCP servers; A2 keeps MCP outside the TUI");
  }
  if (!Array.isArray(inspection.lspServers) || inspection.lspServers.length !== 0) {
    throw new Error("grok copresence refuses discovered LSP servers");
  }
  if (!Array.isArray(inspection.plugins) || inspection.plugins.length !== 0) {
    throw new Error("grok copresence refuses discovered plugins");
  }
  if (!Array.isArray(inspection.agents) || inspection.agents.some((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return true;
    const source = (agent as Record<string, unknown>).source;
    return !source || typeof source !== "object" || Array.isArray(source)
      || (source as Record<string, unknown>).type !== "builtin";
  })) {
    throw new Error("grok copresence refuses discovered non-builtin agents");
  }
  const modeValues = [
    inspection.permissionMode,
    record.mode,
    record.defaultMode,
    record.effectiveMode,
  ].filter((value): value is string => typeof value === "string");
  if (modeValues.some((value) => value.trim().toLowerCase() !== "default")) {
    throw new Error("grok copresence inspect reports an unknown or non-default permission mode");
  }
}

export function grokSessionDirectory(grokHome: string, cwd: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(grokHome, "sessions", encodeURIComponent(resolve(cwd)), sessionId);
}

export function formatNetworkTuiInput(task: GrokCopresenceNetworkTask): string {
  assertEnvelopePart(task.from, "from");
  assertEnvelopePart(task.taskId, "taskId");
  if (task.message.includes("\0")) throw new Error("network task contains a NUL byte");
  const message = task.message.replace(/\r\n?/g, "\n");
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(message)) {
    throw new Error("network task contains terminal control bytes");
  }
  if (/<\/?user_query(?:\s|>)/i.test(message)) {
    throw new Error("network task contains reserved Grok user_query markup");
  }
  const prompt = `[Agent Network/from=${task.from}/task=${task.taskId}] ${message}`;
  if (Buffer.byteLength(prompt, "utf8") > MAX_NETWORK_PROMPT_BYTES) {
    throw new Error(`network task exceeds ${MAX_NETWORK_PROMPT_BYTES} bytes`);
  }
  // Bracketed paste keeps embedded newlines in the editor; the final CR is
  // the only submission key. node-pty writes literal bytes (no key-name parser).
  return `\u001b[200~${prompt}\u001b[201~\r`;
}

export async function openGrokCopresenceRuntime(
  opts: GrokCopresenceOpenOptions,
): Promise<GrokCopresenceRuntimeSession> {
  const runtime = new GrokCopresenceRuntime(opts);
  await runtime.open();
  return runtime;
}

export function grokCopresenceThink(
  session: GrokCopresenceRuntimeSession,
  opts: GrokCopresenceThinkOptions,
): Promise<GrokCopresenceThinkResult> {
  return session.submit(opts);
}

interface PendingTask {
  resolve: (result: GrokCopresenceThinkResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  queued: boolean;
}

interface ApprovalInputAction {
  bytes: Buffer;
  decisive: boolean;
}

/**
 * Return at most one approval-menu decision. Grok 0.2.93 supports direct
 * numeric shortcuts for persistent grants and lets arrows move onto them, so
 * co-presence deliberately exposes only Enter (whose cursor is pinned to
 * allow-once) and Ctrl-C cancellation.
 */
function firstApprovalInputAction(data: Buffer): ApprovalInputAction | null {
  if (!data.length) return null;
  const first = data[0];
  if (first === 0x0d || first === 0x0a || first === 0x03) {
    return { bytes: data.subarray(0, 1), decisive: true };
  }
  return null;
}

function knownComposerNavigationLength(data: Buffer): number {
  if (data.length >= 3 && data[0] === 0x1b && data[1] === 0x4f) {
    return "ABCDHF".includes(String.fromCharCode(data[2])) ? 3 : 0;
  }
  if (data.length < 3 || data[0] !== 0x1b || data[1] !== 0x5b) return 0;
  const limit = Math.min(data.length, 16);
  for (let index = 2; index < limit; index++) {
    const byte = data[index];
    if (byte < 0x40 || byte > 0x7e) continue;
    const final = String.fromCharCode(byte);
    const params = data.subarray(2, index).toString("ascii");
    if ("ABCDHF".includes(final)) return index + 1;
    if (final === "~" && /^(?:1|3|4|5|6|7|8)(?:;\d+)*$/.test(params)) return index + 1;
    return 0;
  }
  return 0;
}

class GrokCopresenceRuntime implements GrokCopresenceRuntimeSession {
  readonly sessionId: string;
  readonly leaderSocket: string;
  readonly attachSocket: string;

  private arbitration = newGrokCopresenceState();
  private logState: GrokJsonlState = newGrokJsonlState();
  private pty: GrokPtyLike | null = null;
  private ptyExit: Promise<void> | null = null;
  private attach: GrokAttachServer | null = null;
  private locks: LifetimeLock[] = [];
  private chatTail: SafeJsonlTail | null = null;
  private eventsTail: SafeJsonlTail | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleBuffer = "";
  private recoveryLifecycleBuffer = "";
  private recoveryUnsafeApprovalMode = false;
  private completionPendingSince = 0;
  private lastChatActivityAt = 0;
  private humanDecoder = new StringDecoder("utf8");
  private humanPasteMode = false;
  private composerPending = Buffer.alloc(0);
  private humanComposerAudit = "";
  private humanComposerAuditTainted = false;
  private humanComposerAuditOverflow = false;
  private humanComposerSawSlash = false;
  private humanComposerLeadingSlash = false;
  private pending = new Map<string, PendingTask>();
  private deferredHuman: Buffer[] = [];
  private deferredHumanBytes = 0;
  private closing = false;
  private recovering = false;
  private opened = false;
  private fatalError: Error | null = null;
  private fatalShutdownPromise: Promise<void> | null = null;
  private retainLocksForUnconfirmedPty = false;
  private ownedLeader: OwnedGrokLeaderIdentity | null = null;
  private leaderTeardownPromise: Promise<void> | null = null;
  private leaderOwnerNonce = "";
  private quarantinedNetworkTaskId = "";
  private approvalDecisionDispatched = false;
  private activePermissionRequestId: string | null = null;
  private spawnEnv: NodeJS.ProcessEnv;
  private readonly controlledSpawnEnv: NodeJS.ProcessEnv;
  private ptyGeneration = 0;
  private recoveryPromise: Promise<void> | null = null;

  private readonly log: (message: string) => void;
  private readonly warn: (message: string) => void;
  private tuiReadinessBuffer = "";
  private tuiReady = false;

  constructor(private readonly opts: GrokCopresenceOpenOptions) {
    this.sessionId = opts.sessionId || randomUUID();
    this.leaderSocket = opts.leaderSocket;
    this.attachSocket = opts.attachSocket;
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ?? (() => {});
    this.controlledSpawnEnv = projectGrokChildEnv(opts.env);
    this.spawnEnv = projectGrokChildEnv(opts.env, this.controlledSpawnEnv);
  }

  get isRunning(): boolean {
    return this.opened && !this.closing && !this.recovering && this.pty !== null;
  }

  get state(): GrokCopresenceState {
    return snapshotGrokCopresenceState(this.arbitration);
  }

  async open(): Promise<void> {
    if (this.opened) return;
    if (process.platform !== "linux") {
      throw new Error("grok co-presence preview currently requires Linux PTY, /proc, and Unix sockets");
    }
    assertSessionId(this.sessionId);
    assertSocketPath(this.leaderSocket, "leader");
    assertSocketPath(this.attachSocket, "attach");
    ensurePrivateRuntimeDirectory(dirname(this.leaderSocket));
    ensurePrivateRuntimeDirectory(dirname(this.attachSocket));
    const sessionDir = grokSessionDirectory(this.opts.grokHome, this.opts.cwd, this.sessionId);
    const resume = this.opts.newSession !== true && existsSync(sessionDir);
    if (this.opts.sessionId && this.opts.newSession !== true && !resume) {
      throw new Error(`grok copresence cannot resume missing session ${this.sessionId} for cwd ${this.opts.cwd}`);
    }

    try {
      const flockBinary = this.opts.flockBinary ?? "flock";
      const leaderLockKey = createHash("sha256").update(this.leaderSocket).digest("hex").slice(0, 20);
      const sessionLockDir = join(realpathSync(this.opts.grokHome), "copresence-locks");
      ensurePrivateRuntimeDirectory(sessionLockDir);
      const sessionLockKey = createHash("sha256")
        .update(realpathSync(this.opts.grokHome))
        .update("\0")
        .update(resolve(this.opts.cwd))
        .update("\0")
        .update(this.sessionId)
        .digest("hex")
        .slice(0, 24);
      // A Grok session file tree may have only one PTY writer even if a caller
      // chooses a different leader socket path.
      this.locks.push(await acquireLifetimeLock(
        join(sessionLockDir, `.session-${sessionLockKey}.lock`),
        flockBinary,
        this.opts.env,
      ));
      // The socket-level lock closes the same-socket/different-session race;
      // the tuple lock separately enforces the configured adopt identity.
      this.locks.push(await acquireLifetimeLock(
        join(dirname(this.leaderSocket), `.leader-${leaderLockKey}.lock`),
        flockBinary,
        this.opts.env,
      ));
      assertAbsentSocketPath(this.leaderSocket, "leader");
      this.locks.push(await acquireLifetimeLock(
        join(dirname(this.leaderSocket), `.bridge-${leaderLockKey}-${this.sessionId}.lock`),
        flockBinary,
        this.opts.env,
      ));
      // Resume cursors must be fixed at the audited pre-spawn EOF. Arming
      // after the TUI socket becomes ready would permanently skip any startup
      // turn/permission records appended during spawn.
      this.chatTail = new SafeJsonlTail(
        join(sessionDir, "chat_history.jsonl"),
        "chat_history",
        resume,
      );
      this.eventsTail = new SafeJsonlTail(
        join(sessionDir, "events.jsonl"),
        "events",
        resume,
      );
      if (resume) {
        this.chatTail.arm(true);
        this.eventsTail.arm(true);
        assertSafePersistedGrokSessionForResume(sessionDir);
      }
      await this.spawnTui(resume);
      await waitForOwnedUnixSocket(this.leaderSocket, 10_000);
      await this.bindSpawnedLeader();

      // New sessions start at byte zero. Resume tails were already armed at
      // the pre-spawn EOF above, so startup writes remain unread and visible.
      if (!resume) {
        this.chatTail.arm(false);
        this.eventsTail.arm(false);
      }

      // Startup has no legitimate human/network input yet. Drain both files
      // to one stable boundary, auditing only approval-mode lifecycle. Feeding
      // spawn chatter through the routing reducer could carry an orphan old
      // completion into the first new network task on process-level resume.
      this.recoveryLifecycleBuffer = "";
      this.recoveryUnsafeApprovalMode = false;
      if (!this.chatTail || !this.eventsTail) {
        throw new Error("grok copresence startup lost its JSONL cursors");
      }
      await discardJsonlTailsUntilJointlyStable(
        this.chatTail,
        this.eventsTail,
        (chunk) => this.auditRecoveryLifecycleChunk(chunk),
      );
      if (this.recoveryLifecycleBuffer.trim()) {
        throw new GrokUnsafeRecoveryApprovalError(
          "Grok startup events JSONL ended with an incomplete lifecycle record",
        );
      }
      if (this.recoveryUnsafeApprovalMode) {
        throw new GrokUnsafeRecoveryApprovalError(
          "Grok started in an unsafe automatic-approval mode",
        );
      }
      this.logState = newGrokJsonlState();
      this.lifecycleBuffer = "";

      this.attach = await startGrokAttachServer({
        socketPath: this.attachSocket,
        alias: this.opts.alias,
        sessionId: this.sessionId,
        onInput: (data) => this.onHumanInput(data),
        onResize: (cols, rows) => this.onResize(cols, rows),
        onDetach: () => this.onHumanDetach(),
      });
      this.startPolling();
      this.opened = true;
      await this.opts.onSession?.(this.sessionId);
      this.broadcastState();
      this.log(`[grok-copresence] TUI ready session=${this.sessionId.slice(0, 8)} attach=${this.attachSocket}`);
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  submit(opts: GrokCopresenceThinkOptions): Promise<GrokCopresenceThinkResult> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.opened || this.closing) return Promise.reject(new Error("grok copresence runtime is not running"));
    if (!opts.taskId || !opts.from) return Promise.reject(new Error("grok copresence taskId/from are required"));
    if (
      this.pending.has(opts.taskId)
      || this.arbitration.queue.some((task) => task.taskId === opts.taskId)
      || (this.arbitration.activeTurn?.owner === "network"
        && this.arbitration.activeTurn.task.taskId === opts.taskId)
    ) {
      return Promise.reject(new Error(`duplicate grok copresence task ${opts.taskId}`));
    }

    const task: GrokCopresenceNetworkTask = {
      taskId: opts.taskId,
      from: opts.from,
      message: opts.text,
    };
    const timeoutMs = opts.timeoutMs ?? this.opts.turnTimeoutMs ?? 10 * 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("grok copresence timeout must be a positive finite number"));
    }
    // Validate before it enters a durable queue.
    formatNetworkTuiInput(task);
    const wasBusy = this.arbitration.phase !== "idle" || this.arbitration.queue.length > 0;
    this.transition({ type: "network_task_received", task });

    return new Promise<GrokCopresenceThinkResult>((resolveTask, rejectTask) => {
      const timer = setTimeout(() => {
        this.pending.delete(opts.taskId);
        // A queued timeout must never execute later. An already-active turn
        // cannot be cancelled safely: it may have side effects, so retain the
        // active boundary until its real turn_ended event arrives.
        this.transition({ type: "network_task_cancelled", taskId: opts.taskId });
        rejectTask(new Error(`grok copresence task ${opts.taskId} timed out after ${timeoutMs}ms`));
        // Do NOT mark the TUI idle here. The shared turn may still be running;
        // its eventual turn_ended event is the only safe scheduling boundary.
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(opts.taskId, {
        resolve: resolveTask,
        reject: rejectTask,
        timer,
        queued: wasBusy,
      });
      // Yield one event-loop turn so a human key already readable on the
      // attach socket can claim the composer before network injection.
      setImmediate(() => this.scheduleNetworkIfIdle());
      this.broadcastState();
      if (wasBusy) this.log(`[grok-copresence] queued network task ${opts.taskId}`);
    });
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.fatalShutdownPromise?.catch(() => {});
      return;
    }
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const [taskId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`grok copresence runtime closed while task ${taskId} was pending`));
    }
    this.pending.clear();
    await this.attach?.close().catch(() => {});
    this.attach = null;
    await this.recoveryPromise?.catch(() => {});
    const pty = this.pty;
    const ptyExit = this.ptyExit;
    this.pty = null;
    this.ptyExit = null;
    this.tuiReady = false;
    this.tuiReadinessBuffer = "";
    this.ptyGeneration += 1;
    await terminateOwnedPty(pty, ptyExit).catch((error) => {
      this.retainLocksForUnconfirmedPty = true;
      this.warn(`[grok-copresence] PTY termination failed: ${errorMessage(error)}`);
    });
    await this.teardownOwnedLeader().catch((error) => {
      this.retainLocksForUnconfirmedPty = true;
      this.warn(`[grok-copresence] retaining locks: ${errorMessage(error)}`);
    });
    if (!this.retainLocksForUnconfirmedPty) {
      for (const lock of this.locks.reverse()) await lock.release().catch(() => {});
      this.locks = [];
    }
    this.opened = false;
  }

  private async spawnTui(resume: boolean): Promise<void> {
    try {
      const refreshedEnv = await this.opts.beforeSpawn?.({ resume });
      if (refreshedEnv) {
        this.spawnEnv = projectGrokChildEnv(refreshedEnv, this.controlledSpawnEnv);
      }
    } catch (error) {
      throw new GrokSpawnAuditError(`grok copresence pre-spawn audit failed: ${errorMessage(error)}`);
    }
    if (
      resolve(String(this.spawnEnv.GROK_HOME || "")) !== resolve(this.opts.grokHome)
      || resolve(String(this.spawnEnv.HOME || "")) !== resolve(this.opts.grokHome)
    ) {
      throw new GrokSpawnAuditError("grok copresence spawn audit returned an unexpected HOME/GROK_HOME");
    }
    try {
      assertGrokCopresenceAgentProfile(this.opts.agentProfile, this.opts.grokHome);
    } catch (error) {
      throw new GrokSpawnAuditError(`grok copresence agent profile audit failed: ${errorMessage(error)}`);
    }
    const generation = ++this.ptyGeneration;
    this.leaderOwnerNonce = randomUUID();
    this.tuiReady = false;
    this.tuiReadinessBuffer = "";
    const binary = this.opts.binary ?? "grok";
    const args = buildGrokCopresenceArgs({
      cwd: this.opts.cwd,
      sessionId: this.sessionId,
      resume,
      leaderSocket: this.leaderSocket,
      model: this.opts.model,
      agentProfile: this.opts.agentProfile,
      maxTurns: this.opts.maxTurns,
      alwaysApprove: this.opts.alwaysApprove,
      toolAllowlist: this.opts.toolAllowlist,
      sandboxProfile: this.opts.sandboxProfile,
      protectedPaths: this.opts.protectedPaths,
    });
    const ptySpawn = this.opts.ptySpawn ?? defaultPtySpawn;
    const pty = await ptySpawn(binary, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 36,
      cwd: this.opts.cwd,
      env: buildGrokPtyEnv(
        this.spawnEnv,
        this.controlledSpawnEnv,
        this.opts.cwd,
        "xterm-256color",
        this.opts.sandboxProfile,
        this.leaderOwnerNonce,
      ),
    });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolvePtyExit) => { resolveExit = resolvePtyExit; });
    this.pty = pty;
    this.ptyExit = exitPromise;
    pty.onData((data) => {
      if (generation !== this.ptyGeneration || this.closing) return;
      this.observeTuiReadiness(generation, data);
      this.attach?.broadcastOutput(data);
    });
    pty.onExit((event) => {
      resolveExit();
      if (generation !== this.ptyGeneration || this.closing) return;
      this.tuiReady = false;
      this.tuiReadinessBuffer = "";
      this.pty = null;
      this.ptyExit = null;
      const recovery = this.recoverFromExit(event);
      this.recoveryPromise = recovery;
      const clearRecovery = () => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      };
      void recovery.then(clearRecovery, (error) => {
        clearRecovery();
        this.warn(`[grok-copresence] recovery failed: ${errorMessage(error)}`);
      });
    });
  }

  private async recoverFromExit(event: { exitCode: number; signal?: number }): Promise<void> {
    if (this.recovering || this.closing) return;
    this.recovering = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.transition({ type: "disconnected" });
    this.warn(`[grok-copresence] TUI exited code=${event.exitCode} signal=${event.signal ?? "-"}; resuming same session`);
    if (this.arbitration.waitingHuman) {
      await this.failFatal(new Error(
        "grok TUI exited while a human approval was pending; refusing resume into an ambiguous permission UI",
      ));
      return;
    }
    try {
      // Grok 0.2.93 deliberately keeps its auto-Leader alive after the PTY
      // disconnects. A recovery generation must never attach to or race that
      // ambiguous backend: terminate only the identity bound at startup, then
      // resume the same on-disk session through a fresh Leader generation.
      await this.teardownOwnedLeader();
    } catch (error) {
      this.retainLocksForUnconfirmedPty = true;
      await this.failFatal(new Error(
        `Grok Leader death was not confirmed; refusing recovery: ${errorMessage(error)}`,
      ));
      return;
    }
    const attempts = Math.max(1, this.opts.reconnectAttempts ?? 3);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts && !this.closing; attempt++) {
      try {
        if (this.closing) return;
        await delay(Math.min(1_000, attempt * 250));
        if (this.closing) return;
        await this.spawnTui(true);
        // Bind the generation before consulting `closing`. close() waits for
        // this recovery promise; returning with an unbound auto-Leader would
        // otherwise leave no exact identity for the stop path to terminate.
        await waitForOwnedUnixSocket(this.leaderSocket, 10_000);
        await this.bindSpawnedLeader();
        if (this.closing) {
          const closingPty = this.pty;
          const closingExit = this.ptyExit;
          this.pty = null;
          this.ptyExit = null;
          this.ptyGeneration += 1;
          await terminateOwnedPty(closingPty, closingExit);
          await this.teardownOwnedLeader();
          return;
        }
        // No routing is allowed across a PTY generation boundary. Drain any
        // late records from the dead writer and resume-startup chatter to a
        // stable EOF, then reset all semantic correlation before scheduling.
        this.recoveryLifecycleBuffer = "";
        this.recoveryUnsafeApprovalMode = false;
        if (!this.chatTail || !this.eventsTail) {
          throw new Error("grok copresence recovery lost its JSONL cursors");
        }
        await discardJsonlTailsUntilJointlyStable(
          this.chatTail,
          this.eventsTail,
          (chunk) => this.auditRecoveryLifecycleChunk(chunk),
        );
        if (this.recoveryLifecycleBuffer.trim()) {
          throw new GrokUnsafeRecoveryApprovalError(
            "Grok events JSONL ended with an incomplete lifecycle record during recovery",
          );
        }
        if (this.recoveryUnsafeApprovalMode) {
          throw new GrokUnsafeRecoveryApprovalError(
            "Grok resumed in an unsafe automatic-approval mode",
          );
        }
        this.logState = newGrokJsonlState();
        this.lifecycleBuffer = "";
        this.approvalDecisionDispatched = false;
        this.activePermissionRequestId = null;
        this.resetHumanComposerAudit();
        this.completionPendingSince = 0;
        this.lastChatActivityAt = 0;
        const recoveryFrom = this.arbitration.recoveryFrom;
        this.transition({ type: "reconnected" });
        this.recovering = false;
        this.startPolling();

        // An interrupted turn is never replayed automatically: it could have
        // performed side effects before the PTY died. Fail that one task, then
        // continue the FIFO on the resumed session.
        if (recoveryFrom === "network_turn" && this.arbitration.activeTurn?.owner === "network") {
          const task = this.arbitration.activeTurn.task;
          this.failPending(task.taskId, new Error(
            `grok TUI restarted during task ${task.taskId}; task was not replayed to avoid duplicate side effects`,
          ));
          unregisterOwnedNetworkTask(this.logState, task.taskId);
          this.transition({ type: "turn_completed", owner: "network" });
        } else if (recoveryFrom === "human_turn") {
          this.transition({ type: "turn_completed", owner: "human" });
        } else if (recoveryFrom === "human_editing") {
          this.transition({ type: "human_input_cancelled" });
        }
        this.replayDeferredHumanOrSchedule();
        this.log(`[grok-copresence] resumed session after PTY restart (attempt ${attempt})`);
        return;
      } catch (error) {
        lastError = error;
        const failedPty = this.pty;
        const failedExit = this.ptyExit;
        this.pty = null;
        this.ptyExit = null;
        this.ptyGeneration += 1;
        try {
          await terminateOwnedPty(failedPty, failedExit);
        } catch (terminationError) {
          this.retainLocksForUnconfirmedPty = true;
          await this.failFatal(new Error(
            `Grok PTY death was not confirmed; refusing another TUI spawn: ${errorMessage(terminationError)}`,
          ));
          return;
        }
        try {
          await this.teardownOwnedLeader();
        } catch (terminationError) {
          this.retainLocksForUnconfirmedPty = true;
          await this.failFatal(new Error(
            `Grok Leader death was not confirmed; refusing another TUI spawn: ${errorMessage(terminationError)}`,
          ));
          return;
        }
        if (error instanceof GrokSpawnAuditError || error instanceof GrokUnsafeRecoveryApprovalError) {
          await this.failFatal(asError(error));
          return;
        }
        this.warn(`[grok-copresence] resume attempt ${attempt}/${attempts} failed: ${errorMessage(error)}`);
      }
    }
    if (this.closing) return;
    await this.failFatal(new Error(`grok copresence could not resume session: ${errorMessage(lastError)}`));
  }

  private failFatal(error: Error): Promise<void> {
    if (this.fatalShutdownPromise) return this.fatalShutdownPromise;
    if (this.fatalError) return Promise.resolve();
    this.fatalError = error;
    this.closing = true;
    this.recovering = false;
    this.opened = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.chatTail = null;
    this.eventsTail = null;
    this.attach?.broadcastStatus({ ...this.attachStatus(), fatal: error.message });
    for (const taskId of [...this.pending.keys()]) this.failPending(taskId, error);
    this.fatalShutdownPromise = (async () => {
      const pty = this.pty;
      const ptyExit = this.ptyExit;
      this.pty = null;
      this.ptyExit = null;
      this.tuiReady = false;
      this.tuiReadinessBuffer = "";
      this.ptyGeneration += 1;
      await terminateOwnedPty(pty, ptyExit).catch(() => {
        this.retainLocksForUnconfirmedPty = true;
      });
      await this.teardownOwnedLeader().catch(() => {
        this.retainLocksForUnconfirmedPty = true;
      });
      await this.attach?.close().catch(() => {});
      this.attach = null;
      if (!this.retainLocksForUnconfirmedPty) {
        for (const lock of this.locks.reverse()) await lock.release().catch(() => {});
        this.locks = [];
      }
    })();
    return this.fatalShutdownPromise;
  }

  private async bindSpawnedLeader(): Promise<void> {
    if (!this.leaderOwnerNonce) {
      this.retainLocksForUnconfirmedPty = true;
      throw new Error("Grok Leader generation marker was not initialized");
    }
    try {
      this.ownedLeader = await captureOwnedGrokLeader({
        generation: this.ptyGeneration,
        binary: this.opts.binary ?? "grok",
        binaryPathEnv: String(this.spawnEnv.PATH || "/usr/local/bin:/usr/bin:/bin"),
        leaderSocket: this.leaderSocket,
        grokHome: this.opts.grokHome,
        sandboxProfile: this.opts.sandboxProfile,
        ownerNonce: this.leaderOwnerNonce,
        expectedParentPid: String(this.controlledSpawnEnv.ANET_EXPECTED_PARENT_PID || ""),
      });
    } catch (error) {
      // The socket exists but could not be bound to exactly one process. Do
      // not guess which PID to terminate or release the lifetime locks.
      this.retainLocksForUnconfirmedPty = true;
      throw error;
    }
  }

  private teardownOwnedLeader(): Promise<void> {
    if (this.leaderTeardownPromise) return this.leaderTeardownPromise;
    const identity = this.ownedLeader;
    if (!identity) return Promise.resolve();
    const teardown = terminateOwnedGrokLeader(identity).then(() => {
      if (this.ownedLeader === identity) this.ownedLeader = null;
      if (this.leaderOwnerNonce === identity.ownerNonce) this.leaderOwnerNonce = "";
    });
    let finalized!: Promise<void>;
    finalized = teardown.finally(() => {
      if (this.leaderTeardownPromise === finalized) this.leaderTeardownPromise = null;
    });
    this.leaderTeardownPromise = finalized;
    return this.leaderTeardownPromise;
  }

  private onHumanInput(data: Buffer): void {
    if (!data.length || this.closing) return;
    if (!this.pty) {
      this.deferHumanInput(data);
      return;
    }

    if (this.arbitration.waitingHuman) {
      if (!this.activePermissionRequestId) {
        void this.failFatal(new Error("grok copresence approval input had no correlated request_id"));
        return;
      }
      // Only one verified menu-key action may cross per attach frame. A direct
      // numeric shortcut resolves without Enter in Grok 0.2.93, so the rest of
      // that frame is dropped, never deferred into the later composer.
      if (this.approvalDecisionDispatched) {
        this.attach?.broadcastStatus({
          ...this.attachStatus(),
          warning: "approval decision is pending; additional input was dropped",
        });
        return;
      }
      const action = firstApprovalInputAction(data);
      if (!action) {
        this.attach?.broadcastStatus({
          ...this.attachStatus(),
          warning: "unsupported approval input was dropped; co-presence permits only Enter (allow once) or Ctrl-C",
        });
        return;
      }
      this.writeHumanBytes(action.bytes);
      if (action.decisive) this.approvalDecisionDispatched = true;
      if (action.bytes.length < data.length) {
        this.attach?.broadcastStatus({
          ...this.attachStatus(),
          warning: "only one approval key is accepted per input frame; trailing input was dropped",
        });
      }
      return;
    }

    this.processComposerInput(data);
  }

  private processComposerInput(data: Buffer): void {
    const input = this.composerPending.length
      ? Buffer.concat([this.composerPending, data])
      : data;
    this.composerPending = Buffer.alloc(0);
    const pasteStart = Buffer.from("\x1b[200~", "binary");
    const pasteEnd = Buffer.from("\x1b[201~", "binary");
    let offset = 0;
    while (offset < input.length) {
      if (
        this.arbitration.phase === "network_turn"
        || this.arbitration.phase === "human_turn"
        || this.arbitration.phase === "recovering"
      ) {
        this.deferHumanInput(input.subarray(offset));
        return;
      }
      // Grok 0.2.93 exposes two direct mode toggles outside the permission
      // dialog. They cannot reach the sole TUI: user-level requirements.toml
      // is not an enforcement boundary in this version.
      if (input[offset] === 0x0f) { // Ctrl+O: always-approve toggle
        offset += 1;
        this.warnBlockedAutoApproval("Ctrl+O");
        continue;
      }
      if (input.subarray(offset, offset + 3).equals(Buffer.from("\x1b[Z", "binary"))) {
        offset += 3; // Shift+Tab cycles Normal -> Plan -> Always-approve.
        this.warnBlockedAutoApproval("Shift+Tab");
        continue;
      }

      if (input[offset] === 0x1b) {
        const remainder = input.subarray(offset);
        const isPartialPasteSequence = remainder.length < pasteStart.length
          && (pasteStart.subarray(0, remainder.length).equals(remainder)
            || pasteEnd.subarray(0, remainder.length).equals(remainder));
        if (isPartialPasteSequence) {
          this.composerPending = Buffer.from(remainder);
          return;
        }
        if (remainder.subarray(0, pasteStart.length).equals(pasteStart)) {
          if (this.arbitration.phase === "idle") this.transition({ type: "human_input_started" });
          this.writeHumanBytes(pasteStart);
          this.humanPasteMode = true;
          offset += pasteStart.length;
          continue;
        }
        if (remainder.subarray(0, pasteEnd.length).equals(pasteEnd)) {
          this.writeHumanBytes(pasteEnd);
          this.humanPasteMode = false;
          offset += pasteEnd.length;
          continue;
        }
        if (!this.humanPasteMode) {
          const navigationLength = knownComposerNavigationLength(remainder);
          if (navigationLength > 0) {
            if (this.humanComposerSawSlash) {
              this.writeHumanBytes(Buffer.from("\x03", "binary"));
              this.resetHumanComposerAudit();
              if (this.arbitration.phase === "human_editing") {
                this.transition({ type: "human_input_cancelled" });
              }
              this.warnBlockedAutoApproval("editor navigation after slash input");
              this.scheduleNetworkIfIdle();
              return;
            }
            if (this.arbitration.phase === "idle") this.transition({ type: "human_input_started" });
            this.writeHumanBytes(remainder.subarray(0, navigationLength));
            this.humanComposerAuditTainted = true;
            offset += navigationLength;
            continue;
          }
          // Unknown CSI/SS3/Alt sequences include enhanced keyboard encodings
          // such as CSI-u, which can represent Ctrl+O or a slash without those
          // raw bytes. Never forward them to the policy-owning TUI.
          this.warnBlockedAutoApproval("unknown terminal control sequence");
          return;
        }
      }

      const nextControl = input[offset];
      const unmodelledEditorControl = !this.humanPasteMode
        && nextControl < 0x20
        && ![0x03, 0x08, 0x0a, 0x0d, 0x15].includes(nextControl);
      if (unmodelledEditorControl) {
        offset += 1;
        this.warnBlockedAutoApproval("unknown editor control key");
        continue;
      }
      if (this.arbitration.phase === "idle") this.transition({ type: "human_input_started" });

      const byte = input.subarray(offset, offset + 1);
      const control = input[offset];
      offset += 1;
      const isSubmit = !this.humanPasteMode && (control === 0x0d || control === 0x0a);
      if (isSubmit && this.isForbiddenHumanModeCommand()) {
        // The text is already visible in Grok's editor. Cancel it locally
        // instead of submitting a slash command that would pre-authorize a
        // later network turn.
        this.writeHumanBytes(Buffer.from("\x03", "binary"));
        this.resetHumanComposerAudit();
        if (this.arbitration.phase === "human_editing") {
          this.transition({ type: "human_input_cancelled" });
        }
        this.warnBlockedAutoApproval("slash command");
        if (offset < input.length) {
          // Same-frame bytes are not a new, intentional composer action.
          this.attach?.broadcastStatus({
            ...this.attachStatus(),
            warning: "trailing input after a blocked permission-mode command was dropped",
          });
        }
        this.scheduleNetworkIfIdle();
        return;
      }

      if (control === 0x2f && this.humanComposerAuditTainted) {
        // Once cursor/edit state diverges from the mirror, a slash could be
        // inserted at column zero without being visible to the audit. Drop it.
        this.warnBlockedAutoApproval("slash after unmodelled editor control");
        continue;
      }

      if (isSubmit && this.arbitration.phase === "human_editing") {
        try {
          registerExpectedGrokHumanTurn(this.logState);
        } catch (error) {
          void this.failFatal(asError(error));
          return;
        }
      }
      this.writeHumanBytes(byte);
      this.auditHumanComposerByte(control);
      if (!this.humanPasteMode && control === 0x03 && this.arbitration.phase === "human_editing") {
        this.resetHumanComposerAudit();
        this.transition({ type: "human_input_cancelled" });
        continue;
      }
      if (isSubmit && this.arbitration.phase === "human_editing") {
        this.resetHumanComposerAudit();
        this.transition({ type: "human_input_submitted" });
        if (offset < input.length) this.deferHumanInput(input.subarray(offset));
        return;
      }
    }
    if (this.arbitration.phase === "idle") this.scheduleNetworkIfIdle();
  }

  private auditHumanComposerByte(byte: number): void {
    if (byte === 0x08 || byte === 0x7f) {
      this.humanComposerAudit = this.humanComposerAudit.slice(0, -1);
      if (!this.humanComposerAuditTainted && !this.humanComposerAuditOverflow) {
        this.humanComposerSawSlash = this.humanComposerAudit.includes("/");
        this.humanComposerLeadingSlash = /^\s*\//.test(this.humanComposerAudit);
      }
    } else if (byte === 0x15) {
      this.resetHumanComposerAudit();
    } else if (byte >= 0x20 && byte <= 0x7e) {
      const char = String.fromCharCode(byte);
      if (char === "/") {
        this.humanComposerSawSlash = true;
        if (!this.humanComposerAudit.trim()) this.humanComposerLeadingSlash = true;
      }
      this.humanComposerAudit += char;
      if (this.humanComposerAudit.length > 8_192) {
        this.humanComposerAudit = this.humanComposerAudit.slice(-8_192);
        this.humanComposerAuditOverflow = true;
        this.humanComposerAuditTainted = true;
      }
    }
  }

  private isForbiddenHumanModeCommand(): boolean {
    // Slash palette completion can turn a short prefix plus Enter into
    // `/always-approve`, so filtering only the final literal command is not
    // sufficient. Keep the shared security posture immutable by disabling
    // slash-command submission on this proxy altogether.
    // Navigation/history makes the real editor content unknowable (Up can
    // recall an old `/auto`). A tainted or overflowed composer must be cleared
    // with Ctrl-U/Ctrl-C and retyped before any submit key is accepted.
    return this.humanComposerLeadingSlash || this.humanComposerAuditTainted;
  }

  private resetHumanComposerAudit(): void {
    this.humanComposerAudit = "";
    this.humanComposerAuditTainted = false;
    this.humanComposerAuditOverflow = false;
    this.humanComposerSawSlash = false;
    this.humanComposerLeadingSlash = false;
  }

  private warnBlockedAutoApproval(route: string): void {
    const warning = `${route} was blocked: Grok co-presence keeps approval policy immutable and per-turn`;
    this.warn(`[grok-copresence] ${warning}`);
    this.attach?.broadcastStatus({ ...this.attachStatus(), warning });
  }

  private onResize(cols: number, rows: number): void {
    try { this.pty?.resize(cols, rows); } catch (error) {
      this.warn(`[grok-copresence] resize failed: ${errorMessage(error)}`);
    }
  }

  private writeHumanBytes(data: Buffer): void {
    if (!this.pty || !data.length) return;
    const text = this.humanDecoder.write(data);
    if (text) this.pty.write(text);
  }

  private onHumanDetach(): void {
    // Bytes belong to the detached terminal and must never be replayed into a
    // later human connection. If its composer was not submitted, clear it in
    // the only PTY and release the network FIFO. Active human/model turns and
    // approvals continue; reconnecting is how the human resumes ownership.
    this.deferredHuman = [];
    this.deferredHumanBytes = 0;
    this.humanDecoder = new StringDecoder("utf8");
    this.humanPasteMode = false;
    this.composerPending = Buffer.alloc(0);
    this.resetHumanComposerAudit();
    if (this.arbitration.phase === "human_editing") {
      try { this.pty?.write("\x03"); } catch {}
      this.transition({ type: "human_input_cancelled" });
      this.scheduleNetworkIfIdle();
    }
    this.broadcastState();
  }

  private deferHumanInput(data: Buffer): void {
    if (this.deferredHumanBytes + data.length > MAX_DEFERRED_HUMAN_BYTES) {
      this.attach?.broadcastStatus({
        ...this.attachStatus(),
        warning: "human input buffer full; further input was dropped",
      });
      return;
    }
    this.deferredHuman.push(Buffer.from(data));
    this.deferredHumanBytes += data.length;
    this.broadcastState();
  }

  private replayDeferredHumanOrSchedule(): void {
    if (this.arbitration.phase !== "idle") return;
    if (this.deferredHuman.length) {
      const buffered = Buffer.concat(this.deferredHuman, this.deferredHumanBytes);
      this.deferredHuman = [];
      this.deferredHumanBytes = 0;
      this.onHumanInput(buffered);
    }
    if (this.arbitration.phase === "idle") this.scheduleNetworkIfIdle();
  }

  private observeTuiReadiness(generation: number, data: string): void {
    if (generation !== this.ptyGeneration || this.tuiReady || this.closing) return;
    this.tuiReadinessBuffer = `${this.tuiReadinessBuffer}${data}`
      .slice(-MAX_TUI_READINESS_BUFFER);
    if (!hasGrokTuiReadyMarker(this.tuiReadinessBuffer)) return;

    this.tuiReady = true;
    this.tuiReadinessBuffer = "";
    this.log(`[grok-copresence] TUI input ready generation=${generation}`);
    this.broadcastState();
    if (!this.recovering) setImmediate(() => this.scheduleNetworkIfIdle());
  }

  private scheduleNetworkIfIdle(): void {
    if (!this.pty || !this.tuiReady || this.recovering || this.closing) return;
    const transition = this.transition({ type: "schedule_network" });
    for (const effect of transition.effects) {
      if (effect.type !== "inject_network_task") continue;
      try {
        registerOwnedNetworkTask(this.logState, {
          from: effect.task.from,
          taskId: effect.task.taskId,
        });
        this.pty.write(formatNetworkTuiInput(effect.task));
        this.log(`[grok-copresence] injected network task ${effect.task.taskId} from=${effect.task.from}`);
      } catch (error) {
        unregisterOwnedNetworkTask(this.logState, effect.task.taskId);
        this.failPending(effect.task.taskId, asError(error));
        this.transition({ type: "turn_completed", owner: "network" });
        setImmediate(() => this.replayDeferredHumanOrSchedule());
      }
    }
  }

  private pollLogs(): void {
    if (this.closing) return;
    try {
      // Always consume chat first. If events wins a filesystem flush race,
      // the reducer retains pending completion until the next assistant line.
      this.chatTail?.poll(
        (chunk) => this.reduceLogChunk("chat_history", chunk),
        () => this.resetLogFraming("chat_history"),
      );
      this.eventsTail?.poll((chunk) => {
        this.reduceLogChunk("events", chunk);
        this.reduceLifecycleChunk(chunk);
      }, () => this.resetLogFraming("events"));
      this.flushSettledCompletion();
    } catch (error) {
      const fatal = new Error(`grok copresence lost its trusted JSONL tail: ${errorMessage(error)}`);
      this.warn(`[grok-copresence] ${fatal.message}`);
      void this.failFatal(fatal);
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.closing) return;
    this.pollTimer = setInterval(
      () => this.pollLogs(),
      Math.max(25, this.opts.pollIntervalMs ?? 100),
    );
    this.pollTimer.unref?.();
  }

  private reduceLogChunk(source: GrokJsonlSource, chunk: string): void {
    if (source === "chat_history" && chunk) this.lastChatActivityAt = Date.now();
    const result = reduceGrokJsonlChunk(this.logState, source, chunk);
    this.logState = result.state;
    for (const event of result.events) this.handleLogEvent(event);
  }

  private flushSettledCompletion(): void {
    if (!this.completionPendingSince) return;
    const now = Date.now();
    if (
      now - this.completionPendingSince < COMPLETION_CHAT_SETTLE_MS
      || now - this.lastChatActivityAt < COMPLETION_CHAT_SETTLE_MS
    ) return;
    const result = flushPendingGrokNetworkReply(this.logState);
    this.logState = result.state;
    if (result.events.length) this.completionPendingSince = 0;
    for (const event of result.events) this.handleLogEvent(event);
  }

  private resetLogFraming(source: GrokJsonlSource): void {
    this.logState.partialLines[source] = "";
    this.logState.droppingOversizedLine[source] = false;
    if (source === "events") this.lifecycleBuffer = "";
    this.warn(`[grok-copresence] ${source} JSONL was rotated/truncated; reset line framing`);
  }

  private handleLogEvent(event: GrokLogEvent): void {
    switch (event.kind) {
      case "human_user":
        this.completionPendingSince = 0;
        if (this.arbitration.activeTurn?.owner === "network") {
          const taskId = this.arbitration.activeTurn.task.taskId;
          this.warn(`[grok-copresence] user log lost trusted network correlation for task=${taskId}`);
          this.failPending(taskId, new Error("Grok user log did not preserve the trusted network envelope"));
          unregisterOwnedNetworkTask(this.logState, taskId);
          // Quarantine the sole TUI until its real completion signal. Releasing
          // the arbiter here could inject another task into the still-live turn.
          this.quarantinedNetworkTaskId = taskId;
          return;
        }
        if (this.arbitration.phase === "idle") {
          this.transition({ type: "human_input_started" });
          this.transition({ type: "human_input_submitted" });
        } else if (this.arbitration.phase === "human_editing") {
          this.transition({ type: "human_input_submitted" });
        }
        // An unowned network-looking prefix is never trusted as human A2
        // delegation input; only an actual bridge-registered task may route it.
        if (!event.unownedNetworkEnvelope) {
          void Promise.resolve(this.opts.onHumanPrompt?.(event.query)).catch((error) =>
            this.warn(`[grok-copresence] human delegation callback failed: ${errorMessage(error)}`));
        }
        return;

      case "network_user": {
        this.completionPendingSince = this.logState.activeTurn?.pendingCompletion
          ? (this.completionPendingSince || Date.now())
          : 0;
        const active = this.arbitration.activeTurn;
        if (active?.owner !== "network" || active.task.taskId !== event.task.taskId) {
          this.warn(`[grok-copresence] dropped mismatched network user log task=${event.task.taskId}`);
        }
        return;
      }

      case "network_reply":
        this.completionPendingSince = 0;
        this.finishNetwork(event.task.taskId, event.text);
        return;

      case "turn_completed":
        if (event.status === "completed" && this.hasUnresolvedApproval()) {
          void this.failFatal(new Error(
            "grok copresence turn completed while a human approval was still unresolved",
          ));
          return;
        }
        if (event.origin === "human") {
          if (
            this.quarantinedNetworkTaskId
            && this.arbitration.activeTurn?.owner === "network"
            && this.arbitration.activeTurn.task.taskId === this.quarantinedNetworkTaskId
          ) {
            this.quarantinedNetworkTaskId = "";
            this.transition({ type: "turn_completed", owner: "network" });
          } else {
            this.transition({ type: "turn_completed", owner: "human" });
          }
          setImmediate(() => this.replayDeferredHumanOrSchedule());
        } else if (event.origin === "network" && event.task && event.status !== "completed") {
          this.failNetwork(event.task.taskId, new Error(
            `grok copresence turn ${event.status} (${event.completion.discriminator ?? "turn_ended"})`,
          ));
        }
        return;

      case "turn_abandoned":
        if (event.origin === "network" && event.task) {
          this.failNetwork(event.task.taskId, new Error("grok copresence saw a new user turn before network completion"));
        }
        return;

      case "malformed":
        this.warn(`[grok-copresence] ignored malformed ${event.source} JSONL (${event.reason})`);
        return;

      case "completion_pending_reply":
        this.completionPendingSince ||= Date.now();
        return;
    }
  }

  private reduceLifecycleChunk(chunk: string): void {
    let buffered = this.lifecycleBuffer + chunk;
    this.lifecycleBuffer = "";
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line || Buffer.byteLength(line, "utf8") > MAX_LIFECYCLE_LINE_BYTES) continue;
      let event: {
        type?: unknown;
        enabled?: unknown;
        phase?: unknown;
        request_id?: unknown;
        requestId?: unknown;
        tool_name?: unknown;
        toolName?: unknown;
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event?.type === "permission_requested") {
        const requestId = lifecyclePermissionIdentity(event);
        if (!requestId) {
          void this.failFatal(new Error("grok copresence permission request lacked a trusted identity"));
          return;
        }
        if (this.activePermissionRequestId) {
          if (this.activePermissionRequestId !== requestId) {
            void this.failFatal(new Error(
              "grok copresence observed overlapping permission request IDs",
            ));
            return;
          }
          // Duplicate delivery of the same request must not reopen the input
          // gate after an Enter/Ctrl-C decision has already been dispatched.
          continue;
        }
        const transition = this.transition({ type: "approval_requested" });
        if (!transition.accepted) {
          void this.failFatal(new Error("grok copresence could not correlate a permission request to the active turn"));
          return;
        }
        this.activePermissionRequestId = requestId;
        this.approvalDecisionDispatched = false;
        if (this.deferredHuman.length) {
          // Pre-approval keystrokes are never consent. Drop them instead of
          // replaying a stale Enter into a newly visible prompt.
          this.deferredHuman = [];
          this.deferredHumanBytes = 0;
          this.humanDecoder = new StringDecoder("utf8");
          this.attach?.broadcastStatus({
            ...this.attachStatus(),
            warning: "input typed before the approval prompt was discarded",
          });
        }
      } else if (event?.type === "permission_resolved") {
        const requestId = lifecyclePermissionIdentity(event);
        if (
          !requestId
          || requestId !== this.activePermissionRequestId
          || !this.approvalDecisionDispatched
        ) {
          void this.failFatal(new Error(
            "grok copresence observed an unowned or automatically resolved permission request",
          ));
          return;
        }
        this.clearApprovalCorrelation();
        this.transition({ type: "approval_resolved_by_human" });
      } else if (event?.type === "permission_rejected" || event?.type === "permission_cancelled") {
        const requestId = lifecyclePermissionIdentity(event);
        // Automatic denial is safe, but it may release this input gate only
        // when it correlates to the currently visible request.
        if (requestId && requestId === this.activePermissionRequestId) {
          this.clearApprovalCorrelation();
          this.transition({ type: "approval_resolved_by_human" });
        }
      } else if (isUnsafeApprovalLifecycleEvent(event)) {
        void this.failFatal(new Error(
          "grok copresence observed an unsafe automatic-approval mode and shut down",
        ));
        return;
      }
    }
    if (Buffer.byteLength(buffered, "utf8") <= MAX_LIFECYCLE_LINE_BYTES) {
      this.lifecycleBuffer = buffered;
    }
  }

  private auditRecoveryLifecycleChunk(chunk: string): void {
    let buffered = this.recoveryLifecycleBuffer + chunk;
    this.recoveryLifecycleBuffer = "";
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LIFECYCLE_LINE_BYTES) {
        throw new GrokUnsafeRecoveryApprovalError("oversized Grok lifecycle record during recovery");
      }
      let event: { type?: unknown; enabled?: unknown; phase?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        throw new GrokUnsafeRecoveryApprovalError("malformed Grok lifecycle record during recovery");
      }
      if (
        event.type === "permission_requested"
        || event.type === "permission_resolved"
        || event.type === "permission_rejected"
        || event.type === "permission_cancelled"
      ) {
        throw new GrokUnsafeRecoveryApprovalError(
          "Grok recovery crossed an unresolved or unaudited permission lifecycle",
        );
      } else if (event.type === "yolo_toggled" && event.enabled === true) {
        // Latch any unsafe transition seen during an unobserved startup or
        // recovery window. A later "off/default" record cannot prove no tool
        // was approved while the permissive mode was active.
        this.recoveryUnsafeApprovalMode = true;
      } else if (event.type === "phase_changed" && typeof event.phase === "string") {
        if (/^(?:always[-_ ]?approve|yolo|auto)$/i.test(event.phase)) {
          this.recoveryUnsafeApprovalMode = true;
        }
      }
    }
    if (Buffer.byteLength(buffered, "utf8") > MAX_LIFECYCLE_LINE_BYTES) {
      throw new GrokUnsafeRecoveryApprovalError("oversized partial Grok lifecycle record during recovery");
    }
    this.recoveryLifecycleBuffer = buffered;
  }

  private finishNetwork(taskId: string, replyText: string): void {
    if (this.hasUnresolvedApproval()) {
      void this.failFatal(new Error(
        "grok copresence refused a network reply that completed without resolving human approval",
      ));
      return;
    }
    const active = this.arbitration.activeTurn;
    if (active?.owner !== "network" || active.task.taskId !== taskId) {
      this.warn(`[grok-copresence] refused reply misroute for task=${taskId}`);
      return;
    }
    this.transition({ type: "turn_completed", owner: "network" });
    const pending = this.pending.get(taskId);
    if (pending) {
      this.pending.delete(taskId);
      clearTimeout(pending.timer);
      pending.resolve({ replyText: replyText.trim(), sessionId: this.sessionId, queued: pending.queued });
    }
    setImmediate(() => this.replayDeferredHumanOrSchedule());
  }

  private failNetwork(taskId: string, error: Error): void {
    const active = this.arbitration.activeTurn;
    if (active?.owner !== "network" || active.task.taskId !== taskId) return;
    this.failPending(taskId, error);
    unregisterOwnedNetworkTask(this.logState, taskId);
    this.transition({ type: "turn_completed", owner: "network" });
    setImmediate(() => this.replayDeferredHumanOrSchedule());
  }

  private failPending(taskId: string, error: Error): void {
    const pending = this.pending.get(taskId);
    if (!pending) return;
    this.pending.delete(taskId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private transition(event: GrokCopresenceEvent) {
    const result = reduceGrokCopresenceState(this.arbitration, event);
    this.arbitration = result.state;
    if (result.accepted && event.type === "turn_completed") this.clearApprovalCorrelation(true);
    if (result.accepted) this.broadcastState();
    return result;
  }

  private clearApprovalCorrelation(_clearSettled = false): void {
    this.activePermissionRequestId = null;
    this.approvalDecisionDispatched = false;
  }

  private hasUnresolvedApproval(): boolean {
    return this.activePermissionRequestId !== null || this.arbitration.waitingHuman;
  }

  private broadcastState(): void {
    this.attach?.broadcastStatus(this.attachStatus());
  }

  private attachStatus(): Record<string, unknown> {
    const active = this.arbitration.activeTurn;
    return {
      version: 1,
      phase: this.arbitration.phase,
      revision: this.arbitration.revision,
      waitingHuman: this.arbitration.waitingHuman,
      tuiReady: this.tuiReady,
      queueLength: this.arbitration.queue.length,
      queuedTaskIds: this.arbitration.queue.slice(0, 16).map((task) => task.taskId),
      active: active?.owner === "network"
        ? { owner: "network", taskId: active.task.taskId, from: active.task.from }
        : active,
      deferredHumanBytes: this.deferredHumanBytes,
    };
  }
}

/**
 * A process-level stop/start has no in-memory approval state. Audit the full,
 * bounded persisted lifecycle before spawning `--resume`; starting first and
 * tailing from EOF would otherwise skip an approval prompt left by the dead
 * process.
 */
function assertSafePersistedGrokSessionForResume(sessionDir: string): void {
  const chatPath = join(sessionDir, "chat_history.jsonl");
  const eventsPath = join(sessionDir, "events.jsonl");
  assertTrustedResumeFile(chatPath, "chat_history", false);

  let buffer = "";
  let activePermission: string | null = null;
  let unsafeApprovalMode = false;
  assertTrustedResumeFile(eventsPath, "events", true, (chunk) => {
    let buffered = buffer + chunk;
    buffer = "";
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LIFECYCLE_LINE_BYTES) {
        throw new Error("grok copresence refuses resume with an oversized lifecycle record");
      }
      let event: {
        type?: unknown;
        enabled?: unknown;
        phase?: unknown;
        request_id?: unknown;
        requestId?: unknown;
        tool_name?: unknown;
        toolName?: unknown;
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        throw new Error("grok copresence refuses resume with malformed events JSONL");
      }
      if (event.type === "permission_requested") {
        const requestId = lifecyclePermissionIdentity(event) || "<anonymous>";
        if (activePermission && activePermission !== requestId) {
          throw new Error("grok copresence refuses resume with overlapping permission requests");
        }
        activePermission = requestId;
      } else if (
        event.type === "permission_resolved"
        || event.type === "permission_rejected"
        || event.type === "permission_cancelled"
      ) {
        const requestId = lifecyclePermissionIdentity(event);
        if (activePermission) {
          if (activePermission !== "<anonymous>" && requestId && requestId !== activePermission) {
            throw new Error("grok copresence refuses resume with mismatched permission lifecycle IDs");
          }
          activePermission = null;
        }
      } else if (event.type === "yolo_toggled" && typeof event.enabled === "boolean") {
        unsafeApprovalMode = event.enabled;
      } else if (event.type === "phase_changed" && typeof event.phase === "string") {
        if (/^(?:always[-_ ]?approve|yolo|auto)$/i.test(event.phase)) unsafeApprovalMode = true;
        else if (/^(?:normal|default|plan)$/i.test(event.phase)) unsafeApprovalMode = false;
      }
    }
    if (Buffer.byteLength(buffered, "utf8") > MAX_LIFECYCLE_LINE_BYTES) {
      throw new Error("grok copresence refuses resume with an oversized partial lifecycle record");
    }
    buffer = buffered;
  });
  if (buffer.trim()) throw new Error("grok copresence refuses resume with an incomplete events record");
  if (activePermission) {
    throw new Error("grok copresence refuses resume while a persisted human approval is unresolved");
  }
  if (unsafeApprovalMode) {
    throw new Error("grok copresence refuses resume from a persisted automatic-approval mode");
  }
}

function assertTrustedResumeFile(
  path: string,
  label: string,
  auditSize: boolean,
  onChunk: (chunk: string) => void = () => {},
): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`grok copresence cannot resume unsafe ${label} JSONL`);
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`grok copresence cannot resume foreign-owned ${label} JSONL`);
  }
  if (auditSize && stat.size > MAX_RESUME_AUDIT_BYTES) {
    throw new Error(`grok copresence refuses to resume ${label} JSONL larger than ${MAX_RESUME_AUDIT_BYTES} bytes`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || opened.size !== stat.size
    ) {
      throw new Error(`grok copresence ${label} JSONL changed during resume audit`);
    }
    if (!auditSize) return;
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    const bytes = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, opened.size)));
    while (offset < opened.size) {
      const read = readSync(fd, bytes, 0, Math.min(bytes.length, opened.size - offset), offset);
      if (read <= 0) throw new Error(`grok copresence could not read complete ${label} JSONL`);
      offset += read;
      const chunk = decoder.write(bytes.subarray(0, read));
      if (chunk) onChunk(chunk);
    }
    const trailing = decoder.end();
    if (trailing) onChunk(trailing);
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`grok copresence ${label} JSONL changed during resume audit`);
    }
  } finally {
    closeSync(fd);
  }
}

class SafeJsonlTail {
  private identity: { dev: number; ino: number } | null = null;
  private offset = 0;
  private readonly uid = process.getuid?.();
  private decoder = new StringDecoder("utf8");

  constructor(
    private readonly path: string,
    readonly source: GrokJsonlSource,
    private readonly startAtEnd: boolean,
  ) {}

  arm(requireExisting = false): void {
    const stat = this.safeStat();
    if (!stat) {
      if (requireExisting) throw new Error(`cannot resume without Grok ${this.source} JSONL`);
      return;
    }
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.offset = this.startAtEnd ? stat.size : 0;
  }

  poll(onChunk: (chunk: string) => void, onReset?: () => void): void {
    const stat = this.safeStat();
    if (!stat) {
      if (this.identity) throw new Error(`Grok ${this.source} JSONL disappeared`);
      return;
    }
    if (!this.identity) {
      this.identity = { dev: stat.dev, ino: stat.ino };
      this.offset = this.startAtEnd ? stat.size : 0;
      if (this.startAtEnd) return;
    }
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || stat.size < this.offset) {
      onReset?.();
      throw new Error(`Grok ${this.source} JSONL was rotated or truncated`);
    }
    const available = stat.size - this.offset;
    if (available <= 0) return;
    const length = Math.min(available, MAX_TAIL_READ_BYTES);
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch (error) {
      // Atomic rotation can remove the inode between lstat and open. Re-poll;
      // every other open error breaks the trusted tail and is fatal upstream.
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error(`unsafe Grok JSONL file: ${this.path}`);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return;
      const bytes = Buffer.allocUnsafe(length);
      const read = readSync(fd, bytes, 0, length, this.offset);
      if (read > 0) {
        this.offset += read;
        const chunk = this.decoder.write(bytes.subarray(0, read));
        if (chunk) onChunk(chunk);
      }
    } finally {
      closeSync(fd);
    }
  }

  recoveryPosition(): { key: string; caughtUp: boolean } {
    const stat = this.safeStat();
    if (!stat) {
      if (this.identity) throw new Error(`Grok ${this.source} JSONL disappeared during recovery`);
      return { key: "missing", caughtUp: true };
    }
    return {
      key: `${stat.dev}:${stat.ino}:${this.offset}:${stat.size}`,
      caughtUp: this.offset === stat.size,
    };
  }

  finishDiscard(onChunk: (chunk: string) => void = () => {}): void {
    const trailing = this.decoder.end();
    this.decoder = new StringDecoder("utf8");
    if (trailing) onChunk(trailing);
  }

  private safeStat(): Stats | null {
    let stat: Stats;
    try { stat = lstatSync(this.path); } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Grok JSONL path is not a regular file: ${this.path}`);
    if (this.uid !== undefined && stat.uid !== this.uid) throw new Error(`Grok JSONL owner mismatch: ${this.path}`);
    return stat;
  }
}

async function discardJsonlTailsUntilJointlyStable(
  chatTail: SafeJsonlTail,
  eventsTail: SafeJsonlTail,
  onEventsChunk: (chunk: string) => void,
  stableMs = 250,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = Date.now();
  let lastKey = "";
  while (Date.now() < deadline) {
    chatTail.poll(() => {});
    eventsTail.poll(onEventsChunk);
    const chat = chatTail.recoveryPosition();
    const events = eventsTail.recoveryPosition();
    const key = `${chat.key}|${events.key}`;
    if (key !== lastKey) {
      lastKey = key;
      stableSince = Date.now();
    }
    if (chat.caughtUp && events.caughtUp && Date.now() - stableSince >= stableMs) {
      chatTail.finishDiscard();
      eventsTail.finishDiscard(onEventsChunk);
      // Recheck after flushing decoder state so an append during the stable
      // decision cannot survive the semantic-state reset below.
      chatTail.poll(() => {});
      eventsTail.poll(onEventsChunk);
      const finalChat = chatTail.recoveryPosition();
      const finalEvents = eventsTail.recoveryPosition();
      const finalKey = `${finalChat.key}|${finalEvents.key}`;
      if (finalKey === key && finalChat.caughtUp && finalEvents.caughtUp) return;
      lastKey = finalKey;
      stableSince = Date.now();
    }
    await delay(25);
  }
  throw new Error("Grok chat/events JSONL did not become jointly stable during recovery");
}

interface LifetimeLock { release(): Promise<void> }

class GrokSpawnAuditError extends Error {}
class GrokUnsafeRecoveryApprovalError extends Error {}

async function acquireLifetimeLock(
  path: string,
  flockBinary: string,
  holderParentEnv: NodeJS.ProcessEnv,
): Promise<LifetimeLock> {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
  let expectedDev = 0;
  let expectedIno = 0;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`copresence lock must be a single-link file: ${path}`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new Error(`copresence lock owner mismatch: ${path}`);
    fchmodSync(fd, 0o600);
    expectedDev = stat.dev;
    expectedIno = stat.ino;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const holder = spawnChild(
    flockBinary,
    [
      "--exclusive", "--nonblock", path,
      process.execPath,
      "-e", "process.stdout.write('LOCKED\\n');process.stdin.resume()",
    ],
    {
      env: buildGrokHelperEnv(holderParentEnv),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    await waitForLock(holder, path);
    const locked = lstatSync(path);
    if (locked.isSymbolicLink() || !locked.isFile()
      || locked.dev !== expectedDev || locked.ino !== expectedIno) {
      throw new Error(`copresence lock identity changed while acquiring: ${path}`);
    }
  } catch (error) {
    try { holder.stdin?.end(); } catch {}
    try { holder.kill("SIGKILL"); } catch {}
    closeSync(fd);
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      holder.stdin?.end();
      await Promise.race([
        new Promise<void>((resolveExit) => holder.once("exit", () => resolveExit())),
        delay(1_000).then(() => { try { holder.kill("SIGKILL"); } catch {} }),
      ]);
      closeSync(fd);
    },
  };
}

function waitForLock(holder: ChildProcess, path: string): Promise<void> {
  return new Promise((resolveLock, rejectLock) => {
    let output = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timed out acquiring copresence lock")), 3_000);
    timer.unref?.();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectLock(error); else resolveLock();
    };
    holder.stdout?.setEncoding("utf8");
    holder.stdout?.on("data", (chunk: string) => {
      output = (output + chunk).slice(-64);
      if (output.includes("LOCKED\n")) finish();
    });
    holder.stderr?.setEncoding("utf8");
    holder.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    holder.once("error", (error) => finish(error));
    holder.once("exit", (code) => {
      if (!settled) finish(new Error(code === 1 && !stderr.trim()
        ? `another Grok copresence bridge already owns this socket/session (${path})`
        : `copresence lock holder exited (${String(code)}) for ${path}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

async function defaultPtySpawn(
  binary: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
): Promise<GrokPtyLike> {
  let nodePty: typeof import("node-pty");
  try { nodePty = await import("node-pty"); } catch {
    throw new Error("grok copresence requires optional dependency node-pty; reinstall @sleep2agi/agent-node");
  }
  return nodePty.spawn(binary, args, options);
}

async function terminateOwnedPty(
  pty: GrokPtyLike | null,
  exit: Promise<void> | null,
): Promise<void> {
  if (!pty) return;
  let exited = false;
  const observedExit = exit?.then(() => { exited = true; });
  try { pty.kill("SIGTERM"); } catch {}
  if (observedExit) {
    await Promise.race([observedExit, delay(1_000)]);
    if (exited) return;
  } else {
    await delay(50);
  }
  try { pty.kill("SIGKILL"); } catch {}
  if (observedExit) {
    await Promise.race([observedExit, delay(1_000)]);
    if (!exited) throw new Error(`Grok PTY pid ${pty.pid} did not exit after SIGKILL`);
  }
}

function ensurePrivateRuntimeDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`Grok copresence runtime directory must be real: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Grok copresence runtime directory owner mismatch: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Grok copresence runtime directory must be mode 0700: ${path}`);
}

function assertAbsentSocketPath(path: string, label: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`${label} socket may not be a symlink: ${path}`);
    throw new Error(`${label} socket path is already in use: ${path}`);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function waitForOwnedUnixSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = lstatSync(path);
      const uid = process.getuid?.();
      if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error(`Grok leader path is not a Unix socket: ${path}`);
      if (uid !== undefined && stat.uid !== uid) throw new Error(`Grok leader socket owner mismatch: ${path}`);
      return;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await delay(50);
  }
  throw new Error(`Grok TUI did not create leader socket within ${timeoutMs}ms: ${path}`);
}

function assertSocketPath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} socket path must be absolute and normalized`);
  if (Buffer.byteLength(path) > UNIX_SOCKET_PATH_MAX_BYTES) throw new Error(`${label} socket path is too long for a Unix socket`);
}

function assertSessionId(sessionId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`invalid Grok session UUID: ${sessionId}`);
  }
}

function assertEnvelopePart(value: string, label: string): void {
  if (
    !value
    || Buffer.byteLength(value) > 256
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || value.includes("]")
    || value.includes("/")
  ) {
    throw new Error(`invalid network ${label}`);
  }
}

function lifecyclePermissionIdentity(event: {
  request_id?: unknown;
  requestId?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
}): string | null {
  const requestId = typeof event.request_id === "string"
    ? event.request_id
    : typeof event.requestId === "string"
      ? event.requestId
      : "";
  if (requestId && Buffer.byteLength(requestId, "utf8") <= 512) return `id:${requestId}`;
  const toolName = typeof event.tool_name === "string"
    ? event.tool_name
    : typeof event.toolName === "string"
      ? event.toolName
      : "";
  return toolName && Buffer.byteLength(toolName, "utf8") <= 512 ? `tool:${toolName}` : null;
}

function isUnsafeApprovalLifecycleEvent(event: {
  type?: unknown;
  enabled?: unknown;
  phase?: unknown;
}): boolean {
  return (event.type === "yolo_toggled" && event.enabled === true)
    || (event.type === "phase_changed"
      && typeof event.phase === "string"
      && /^(?:always[-_ ]?approve|yolo|auto)$/i.test(event.phase));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
