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
  acquireGrokProjectTurnLock,
  cleanupGrokCliPostStopState,
  cleanupGrokCliStoppedTuiGeneration,
} from "../grok-build-cli-home";
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

interface GrokTuiGeneration {
  readonly generation: number;
  readonly pty: GrokPtyLike;
  readonly exit: Promise<void>;
  exited: boolean;
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

export const GROK_COPRESENCE_FAILURE_CODES = [
  "approval_boundary",
  "correlation",
  "input_validation",
  "jsonl_tail",
  "leader_lifecycle",
  "native_outcome",
  "runtime_closed",
  "service_or_model",
  "spawn_audit",
  "timeout",
  "tui_exit",
  "unknown",
] as const;

export type GrokCopresenceFailureCode = typeof GROK_COPRESENCE_FAILURE_CODES[number];

const GROK_COPRESENCE_FAILURE_CODE_SET = new Set<string>(GROK_COPRESENCE_FAILURE_CODES);

/**
 * Direct allowlist of actual synchronous JSONL boundaries. Do not generalize
 * this into a source/stage/reason cartesian product: accepting combinations
 * which no reviewed path emits would turn a mutated value into a valid one.
 * No literal may contain a path, errno body, byte count, cursor/file identity,
 * or process/session/task identifier.
 */
export const GROK_JSONL_TAIL_FAILURE_SUBCODES = Object.freeze([
  "unknown",
  "chat.stat.missing_after_arm",
  "chat.stat.identity_changed",
  "chat.stat.size_regressed",
  "chat.stat.non_regular",
  "chat.stat.owner_mismatch",
  "chat.stat.io_other",
  "chat.open.io_other",
  "chat.fstat.non_regular",
  "chat.fstat.io_other",
  "chat.read.io_other",
  "chat.read.state_invariant",
  "chat.close.io_other",
  "chat.reduce.state_invariant",
  "events.stat.missing_after_arm",
  "events.stat.identity_changed",
  "events.stat.size_regressed",
  "events.stat.non_regular",
  "events.stat.owner_mismatch",
  "events.stat.io_other",
  "events.open.io_other",
  "events.fstat.non_regular",
  "events.fstat.io_other",
  "events.read.io_other",
  "events.read.state_invariant",
  "events.close.io_other",
  "events.reduce.state_invariant",
  "events.lifecycle.state_invariant",
  "combined.flush.state_invariant",
] as const);

export type GrokJsonlTailFailureSubcode = typeof GROK_JSONL_TAIL_FAILURE_SUBCODES[number];
export type GrokCopresenceFailureSubcode = "none" | GrokJsonlTailFailureSubcode;
type GrokJsonlTailBoundarySubcode = Exclude<GrokJsonlTailFailureSubcode, "unknown">;

const GROK_JSONL_TAIL_FAILURE_SUBCODE_SET = new Set<string>(
  GROK_JSONL_TAIL_FAILURE_SUBCODES,
);

function isGrokCopresenceFailureCode(value: unknown): value is GrokCopresenceFailureCode {
  return typeof value === "string" && GROK_COPRESENCE_FAILURE_CODE_SET.has(value);
}

function reviewedGrokJsonlTailFailureSubcode(value: unknown): GrokJsonlTailFailureSubcode {
  return typeof value === "string" && GROK_JSONL_TAIL_FAILURE_SUBCODE_SET.has(value)
    ? value as GrokJsonlTailFailureSubcode
    : "unknown";
}

/**
 * A value-free failure discriminator for package/live gates and operators.
 *
 * The message is still redacted at the existing CLI egress boundary. The code
 * is intentionally a small reviewed enum: diagnostics may persist it, but
 * must never persist the vendor/runtime error body, a digest of that body, or
 * process/session identifiers.
 */
export class GrokCopresenceFailure extends Error {
  readonly failureCode: GrokCopresenceFailureCode;
  readonly failureSubcode!: GrokCopresenceFailureSubcode;

  constructor(
    failureCode: GrokCopresenceFailureCode,
    message: string,
    failureSubcode: unknown = "unknown",
  ) {
    if (!isGrokCopresenceFailureCode(failureCode)) {
      throw new Error("invalid Grok copresence failure code");
    }
    super(message);
    this.name = "GrokCopresenceFailure";
    this.failureCode = failureCode;
    // Keep the subcode out of ordinary Error enumeration. The explicit
    // accessor below revalidates it at every egress, including after a test or
    // caller mutates the JavaScript field despite TypeScript's readonly type.
    Object.defineProperty(this, "failureSubcode", {
      value: failureCode === "jsonl_tail"
        ? reviewedGrokJsonlTailFailureSubcode(failureSubcode)
        : "none",
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
}

export function grokCopresenceFailureCode(error: unknown): GrokCopresenceFailureCode {
  return error instanceof GrokCopresenceFailure
    && isGrokCopresenceFailureCode(error.failureCode)
    ? error.failureCode
    : "unknown";
}

export function grokCopresenceFailureSubcode(error: unknown): GrokCopresenceFailureSubcode {
  if (!(error instanceof GrokCopresenceFailure) || !isGrokCopresenceFailureCode(error.failureCode)) {
    return "unknown";
  }
  if (error.failureCode === "jsonl_tail") {
    return reviewedGrokJsonlTailFailureSubcode(error.failureSubcode);
  }
  return error.failureSubcode === "none" ? "none" : "unknown";
}

class GrokJsonlTailBoundaryError extends Error {
  readonly failureSubcode: GrokJsonlTailBoundarySubcode;

  constructor(
    failureSubcode: GrokJsonlTailBoundarySubcode,
    cause: unknown,
  ) {
    super(errorMessage(cause));
    this.name = "GrokJsonlTailBoundaryError";
    this.failureSubcode = failureSubcode;
  }
}

function jsonlTailBoundaryError(
  failureSubcode: GrokJsonlTailBoundarySubcode,
  cause: unknown,
): GrokJsonlTailBoundaryError {
  return new GrokJsonlTailBoundaryError(failureSubcode, cause);
}

function atJsonlTailBoundary<T>(
  failureSubcode: GrokJsonlTailBoundarySubcode,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof GrokJsonlTailBoundaryError) throw error;
    throw jsonlTailBoundaryError(failureSubcode, error);
  }
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
  toolAllowlist?: readonly string[];
  sandboxProfile: string;
  protectedPaths?: readonly string[];
}

/** Interactive TUI argv. No prompt/output JSON flags; only audited CommHub MCP. */
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
    // This preview exposes only the fixed runtime-owned profile below. Keep
    // that narrow inventory in always-approve mode so CommHub operations do
    // not strand the shared TUI on a Yes/No prompt.
    "--permission-mode", "bypassPermissions",
    "--always-approve",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxTurns !== undefined) {
    throw new Error("grok copresence does not support maxTurns; Grok 0.2.93 ignores it in interactive TUI mode");
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

  // The TUI never receives the node bearer token. `search_tool` / `use_tool`
  // can reach only the exact commhub server admitted by the inspect gate; all
  // filesystem/process/web escape routes remain denied.
  args.push(
    // The shared process must read its owner-only GROK_AUTH_PATH after its
    // sandbox re-exec. Shell access would bypass path-specific Read/Grep/Edit
    // rules, so the experimental preview gives up terminal tools entirely.
    "--deny", "Bash",
    "--deny", "Write",
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
  if (!Array.isArray(inspection.mcpServers) || inspection.mcpServers.length !== 1) {
    throw new Error("grok copresence requires exactly one discovered commhub MCP server");
  }
  const commhub = inspection.mcpServers[0];
  if (!commhub || typeof commhub !== "object" || Array.isArray(commhub)) {
    throw new Error("grok copresence commhub MCP inspection is malformed");
  }
  const commhubRecord = commhub as Record<string, unknown>;
  const source = commhubRecord.source;
  if (
    commhubRecord.name !== "commhub"
    || commhubRecord.transport !== "stdio"
    || commhubRecord.target !== "bun"
    || !source
    || typeof source !== "object"
    || Array.isArray(source)
    || (source as Record<string, unknown>).type !== "configToml"
    || resolve(String((source as Record<string, unknown>).path || "")) !== join(allowedRoot, "config.toml")
  ) {
    throw new Error("grok copresence refuses any MCP server except its runtime-owned commhub stdio server");
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
  private activeTui: GrokTuiGeneration | null = null;
  private attach: GrokAttachServer | null = null;
  private locks: LifetimeLock[] = [];
  private chatTail: SafeJsonlTail | null = null;
  private eventsTail: SafeJsonlTail | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleBuffer = "";
  private recoveryLifecycleBuffer = "";
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
  private activePermissionExactPreviewTool: string | null = null;
  private readonly previewAutomaticResolutionConsumed = new Set<string>();
  private activeTurnTerminalEventSeen = false;
  private spawnEnv: NodeJS.ProcessEnv;
  private readonly controlledSpawnEnv: NodeJS.ProcessEnv;
  private ptyGeneration = 0;
  private ownedAnyTuiGeneration = false;
  private readonly pendingTuiProcessIds = new Set<number>();
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
      // Project policy placeholders live in the shared cwd, not this node's
      // isolated Grok home. Hold the same canonical project lock used by
      // headless turns for the entire TUI lifetime so a different node cannot
      // spawn against, or clean up, this runtime's sandbox deny anchors.
      // This lock is pushed first and therefore released last, after PTY,
      // Leader, post-stop cleanup, and the node-local lifetime locks.
      this.locks.push(await acquireGrokProjectTurnLock(
        this.opts.cwd,
        flockBinary,
        this.opts.env,
      ));
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
    if (!this.opened || this.closing) {
      return Promise.reject(new GrokCopresenceFailure(
        "runtime_closed",
        "grok copresence runtime is not running",
      ));
    }
    if (!opts.taskId || !opts.from) {
      return Promise.reject(new GrokCopresenceFailure(
        "input_validation",
        "grok copresence taskId/from are required",
      ));
    }
    if (
      this.pending.has(opts.taskId)
      || this.arbitration.queue.some((task) => task.taskId === opts.taskId)
      || (this.arbitration.activeTurn?.owner === "network"
        && this.arbitration.activeTurn.task.taskId === opts.taskId)
    ) {
      return Promise.reject(new GrokCopresenceFailure(
        "input_validation",
        `duplicate grok copresence task ${opts.taskId}`,
      ));
    }

    const task: GrokCopresenceNetworkTask = {
      taskId: opts.taskId,
      from: opts.from,
      message: opts.text,
    };
    const timeoutMs = opts.timeoutMs ?? this.opts.turnTimeoutMs ?? 10 * 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new GrokCopresenceFailure(
        "input_validation",
        "grok copresence timeout must be a positive finite number",
      ));
    }
    // Validate before it enters a durable queue.
    try {
      formatNetworkTuiInput(task);
    } catch (error) {
      return Promise.reject(new GrokCopresenceFailure(
        "input_validation",
        errorMessage(error),
      ));
    }
    const wasBusy = this.arbitration.phase !== "idle" || this.arbitration.queue.length > 0;
    this.transition({ type: "network_task_received", task });

    return new Promise<GrokCopresenceThinkResult>((resolveTask, rejectTask) => {
      const timer = setTimeout(() => {
        this.pending.delete(opts.taskId);
        // A queued timeout must never execute later. An already-active turn
        // cannot be cancelled safely: it may have side effects, so retain the
        // active boundary until its real turn_ended event arrives.
        this.transition({ type: "network_task_cancelled", taskId: opts.taskId });
        rejectTask(new GrokCopresenceFailure(
          "timeout",
          `grok copresence task ${opts.taskId} timed out after ${timeoutMs}ms`,
        ));
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
      pending.reject(new GrokCopresenceFailure(
        "runtime_closed",
        `grok copresence runtime closed while task ${taskId} was pending`,
      ));
    }
    this.pending.clear();
    await this.attach?.close().catch(() => {});
    this.attach = null;
    await this.recoveryPromise?.catch(() => {});
    this.disposeJsonlTails();
    const tui = this.activeTui;
    await terminateOwnedPty(tui?.pty ?? null, tui?.exit ?? null).then(() => {
      this.detachTuiGeneration(tui);
    }).catch((error) => {
      this.retainLocksForUnconfirmedPty = true;
      this.warn(`[grok-copresence] PTY termination failed: ${errorMessage(error)}`);
    });
    await this.teardownOwnedLeader().catch((error) => {
      this.retainLocksForUnconfirmedPty = true;
      this.warn(`[grok-copresence] retaining locks: ${errorMessage(error)}`);
    });
    try {
      await this.finalizeStoppedState();
    } finally {
      this.opened = false;
    }
  }

  private async spawnTui(resume: boolean): Promise<GrokTuiGeneration> {
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
    const tui: GrokTuiGeneration = {
      generation,
      pty,
      exit: exitPromise,
      exited: false,
    };
    this.pendingTuiProcessIds.add(pty.pid);
    this.ownedAnyTuiGeneration = true;
    this.pty = pty;
    this.activeTui = tui;
    pty.onData((data) => {
      if (this.activeTui !== tui || generation !== this.ptyGeneration || this.closing) return;
      this.observeTuiReadiness(generation, data);
      this.attach?.broadcastOutput(data);
    });
    pty.onExit((event) => {
      tui.exited = true;
      resolveExit();
      if (this.activeTui !== tui || generation !== this.ptyGeneration || this.closing) return;
      this.tuiReady = false;
      this.tuiReadinessBuffer = "";
      // The outer recovery attempt owns this generation until it either
      // reconnects or confirms teardown. Replacing recoveryPromise here would
      // let close() stop awaiting that owner and could skip exact PID cleanup.
      if (this.recovering) return;
      this.pty = null;
      this.activeTui = null;
      const recovery = this.recoverFromExit(event, pty.pid);
      this.recoveryPromise = recovery;
      const clearRecovery = () => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      };
      void recovery.then(clearRecovery, (error) => {
        clearRecovery();
        this.warn(`[grok-copresence] recovery failed: ${errorMessage(error)}`);
      });
    });
    return tui;
  }

  private async recoverFromExit(
    event: { exitCode: number; signal?: number },
    stoppedTuiProcessId: number,
  ): Promise<void> {
    if (this.recovering || this.closing) return;
    this.recovering = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.transition({ type: "disconnected" });
    this.warn(`[grok-copresence] TUI exited code=${event.exitCode} signal=${event.signal ?? "-"}; resuming same session`);
    if (this.arbitration.waitingHuman) {
      await this.failFatal(new GrokCopresenceFailure(
        "approval_boundary",
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
      await this.failFatal(new GrokCopresenceFailure(
        "leader_lifecycle",
        `Grok Leader death was not confirmed; refusing recovery: ${errorMessage(error)}`,
      ));
      return;
    }
    try {
      this.cleanupConfirmedTuiGeneration(stoppedTuiProcessId);
    } catch {
      this.retainLocksForUnconfirmedPty = true;
      await this.failFatal(new GrokCopresenceFailure(
        "tui_exit",
        "Grok stopped-generation containment cleanup failed; refusing recovery",
      ));
      return;
    }
    const attempts = Math.max(1, this.opts.reconnectAttempts ?? 3);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts && !this.closing; attempt++) {
      let attemptedTui: GrokTuiGeneration | null = null;
      try {
        if (this.closing) return;
        await delay(Math.min(1_000, attempt * 250));
        if (this.closing) return;
        attemptedTui = await this.spawnTui(true);
        this.assertOwnedTuiGeneration(attemptedTui, "spawn");
        // Bind the generation before consulting `closing`. close() waits for
        // this recovery promise. Even an already-exited recovery TUI can have
        // left its auto-Leader alive, so liveness is checked only after that
        // Leader has been captured by its exact generation marker.
        await waitForOwnedUnixSocket(this.leaderSocket, 10_000);
        this.assertOwnedTuiGeneration(attemptedTui, "leader socket");
        await this.bindSpawnedLeader();
        this.assertLiveTuiGeneration(attemptedTui, "leader bind");
        // close() owns all termination once closing is latched. It awaits this
        // outer recovery promise, then uses the still-bound generation handle;
        // recovery must not race it or discard that handle first.
        if (this.closing) return;
        // No routing is allowed across a PTY generation boundary. Drain any
        // late records from the dead writer and resume-startup chatter to a
        // stable EOF, then reset all semantic correlation before scheduling.
        this.recoveryLifecycleBuffer = "";
        if (!this.chatTail || !this.eventsTail) {
          throw new Error("grok copresence recovery lost its JSONL cursors");
        }
        await discardJsonlTailsUntilJointlyStable(
          this.chatTail,
          this.eventsTail,
          (chunk) => this.auditRecoveryLifecycleChunk(chunk),
        );
        this.assertLiveTuiGeneration(attemptedTui, "recovery drain");
        if (this.closing) return;
        if (this.recoveryLifecycleBuffer.trim()) {
          throw new GrokUnsafeRecoveryApprovalError(
            "Grok events JSONL ended with an incomplete lifecycle record during recovery",
          );
        }
        this.logState = newGrokJsonlState();
        this.lifecycleBuffer = "";
        this.approvalDecisionDispatched = false;
        this.activePermissionRequestId = null;
        this.activePermissionExactPreviewTool = null;
        this.previewAutomaticResolutionConsumed.clear();
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
          this.failPending(task.taskId, new GrokCopresenceFailure(
            "tui_exit",
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
        // Once close() is waiting on this outer promise, leave every owned
        // handle intact for its single ordered PTY -> Leader -> cleanup path.
        if (this.closing) return;
        const failedTui = attemptedTui ?? this.activeTui;
        try {
          await terminateOwnedPty(failedTui?.pty ?? null, failedTui?.exit ?? null);
        } catch (terminationError) {
          this.retainLocksForUnconfirmedPty = true;
          await this.failFatal(new GrokCopresenceFailure(
            "tui_exit",
            `Grok PTY death was not confirmed; refusing another TUI spawn: ${errorMessage(terminationError)}`,
          ));
          return;
        }
        this.detachTuiGeneration(failedTui);
        try {
          await this.teardownOwnedLeader();
        } catch (terminationError) {
          this.retainLocksForUnconfirmedPty = true;
          await this.failFatal(new GrokCopresenceFailure(
            "leader_lifecycle",
            `Grok Leader death was not confirmed; refusing another TUI spawn: ${errorMessage(terminationError)}`,
          ));
          return;
        }
        if (failedTui) {
          try {
            this.cleanupConfirmedTuiGeneration(failedTui.pty.pid);
          } catch {
            this.retainLocksForUnconfirmedPty = true;
            await this.failFatal(new GrokCopresenceFailure(
              "tui_exit",
              "Grok failed recovery generation could not be contained",
            ));
            return;
          }
        }
        if (error instanceof GrokSpawnAuditError || error instanceof GrokUnsafeRecoveryApprovalError) {
          await this.failFatal(asError(error));
          return;
        }
        this.warn(`[grok-copresence] resume attempt ${attempt}/${attempts} failed: ${errorMessage(error)}`);
      }
    }
    if (this.closing) return;
    await this.failFatal(new GrokCopresenceFailure(
      "tui_exit",
      `grok copresence could not resume session: ${errorMessage(lastError)}`,
    ));
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
    this.disposeJsonlTails();
    this.attach?.broadcastStatus({ ...this.attachStatus(), fatal: error.message });
    for (const taskId of [...this.pending.keys()]) this.failPending(taskId, error);
    this.fatalShutdownPromise = (async () => {
      const tui = this.activeTui;
      await terminateOwnedPty(tui?.pty ?? null, tui?.exit ?? null).then(() => {
        this.detachTuiGeneration(tui);
      }).catch(() => {
        this.retainLocksForUnconfirmedPty = true;
      });
      await this.teardownOwnedLeader().catch(() => {
        this.retainLocksForUnconfirmedPty = true;
      });
      await this.attach?.close().catch(() => {});
      this.attach = null;
      await this.finalizeStoppedState();
    })();
    return this.fatalShutdownPromise;
  }

  private disposeJsonlTails(): void {
    const tails = [this.chatTail, this.eventsTail];
    this.chatTail = null;
    this.eventsTail = null;
    for (const tail of tails) {
      try { tail?.dispose(); } catch (error) {
        this.warn(`[grok-copresence] JSONL tail close failed: ${errorMessage(error)}`);
      }
    }
  }

  private async finalizeStoppedState(): Promise<void> {
    if (this.retainLocksForUnconfirmedPty) return;
    // A contender can fail while acquiring the first lifetime lock and still
    // enter close() through open()'s catch path. It never owned a TUI writer and
    // must not mutate another runtime's post-stop state. Only a PID registered
    // immediately after a successful PTY spawn proves this runtime owned a
    // generation whose death can authorize cleanup. Keep that proof latched
    // even after a confirmed recovery boundary consumes its pending PID: final
    // cleanup still owns the retained session/log footprint in that case.
    if (this.ownedAnyTuiGeneration) {
      try {
        cleanupGrokCliPostStopState({
          stateHome: this.opts.grokHome,
          projectCwd: this.opts.cwd,
          leaderSocket: this.leaderSocket,
          tuiProcessIds: [...this.pendingTuiProcessIds],
        });
      } catch (error) {
        // Keep lifetime locks held until process exit if the containment state
        // cannot be inspected or repaired exactly. The external scanner then
        // observes the untouched counterexample and remains fail-closed.
        this.retainLocksForUnconfirmedPty = true;
        throw new Error(`grok post-stop containment cleanup failed: ${errorMessage(error)}`);
      }
      this.pendingTuiProcessIds.clear();
    }
    for (const lock of this.locks.reverse()) await lock.release().catch(() => {});
    this.locks = [];
  }

  private assertOwnedTuiGeneration(tui: GrokTuiGeneration, boundary: string): void {
    if (
      this.activeTui !== tui
      || this.pty !== tui.pty
      || this.ptyGeneration !== tui.generation
    ) {
      throw new Error(`Grok recovery TUI ownership changed before ${boundary}`);
    }
  }

  private assertLiveTuiGeneration(tui: GrokTuiGeneration, boundary: string): void {
    this.assertOwnedTuiGeneration(tui, boundary);
    if (tui.exited) throw new Error(`Grok recovery TUI exited before ${boundary}`);
  }

  private detachTuiGeneration(tui: GrokTuiGeneration | null): void {
    if (!tui || this.activeTui !== tui) return;
    this.activeTui = null;
    this.pty = null;
    this.tuiReady = false;
    this.tuiReadinessBuffer = "";
    if (this.ptyGeneration === tui.generation) this.ptyGeneration += 1;
  }

  private cleanupConfirmedTuiGeneration(tuiProcessId: number): void {
    if (!this.pendingTuiProcessIds.has(tuiProcessId)) {
      throw new Error("Grok stopped-generation PID was not bound to this runtime");
    }
    cleanupGrokCliStoppedTuiGeneration({
      stateHome: this.opts.grokHome,
      projectCwd: this.opts.cwd,
      tuiProcessId,
    });
    this.pendingTuiProcessIds.delete(tuiProcessId);
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
      throw new GrokCopresenceFailure(
        "leader_lifecycle",
        `could not bind the Grok Leader to this TUI generation: ${errorMessage(error)}`,
      );
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
        void this.failFatal(new GrokCopresenceFailure(
          "approval_boundary",
          "grok copresence approval input had no correlated request_id",
        ));
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
      // Keep the runtime-owned always-approve posture immutable. These keys
      // would otherwise toggle it back to an interactive mode and strand a
      // network task on the next permission prompt.
      if (input[offset] === 0x0f) { // Ctrl+O: always-approve toggle
        offset += 1;
        this.warnBlockedPermissionModeChange("Ctrl+O");
        continue;
      }
      if (input.subarray(offset, offset + 3).equals(Buffer.from("\x1b[Z", "binary"))) {
        offset += 3; // Shift+Tab cycles Normal -> Plan -> Always-approve.
        this.warnBlockedPermissionModeChange("Shift+Tab");
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
              this.warnBlockedPermissionModeChange("editor navigation after slash input");
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
          this.warnBlockedPermissionModeChange("unknown terminal control sequence");
          return;
        }
      }

      const nextControl = input[offset];
      const unmodelledEditorControl = !this.humanPasteMode
        && nextControl < 0x20
        && ![0x03, 0x08, 0x0a, 0x0d, 0x15].includes(nextControl);
      if (unmodelledEditorControl) {
        offset += 1;
        this.warnBlockedPermissionModeChange("unknown editor control key");
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
        this.warnBlockedPermissionModeChange("slash command");
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
        this.warnBlockedPermissionModeChange("slash after unmodelled editor control");
        continue;
      }

      if (isSubmit && this.arbitration.phase === "human_editing") {
        try {
          registerExpectedGrokHumanTurn(this.logState);
        } catch (error) {
          void this.failFatal(new GrokCopresenceFailure(
            "correlation",
            errorMessage(error),
          ));
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

  private warnBlockedPermissionModeChange(route: string): void {
    const warning = `${route} was blocked: Grok co-presence keeps its runtime-owned always-approve policy immutable`;
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
        this.failPending(effect.task.taskId, new GrokCopresenceFailure(
          "tui_exit",
          `grok copresence could not write the network turn to its TUI: ${errorMessage(error)}`,
        ));
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
        (chunk) => atJsonlTailBoundary(
          "chat.reduce.state_invariant",
          () => this.reduceLogChunk("chat_history", chunk),
        ),
        () => atJsonlTailBoundary(
          "chat.reduce.state_invariant",
          () => this.resetLogFraming("chat_history"),
        ),
      );
      this.eventsTail?.poll((chunk) => {
        this.reduceEventsChunkInOrder(chunk);
      }, () => atJsonlTailBoundary(
        "events.reduce.state_invariant",
        () => this.resetLogFraming("events"),
      ));
      atJsonlTailBoundary(
        "combined.flush.state_invariant",
        () => this.flushSettledCompletion(),
      );
    } catch (error) {
      const failureSubcode = error instanceof GrokJsonlTailBoundaryError
        ? reviewedGrokJsonlTailFailureSubcode(error.failureSubcode)
        : "unknown";
      const fatal = new GrokCopresenceFailure(
        "jsonl_tail",
        `grok copresence lost its trusted JSONL tail: ${errorMessage(error)}`,
        failureSubcode,
      );
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

  private reduceEventsChunkInOrder(chunk: string): void {
    // Preserve native append order while letting both reducers retain their
    // own cross-chunk partial-line state. A whole-chunk lifecycle pass would
    // incorrectly reorder request -> turn_ended -> resolution into
    // request -> resolution -> turn_ended.
    let offset = 0;
    while (offset < chunk.length && !this.closing) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const fragment = chunk.slice(offset, end);
      atJsonlTailBoundary(
        "events.lifecycle.state_invariant",
        () => this.reduceLifecycleChunk(fragment),
      );
      if (this.closing) return;
      atJsonlTailBoundary(
        "events.reduce.state_invariant",
        () => this.reduceLogChunk("events", fragment),
      );
      offset = end;
    }
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
          this.failPending(taskId, new GrokCopresenceFailure(
            "correlation",
            "Grok user log did not preserve the trusted network envelope",
          ));
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
        if (event.origin === "network" && event.status === "completed") {
          this.activeTurnTerminalEventSeen = true;
        }
        if (event.status === "completed" && this.hasUnresolvedApproval()) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
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
          this.failNetwork(event.task.taskId, new GrokCopresenceFailure(
            "native_outcome",
            `grok copresence turn ${event.status} (${event.completion.discriminator ?? "turn_ended"})`,
          ));
        }
        return;

      case "turn_abandoned":
        if (event.origin === "network" && event.task) {
          this.failNetwork(event.task.taskId, new GrokCopresenceFailure(
            "correlation",
            "grok copresence saw a new user turn before network completion",
          ));
        }
        return;

      case "malformed":
        this.warn(`[grok-copresence] ignored malformed ${event.source} JSONL (${event.reason})`);
        return;

      case "completion_pending_reply":
        this.activeTurnTerminalEventSeen = true;
        if (this.hasUnresolvedApproval()) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
            "grok copresence turn completed while a human approval was still unresolved",
          ));
          return;
        }
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
        decision?: unknown;
        ts?: unknown;
        wait_ms?: unknown;
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
        if (this.activeTurnTerminalEventSeen) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
            "grok copresence observed a permission request after the terminal turn event",
          ));
          return;
        }
        const requestId = lifecyclePermissionIdentity(event);
        if (!requestId) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
            "grok copresence permission request lacked a trusted identity",
          ));
          return;
        }
        if (this.activePermissionRequestId) {
          if (this.activePermissionExactPreviewTool) {
            void this.failFatal(new GrokCopresenceFailure(
              "approval_boundary",
              "grok copresence observed a duplicate preview automatic permission request",
            ));
            return;
          }
          if (this.activePermissionRequestId !== requestId) {
            void this.failFatal(new GrokCopresenceFailure(
              "approval_boundary",
              "grok copresence observed overlapping permission request IDs",
            ));
            return;
          }
          // Duplicate delivery of the same request must not reopen the input
          // gate after an Enter/Ctrl-C decision has already been dispatched.
          continue;
        }
        const exactPreviewTool = exactPreviewAutomaticPermissionRequestTool(event);
        if (
          exactPreviewTool
          && this.arbitration.activeTurn?.owner === "network"
          && this.previewAutomaticResolutionConsumed.has(exactPreviewTool)
        ) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
            `grok copresence observed more than one ${exactPreviewTool} permission lifecycle in a turn`,
          ));
          return;
        }
        const transition = this.transition({ type: "approval_requested" });
        if (!transition.accepted) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
            "grok copresence could not correlate a permission request to the active turn",
          ));
          return;
        }
        this.activePermissionRequestId = requestId;
        this.activePermissionExactPreviewTool = exactPreviewTool;
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
        if (isGrokPreviewAutomaticResolution({
          requestTool: this.activePermissionExactPreviewTool,
          activeRequestId: this.activePermissionRequestId,
          humanDecisionDispatched: this.approvalDecisionDispatched,
          waitingHuman: this.arbitration.waitingHuman,
          turnOwner: this.arbitration.activeTurn?.owner ?? null,
          alreadyConsumed: this.activePermissionExactPreviewTool
            ? this.previewAutomaticResolutionConsumed.has(this.activePermissionExactPreviewTool)
            : false,
          terminalEventSeen: this.activeTurnTerminalEventSeen,
          event,
        })) {
          // Pinned 0.2.93 emits this exact automatic lifecycle for each tool
          // admitted by the fixed preview profile. `todo_write` is local;
          // `search_tool` / `use_tool` can reach only the single runtime-owned
          // CommHub MCP server already verified during startup. Accepting only
          // these exact names and shapes keeps the shared TUI alive without
          // broadening its filesystem/process/web boundary. A network turn may
          // consume each tool tuple once; human turns may repeat an exact tuple.
          //
          // The lifecycle is:
          // requested(tool_name=<fixed tool>) -> resolved(decision=allow)
          // without reading TUI input.  Treat only that exact tuple as a
          // preview-local completion.  Do not derive this exception from the
          // profile array: adding a future tool must never grant it the same
          // behavior accidentally.
          this.previewAutomaticResolutionConsumed.add(this.activePermissionExactPreviewTool!);
          this.clearApprovalCorrelation();
          this.transition({ type: "preview_todo_resolved_automatically" });
          continue;
        }
        if (
          !requestId
          || requestId !== this.activePermissionRequestId
          || !this.approvalDecisionDispatched
        ) {
          void this.failFatal(new GrokCopresenceFailure(
            "approval_boundary",
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
      } else if (isAutomaticApprovalLifecycleEvent(event)) {
        // Expected for the pinned `--always-approve` launch. Explicit deny
        // rules and the fixed three-tool profile remain authoritative.
        continue;
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
      } else if (isAutomaticApprovalLifecycleEvent(event)) {
        // Expected startup/recovery state for this runtime-owned preview.
        continue;
      }
    }
    if (Buffer.byteLength(buffered, "utf8") > MAX_LIFECYCLE_LINE_BYTES) {
      throw new GrokUnsafeRecoveryApprovalError("oversized partial Grok lifecycle record during recovery");
    }
    this.recoveryLifecycleBuffer = buffered;
  }

  private finishNetwork(taskId: string, replyText: string): void {
    if (this.hasUnresolvedApproval()) {
      void this.failFatal(new GrokCopresenceFailure(
        "approval_boundary",
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
    if (result.accepted && event.type === "schedule_network") {
      this.previewAutomaticResolutionConsumed.clear();
      this.activeTurnTerminalEventSeen = false;
    } else if (result.accepted && event.type === "human_input_submitted") {
      this.activeTurnTerminalEventSeen = false;
    }
    if (result.accepted && event.type === "turn_completed") this.clearApprovalCorrelation(true);
    if (result.accepted) this.broadcastState();
    return result;
  }

  private clearApprovalCorrelation(_clearSettled = false): void {
    this.activePermissionRequestId = null;
    this.activePermissionExactPreviewTool = null;
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
      } else if (isAutomaticApprovalLifecycleEvent(event)) {
        // Persisted automatic-mode records are expected. Every new PTY is
        // launched with the same immutable mode and fixed tool profile.
        continue;
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

type SafeJsonlTailFailureKey =
  | "statMissingAfterArm"
  | "statIdentityChanged"
  | "statSizeRegressed"
  | "statNonRegular"
  | "statOwnerMismatch"
  | "statIoOther"
  | "openIoOther"
  | "fstatNonRegular"
  | "fstatIoOther"
  | "readIoOther"
  | "readStateInvariant"
  | "closeIoOther";

const SAFE_JSONL_TAIL_FAILURE_SUBCODES = Object.freeze({
  chat_history: Object.freeze({
    statMissingAfterArm: "chat.stat.missing_after_arm",
    statIdentityChanged: "chat.stat.identity_changed",
    statSizeRegressed: "chat.stat.size_regressed",
    statNonRegular: "chat.stat.non_regular",
    statOwnerMismatch: "chat.stat.owner_mismatch",
    statIoOther: "chat.stat.io_other",
    openIoOther: "chat.open.io_other",
    fstatNonRegular: "chat.fstat.non_regular",
    fstatIoOther: "chat.fstat.io_other",
    readIoOther: "chat.read.io_other",
    readStateInvariant: "chat.read.state_invariant",
    closeIoOther: "chat.close.io_other",
  }),
  events: Object.freeze({
    statMissingAfterArm: "events.stat.missing_after_arm",
    statIdentityChanged: "events.stat.identity_changed",
    statSizeRegressed: "events.stat.size_regressed",
    statNonRegular: "events.stat.non_regular",
    statOwnerMismatch: "events.stat.owner_mismatch",
    statIoOther: "events.stat.io_other",
    openIoOther: "events.open.io_other",
    fstatNonRegular: "events.fstat.non_regular",
    fstatIoOther: "events.fstat.io_other",
    readIoOther: "events.read.io_other",
    readStateInvariant: "events.read.state_invariant",
    closeIoOther: "events.close.io_other",
  }),
} as const satisfies Record<
  GrokJsonlSource,
  Record<SafeJsonlTailFailureKey, GrokJsonlTailBoundarySubcode>
>);

function safeJsonlTailFailureSubcode(
  source: GrokJsonlSource,
  key: SafeJsonlTailFailureKey,
): GrokJsonlTailBoundarySubcode {
  return SAFE_JSONL_TAIL_FAILURE_SUBCODES[source][key];
}

class SafeJsonlTail {
  private identity: { dev: number; ino: number } | null = null;
  private fd: number | null = null;
  private offset = 0;
  // Highest size observed for the currently pinned inode. A same-inode
  // shrink must never be hidden in the gap between replacement validation
  // and the next read.
  private observedSizeFloor = 0;
  private readonly uid = process.getuid?.();
  private decoder = new StringDecoder("utf8");

  constructor(
    private readonly path: string,
    readonly source: GrokJsonlSource,
    private readonly startAtEnd: boolean,
  ) {}

  arm(requireExisting = false): void {
    if (this.identity || this.fd !== null) {
      throw new Error(`Grok ${this.source} JSONL tail was armed twice`);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stat = this.safeStat();
      if (!stat) {
        if (requireExisting) throw new Error(`cannot resume without Grok ${this.source} JSONL`);
        return;
      }
      const opened = this.openMatching(stat);
      if (!opened) continue;
      this.fd = opened.fd;
      this.identity = { dev: opened.stat.dev, ino: opened.stat.ino };
      this.offset = this.startAtEnd ? opened.stat.size : 0;
      this.observedSizeFloor = opened.stat.size;
      return;
    }
    throw this.identityChanged("changed repeatedly while arming");
  }

  poll(onChunk: (chunk: string) => void, onReset?: () => void): void {
    const observeForRead = (value: Stats, allowUnlinked = false): void => {
      try {
        this.observeBoundSize(value, allowUnlinked);
      } catch (error) {
        onReset?.();
        throw error;
      }
    };
    let stat = this.safeStat();
    if (!stat) {
      if (this.identity) {
        throw jsonlTailBoundaryError(
          safeJsonlTailFailureSubcode(this.source, "statMissingAfterArm"),
          new Error(`Grok ${this.source} JSONL disappeared`),
        );
      }
      return;
    }
    if (!this.identity) {
      const opened = this.openMatching(stat);
      if (!opened) return;
      this.fd = opened.fd;
      this.identity = { dev: opened.stat.dev, ino: opened.stat.ino };
      this.offset = this.startAtEnd ? opened.stat.size : 0;
      this.observedSizeFloor = opened.stat.size;
      if (this.startAtEnd) return;
      stat = opened.stat;
    }
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      try {
        const rebound = this.rebindPrefixPreservingReplacement(stat);
        if (!rebound || rebound === "racing") return;
      } catch (error) {
        onReset?.();
        throw error;
      }
    } else {
      // Bind the trusted path observation into the per-inode size floor before
      // the following descriptor check. Otherwise an in-place append+shrink
      // between lstat and fstat could disappear back to the old floor.
      observeForRead(stat);
    }
    const fd = this.requireFd();
    const opened = this.safeFstat(fd);
    // A second atomic publication can unlink the pinned inode immediately
    // after the path check. Reading that still-pinned generation is safe; the
    // next poll must prove the complete prefix before moving to the new path.
    observeForRead(opened, true);
    if (opened.nlink === 0) return;
    if (opened.size < this.offset) {
      onReset?.();
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statSizeRegressed"),
        new Error(`Grok ${this.source} JSONL was rotated or truncated`),
      );
    }
    const available = opened.size - this.offset;
    if (available <= 0) return;
    const length = Math.min(available, MAX_TAIL_READ_BYTES);
    const bytes = Buffer.allocUnsafe(length);
    this.readExactAt(fd, bytes, length, this.offset);
    const read = length;
    // Validate the same pinned inode again before exposing bytes to the
    // reducer. This turns a truncate between fstat/read into a closed failure
    // instead of accepting a short read from a regressed generation.
    const afterRead = this.safeFstat(fd);
    observeForRead(afterRead, true);
    if (afterRead.nlink === 0) return;
    if (read > 0) {
      this.offset += read;
      const chunk = atJsonlTailBoundary(
        safeJsonlTailFailureSubcode(this.source, "readStateInvariant"),
        () => this.decoder.write(bytes.subarray(0, read)),
      );
      if (chunk) onChunk(chunk);
    }
  }

  recoveryPosition(): { key: string; caughtUp: boolean } {
    let stat = this.safeStat();
    if (!stat) {
      if (this.identity) {
        throw jsonlTailBoundaryError(
          safeJsonlTailFailureSubcode(this.source, "statMissingAfterArm"),
          new Error(`Grok ${this.source} JSONL disappeared during recovery`),
        );
      }
      return { key: "missing", caughtUp: true };
    }
    if (!this.identity) {
      const opened = this.openMatching(stat);
      if (!opened) return { key: "racing", caughtUp: false };
      this.fd = opened.fd;
      this.identity = { dev: opened.stat.dev, ino: opened.stat.ino };
      this.offset = this.startAtEnd ? opened.stat.size : 0;
      this.observedSizeFloor = opened.stat.size;
      stat = opened.stat;
    } else if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      const rebound = this.rebindPrefixPreservingReplacement(stat);
      if (!rebound || rebound === "racing") {
        return { key: "racing", caughtUp: false };
      }
    } else {
      this.observeBoundSize(stat);
    }
    const opened = this.safeFstat(this.requireFd());
    this.observeBoundSize(opened, true);
    if (opened.size < this.offset) {
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statSizeRegressed"),
        new Error(`Grok ${this.source} JSONL was rotated or truncated during recovery`),
      );
    }
    return {
      key: `${opened.dev}:${opened.ino}:${opened.nlink}:${this.offset}:${opened.size}`,
      // An unlinked pinned generation can never establish joint stability;
      // the next loop must rebind to the current path first.
      caughtUp: opened.nlink === 1 && this.offset === opened.size,
    };
  }

  finishDiscard(onChunk: (chunk: string) => void = () => {}): void {
    const trailing = atJsonlTailBoundary(
      safeJsonlTailFailureSubcode(this.source, "readStateInvariant"),
      () => this.decoder.end(),
    );
    this.decoder = new StringDecoder("utf8");
    if (trailing) onChunk(trailing);
  }

  dispose(): void {
    const fd = this.fd;
    this.fd = null;
    this.identity = null;
    this.observedSizeFloor = 0;
    if (fd !== null) this.closeFd(fd);
  }

  private rebindPrefixPreservingReplacement(expected: Stats): "ready" | "racing" | false {
    const oldFd = this.requireFd();
    const oldIdentity = this.identity;
    if (!oldIdentity) throw this.identityChanged("lost its pinned identity");
    const candidate = this.openMatching(expected);
    if (!candidate) return false;
    let accepted = false;
    try {
      const oldBefore = this.safeFstat(oldFd);
      this.observeBoundSize(oldBefore, true);
      const stableSize = oldBefore.size;
      const candidateSize = candidate.stat.size;
      if (!Number.isSafeInteger(stableSize) || stableSize < 0) {
        throw this.identityChanged("has an invalid stable prefix size");
      }
      if (candidateSize < stableSize) {
        throw this.identityChanged("replacement omitted bytes from the pinned file");
      }
      this.assertEqualPrefix(oldFd, candidate.fd, stableSize);

      const oldAfter = this.safeFstat(oldFd);
      const newAfter = this.safeFstat(candidate.fd);
      this.observeBoundSize(oldAfter, true);
      this.assertTrustedOpened(newAfter, true);
      const candidateStableSize = Math.max(candidateSize, newAfter.size);
      const pathAfter = this.safeStat();
      if (
        oldAfter.dev !== oldIdentity.dev
        || oldAfter.ino !== oldIdentity.ino
        || oldAfter.size !== stableSize
        || newAfter.dev !== candidate.stat.dev
        || newAfter.ino !== candidate.stat.ino
        || newAfter.size < candidateSize
      ) {
        throw this.identityChanged("changed while verifying an atomic replacement");
      }
      if (!pathAfter) {
        throw this.identityChanged("path disappeared while verifying an atomic replacement");
      }

      const adoptCandidate = (sizeFloor: number, outcome: "ready" | "racing"): "ready" | "racing" => {
        this.closeFd(oldFd);
        this.fd = candidate.fd;
        this.identity = { dev: candidate.stat.dev, ino: candidate.stat.ino };
        this.observedSizeFloor = sizeFloor;
        accepted = true;
        return outcome;
      };

      // A second cumulative atomic publication may replace the candidate
      // while its prefix is being checked. Pinning that now-unlinked,
      // completely verified intermediate generation preserves its full size;
      // the next poll then proves the next generation against it. Rejecting
      // this normal race would make rapid Grok publications spuriously fatal,
      // while skipping the intermediate would lose its unread suffix.
      if (newAfter.nlink === 0) {
        if (pathAfter.dev === candidate.stat.dev && pathAfter.ino === candidate.stat.ino) {
          throw this.identityChanged("unlinked replacement still appeared at the session path");
        }
        // Do not expose bytes from an intermediate generation until its
        // current successor has itself proved the complete prefix. This
        // prevents a transient, later-discarded assistant line from causing a
        // reply before the non-cumulative successor is rejected.
        return adoptCandidate(candidateStableSize, "racing");
      }
      if (
        pathAfter.dev !== candidate.stat.dev
        || pathAfter.ino !== candidate.stat.ino
        || pathAfter.size < candidateStableSize
      ) {
        throw this.identityChanged("changed while verifying an atomic replacement");
      }
      const finalBinding = this.openMatching(pathAfter);
      if (!finalBinding) {
        const candidateNow = this.safeFstat(candidate.fd);
        this.assertTrustedOpened(candidateNow, true);
        if (
          candidateNow.dev === candidate.stat.dev
          && candidateNow.ino === candidate.stat.ino
          && candidateNow.nlink === 0
          && candidateNow.size >= candidateStableSize
        ) {
          const currentPath = this.safeStat();
          if (
            currentPath
            && (currentPath.dev !== candidate.stat.dev || currentPath.ino !== candidate.stat.ino)
          ) {
            return adoptCandidate(
              Math.max(candidateStableSize, candidateNow.size),
              "racing",
            );
          }
        }
        throw this.identityChanged("path changed after verifying an atomic replacement");
      }
      const finalSizeFloor = Math.max(candidateStableSize, pathAfter.size);
      const finalMatches = finalBinding.stat.dev === candidate.stat.dev
        && finalBinding.stat.ino === candidate.stat.ino
        && finalBinding.stat.size >= finalSizeFloor;
      this.closeFd(finalBinding.fd);
      if (!finalMatches) {
        throw this.identityChanged("path changed after verifying an atomic replacement");
      }
      return adoptCandidate(Math.max(finalSizeFloor, finalBinding.stat.size), "ready");
    } finally {
      if (!accepted) {
        try { this.closeFd(candidate.fd); } catch {}
      }
    }
  }

  private assertEqualPrefix(oldFd: number, newFd: number, length: number): void {
    const oldBytes = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(1, length)));
    const newBytes = Buffer.allocUnsafe(oldBytes.length);
    let offset = 0;
    while (offset < length) {
      const wanted = Math.min(oldBytes.length, length - offset);
      this.readExactAt(oldFd, oldBytes, wanted, offset);
      this.readExactAt(newFd, newBytes, wanted, offset);
      if (!oldBytes.subarray(0, wanted).equals(newBytes.subarray(0, wanted))) {
        throw this.identityChanged("replacement did not preserve the pinned file prefix");
      }
      offset += wanted;
    }
  }

  private readExactAt(fd: number, buffer: Buffer, length: number, position: number): void {
    let total = 0;
    while (total < length) {
      const read = atJsonlTailBoundary(
        safeJsonlTailFailureSubcode(this.source, "readIoOther"),
        () => readSync(fd, buffer, total, length - total, position + total),
      );
      if (read <= 0) {
        throw this.identityChanged("replacement prefix ended before its stable size");
      }
      total += read;
    }
  }

  private openMatching(expected: Stats): { fd: number; stat: Stats } | null {
    let fd: number;
    try {
      fd = openSync(
        this.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      );
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "openIoOther"),
        error,
      );
    }
    try {
      const opened = this.safeFstat(fd);
      this.assertTrustedOpened(opened);
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
        this.closeFd(fd);
        return null;
      }
      if (opened.size < expected.size) {
        throw jsonlTailBoundaryError(
          safeJsonlTailFailureSubcode(this.source, "statSizeRegressed"),
          new Error(`Grok ${this.source} JSONL shrank between path and descriptor checks`),
        );
      }
      return { fd, stat: opened };
    } catch (error) {
      try { this.closeFd(fd); } catch {}
      throw error;
    }
  }

  private safeFstat(fd: number): Stats {
    return atJsonlTailBoundary(
      safeJsonlTailFailureSubcode(this.source, "fstatIoOther"),
      () => fstatSync(fd),
    );
  }

  private assertTrustedOpened(stat: Stats, allowUnlinked = false): void {
    if (
      !stat.isFile()
      || (allowUnlinked ? stat.nlink > 1 : stat.nlink !== 1)
      || (stat.mode & 0o077) !== 0
      || (this.uid !== undefined && stat.uid !== this.uid)
    ) {
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "fstatNonRegular"),
        new Error(`unsafe Grok JSONL file: ${this.path}`),
      );
    }
  }

  private assertBoundIdentity(stat: Stats, allowUnlinked = false): void {
    this.assertTrustedOpened(stat, allowUnlinked);
    if (!this.identity || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      throw this.identityChanged("lost its pinned file descriptor identity");
    }
  }

  private observeBoundSize(stat: Stats, allowUnlinked = false): void {
    this.assertBoundIdentity(stat, allowUnlinked);
    if (stat.size < this.observedSizeFloor) {
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statSizeRegressed"),
        new Error(`Grok ${this.source} JSONL regressed below its observed size`),
      );
    }
    this.observedSizeFloor = Math.max(this.observedSizeFloor, stat.size);
  }

  private requireFd(): number {
    if (this.fd === null) throw this.identityChanged("lost its pinned file descriptor");
    return this.fd;
  }

  private closeFd(fd: number): void {
    atJsonlTailBoundary(
      safeJsonlTailFailureSubcode(this.source, "closeIoOther"),
      () => closeSync(fd),
    );
  }

  private identityChanged(detail: string): GrokJsonlTailBoundaryError {
    return jsonlTailBoundaryError(
      safeJsonlTailFailureSubcode(this.source, "statIdentityChanged"),
      new Error(`Grok ${this.source} JSONL ${detail}`),
    );
  }

  private safeStat(): Stats | null {
    let stat: Stats;
    try { stat = lstatSync(this.path); } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statIoOther"),
        error,
      );
    }
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0
    ) {
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statNonRegular"),
        new Error(`Grok JSONL path is not a regular file: ${this.path}`),
      );
    }
    if (this.uid !== undefined && stat.uid !== this.uid) {
      throw jsonlTailBoundaryError(
        safeJsonlTailFailureSubcode(this.source, "statOwnerMismatch"),
        new Error(`Grok JSONL owner mismatch: ${this.path}`),
      );
    }
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

class GrokSpawnAuditError extends GrokCopresenceFailure {
  constructor(message: string) { super("spawn_audit", message); }
}
class GrokUnsafeRecoveryApprovalError extends GrokCopresenceFailure {
  constructor(message: string) { super("approval_boundary", message); }
}

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

function exactPreviewAutomaticPermissionRequestTool(event: {
  type?: unknown;
  ts?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
}): string | null {
  if (!exactObjectKeys(event, ["tool_name", "ts", "type"])) return null;
  if (
    event.type !== "permission_requested"
    || !isBoundedLifecycleShapeString(event.ts)
    || event.request_id !== undefined
    || event.requestId !== undefined
    || typeof event.tool_name !== "string"
    || !(GROK_COPRESENCE_EFFECTIVE_TOOLS as readonly string[]).includes(event.tool_name)
    || event.toolName !== undefined
  ) return null;
  return event.tool_name;
}

function isExactPreviewAutomaticPermissionResolution(event: {
  type?: unknown;
  decision?: unknown;
  ts?: unknown;
  wait_ms?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
}, expectedTool: string): boolean {
  return exactObjectKeys(event, ["decision", "tool_name", "ts", "type", "wait_ms"])
    && event.type === "permission_resolved"
    && isBoundedLifecycleShapeString(event.ts)
    && typeof event.wait_ms === "number"
    && Number.isSafeInteger(event.wait_ms)
    && event.wait_ms >= 0
    && event.request_id === undefined
    && event.requestId === undefined
    && event.tool_name === expectedTool
    && event.toolName === undefined
    && event.decision === "allow";
}

/** Exact preview exception; exported so every rejected dimension has a pure mutation test. */
export function isGrokPreviewAutomaticResolution(input: {
  requestTool: string | null;
  activeRequestId: string | null;
  humanDecisionDispatched: boolean;
  waitingHuman: boolean;
  turnOwner: "human" | "network" | null;
  alreadyConsumed: boolean;
  terminalEventSeen: boolean;
  event: {
    type?: unknown;
    decision?: unknown;
    ts?: unknown;
    wait_ms?: unknown;
    request_id?: unknown;
    requestId?: unknown;
    tool_name?: unknown;
    toolName?: unknown;
  };
}): boolean {
  const requestId = lifecyclePermissionIdentity(input.event);
  return input.requestTool !== null
    && (GROK_COPRESENCE_EFFECTIVE_TOOLS as readonly string[]).includes(input.requestTool)
    && input.activeRequestId === `tool:${input.requestTool}`
    && requestId === input.activeRequestId
    && !input.humanDecisionDispatched
    && input.waitingHuman
    && (input.turnOwner === "network" || input.turnOwner === "human")
    && (!input.alreadyConsumed || input.turnOwner === "human")
    && !input.terminalEventSeen
    && isExactPreviewAutomaticPermissionResolution(input.event, input.requestTool);
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedLifecycleShapeString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256;
}

function isAutomaticApprovalLifecycleEvent(event: {
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
