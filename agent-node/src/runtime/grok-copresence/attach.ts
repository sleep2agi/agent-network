import {
  chmodSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
  copresenceCapabilities,
  copresenceEndpointIsFilesystemPath,
  copresenceIpcEndpoint,
  modeIsExactly,
  modeIsOwnerOnly,
} from "./platform";
import { dirname, isAbsolute, resolve } from "node:path";

export const GROK_COPRESENCE_ATTACH_PROTOCOL = "anet-grok-copresence-attach";
export const GROK_COPRESENCE_ATTACH_VERSION = 1 as const;
export const DEFAULT_ATTACH_MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_ATTACH_MAX_BUFFERED_BYTES = 128 * 1024;

const MIN_FRAME_BYTES = 256;
const MAX_TERMINAL_DIMENSION = 16_384;
const MAX_PENDING_ARBITER_CALLBACKS = 128;

export type GrokCopresenceAttachJson =
  | null
  | boolean
  | number
  | string
  | GrokCopresenceAttachJson[]
  | { [key: string]: GrokCopresenceAttachJson };

export interface GrokCopresenceAttachResize {
  cols: number;
  rows: number;
}

export type GrokCopresenceAttachDetachReason =
  | "client"
  | "disconnect"
  | "protocol_error"
  | "server_close";

export interface GrokCopresenceAttachServerOptions {
  socketPath: string;
  alias: string;
  sessionId: string;
  /** Receives decoded terminal bytes. This transport never writes to a PTY. */
  onInput: (data: Buffer) => void | Promise<void>;
  /** Receives validated dimensions. The arbiter remains the sole PTY owner. */
  onResize: (cols: number, rows: number) => void | Promise<void>;
  onDetach?: (reason: GrokCopresenceAttachDetachReason) => void | Promise<void>;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

export interface GrokCopresenceAttachServer {
  readonly socketPath: string;
  readonly clientAttached: boolean;
  /** Returns false when no human attach client is connected. */
  broadcastOutput(data: string | Uint8Array): boolean;
  /** Returns false when no human attach client is connected. */
  broadcastStatus(status: unknown): boolean;
  close(): Promise<void>;
}

export type GrokAttachServerOptions = GrokCopresenceAttachServerOptions;
export type GrokAttachServer = GrokCopresenceAttachServer;

type ServerFrame =
  | {
    type: "hello";
    protocol: typeof GROK_COPRESENCE_ATTACH_PROTOCOL;
    version: typeof GROK_COPRESENCE_ATTACH_VERSION;
    alias: string;
    sessionId: string;
  }
  | { type: "output"; data: string; encoding: "base64" }
  | { type: "status"; status: unknown }
  | { type: "error"; code: string; message: string; fatal: boolean };

interface ClientState {
  socket: Socket;
  buffer: Buffer;
  pendingCallbacks: number;
  pendingInputBytes: number;
  detachNotified: boolean;
  closed: boolean;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

/**
 * Starts the owner-only local terminal attach endpoint.
 *
 * The protocol is newline-delimited JSON. The server emits hello/output/status/error;
 * the client may emit only input/resize/detach. Terminal data uses base64 so an
 * arbitrary PTY byte stream cannot corrupt frame boundaries.
 */
export async function startGrokAttachServer(
  options: GrokCopresenceAttachServerOptions,
): Promise<GrokCopresenceAttachServer> {
  const limits = validateOptions(options);
  // Validate identity-bearing hello before creating any filesystem entry.
  encodeFrame({
    type: "hello",
    protocol: GROK_COPRESENCE_ATTACH_PROTOCOL,
    version: GROK_COPRESENCE_ATTACH_VERSION,
    alias: options.alias,
    sessionId: options.sessionId,
  }, limits.maxFrameBytes);
  assertSafeSocketLocation(options.socketPath);
  const server = new AttachServer(options, limits.maxFrameBytes, limits.maxBufferedBytes);
  await server.start();
  return server;
}

class AttachServer implements GrokCopresenceAttachServer {
  readonly socketPath: string;

  private readonly server: Server;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private activeClient: ClientState | null = null;
  private identity: SocketIdentity | null = null;
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private arbiterCallbacks: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: GrokCopresenceAttachServerOptions,
    maxFrameBytes: number,
    maxBufferedBytes: number,
  ) {
    this.socketPath = options.socketPath;
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.server = createServer((socket) => this.accept(socket));
    // Errors during listen are handled by start(). A later server error must not
    // become an uncaught process exception; active clients fail closed instead.
    this.server.on("error", (error) => {
      if (!this.started || this.closing) return;
      const client = this.activeClient;
      if (client) this.rejectActive(client, "server_error", errorMessage(error));
    });
  }

  get clientAttached(): boolean {
    return this.activeClient !== null && !this.activeClient.closed;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        rejectStart(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolveStart();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      // 路径仍按路径用（锁文件、哈希键），只有真正 bind 的这一刻换成平台端点：
      // Linux 逐字沿用原 Unix socket 路径；Windows 换成按完整路径哈希出的命名管道。
      this.server.listen(copresenceIpcEndpoint(this.socketPath, copresenceCapabilities()));
    });

    try {
      // 🔴 命名管道不在文件系统里：这里的 chmod / lstat / isSocket / dev+ino
      //    全部是针对【Unix socket 文件】的校验，对管道逐条都不成立
      //    （实测第一条就 `ENOENT: chmod '...\\run\\attach.sock'`）。
      //    互斥与生命周期由管道命名空间本身保证：同名只能被一个进程创建，
      //    进程退出 OS 立即回收 —— 这一格不是"跳过检查"，是"检查对象不同"。
      if (copresenceEndpointIsFilesystemPath(copresenceCapabilities())) {
        chmodSync(this.socketPath, 0o600);
        const stat = lstatSync(this.socketPath);
        if (!stat.isSocket() || stat.isSymbolicLink()) {
          throw new Error("Grok attach endpoint is not a real Unix socket");
        }
        if (!modeIsOwnerOnly(stat.mode)) {
          throw new Error("Grok attach Unix socket must be owner-only (0600)");
        }
        this.identity = { dev: stat.dev, ino: stat.ino };
      }
      this.started = true;
    } catch (error) {
      await this.stopListeningAfterStartFailure();
      this.unlinkOwnedSocket();
      throw error;
    }
  }

  broadcastOutput(data: string | Uint8Array): boolean {
    const client = this.activeClient;
    if (!client || client.closed) return false;

    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    // Base64 grows by 4/3. Reserving 128 bytes for JSON fields keeps every
    // generated frame below the configured wire limit, even at small test limits.
    const rawChunkLimit = Math.max(1, Math.floor((this.maxFrameBytes - 128) * 3 / 4));
    if (bytes.length === 0) {
      return this.sendActive(client, { type: "output", data: "", encoding: "base64" });
    }

    for (let offset = 0; offset < bytes.length; offset += rawChunkLimit) {
      const chunk = bytes.subarray(offset, Math.min(offset + rawChunkLimit, bytes.length));
      if (!this.sendActive(client, {
        type: "output",
        data: chunk.toString("base64"),
        encoding: "base64",
      })) return false;
    }
    return true;
  }

  broadcastStatus(status: unknown): boolean {
    const client = this.activeClient;
    if (!client || client.closed) return false;
    try {
      if (JSON.stringify(status) === undefined) {
        throw new Error("status is not JSON serializable");
      }
    } catch (error) {
      this.rejectActive(client, "invalid_status", errorMessage(error));
      return false;
    }
    return this.sendActive(client, { type: "status", status });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    const client = this.activeClient;
    this.activeClient = null;
    if (client) {
      client.closed = true;
      this.notifyDetach(client, "server_close");
      client.socket.destroy();
    }

    if (this.started || this.server.listening) {
      await new Promise<void>((resolveClose) => {
        this.server.close(() => resolveClose());
      });
    }
    this.started = false;
    this.unlinkOwnedSocket();
  }

  private accept(socket: Socket): void {
    socket.on("error", () => {
      // close is the single teardown path; errors are intentionally fail-closed.
    });

    if (this.closing || this.activeClient !== null) {
      this.rejectUnattached(
        socket,
        this.closing ? "server_closing" : "client_already_attached",
        this.closing
          ? "Grok attach server is closing"
          : "a human Grok TUI client is already attached",
      );
      return;
    }

    const client: ClientState = {
      socket,
      buffer: Buffer.alloc(0),
      pendingCallbacks: 0,
      pendingInputBytes: 0,
      detachNotified: false,
      closed: false,
    };
    this.activeClient = client;

    socket.on("data", (chunk: Buffer) => this.receive(client, chunk));
    socket.on("end", () => this.releaseDisconnected(client));
    socket.on("close", () => this.releaseDisconnected(client));

    if (!this.sendActive(client, {
      type: "hello",
      protocol: GROK_COPRESENCE_ATTACH_PROTOCOL,
      version: GROK_COPRESENCE_ATTACH_VERSION,
      alias: this.options.alias,
      sessionId: this.options.sessionId,
    })) {
      this.releaseDisconnected(client);
    }
  }

  private receive(client: ClientState, chunk: Buffer): void {
    if (client.closed || this.activeClient !== client) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);

    if (client.buffer.length + chunk.length > this.maxBufferedBytes) {
      this.rejectActive(client, "buffer_limit", "attach receive buffer limit exceeded");
      return;
    }
    client.buffer = client.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([client.buffer, chunk], client.buffer.length + chunk.length);

    while (!client.closed) {
      const newline = client.buffer.indexOf(0x0a);
      if (newline === -1) break;
      let line = client.buffer.subarray(0, newline);
      client.buffer = Buffer.from(client.buffer.subarray(newline + 1));
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length > this.maxFrameBytes) {
        this.rejectActive(client, "frame_too_large", "attach frame limit exceeded");
        return;
      }
      if (line.length === 0) {
        this.rejectActive(client, "invalid_frame", "empty attach frame");
        return;
      }
      this.handleLine(client, line);
    }

    if (!client.closed && client.buffer.length > this.maxFrameBytes) {
      this.rejectActive(client, "frame_too_large", "attach frame limit exceeded");
    }
  }

  private handleLine(client: ClientState, line: Buffer): void {
    let frame: unknown;
    try {
      frame = JSON.parse(decodeUtf8(line));
    } catch {
      this.rejectActive(client, "invalid_frame", "attach frame must be valid UTF-8 JSON");
      return;
    }
    if (!isRecord(frame) || typeof frame.type !== "string") {
      this.rejectActive(client, "invalid_frame", "attach frame must have a string type");
      return;
    }

    switch (frame.type) {
      case "input": {
        if (!hasOnlyKeys(frame, ["type", "data", "encoding"])
          || frame.encoding !== "base64"
          || typeof frame.data !== "string"
          || !isStrictBase64(frame.data)) {
          this.rejectActive(client, "invalid_input", "input data must be canonical base64");
          return;
        }
        const data = Buffer.from(frame.data, "base64");
        this.enqueueCallback(client, () => this.options.onInput(data), data.length);
        return;
      }

      case "resize": {
        if (!hasOnlyKeys(frame, ["type", "cols", "rows"])
          || !isTerminalDimension(frame.cols)
          || !isTerminalDimension(frame.rows)) {
          this.rejectActive(client, "invalid_resize", "resize cols and rows must be positive safe integers");
          return;
        }
        this.enqueueCallback(client, () => this.options.onResize(
          frame.cols as number,
          frame.rows as number,
        ), 0);
        return;
      }

      case "detach":
        if (Object.keys(frame).some((key) => key !== "type")) {
          this.rejectActive(client, "invalid_detach", "detach frame has unexpected fields");
          return;
        }
        this.activeClient = null;
        client.closed = true;
        this.notifyDetach(client, "client");
        client.socket.end();
        return;

      default:
        this.rejectActive(client, "invalid_frame", `unsupported client frame type: ${frame.type}`);
    }
  }

  private enqueueCallback(
    client: ClientState,
    callback: () => void | Promise<void>,
    retainedInputBytes: number,
  ): void {
    if (client.pendingCallbacks >= MAX_PENDING_ARBITER_CALLBACKS
      || client.pendingInputBytes + retainedInputBytes > this.maxBufferedBytes) {
      this.rejectActive(client, "arbiter_queue_limit", "attach arbiter callback queue limit exceeded");
      return;
    }
    client.pendingCallbacks += 1;
    client.pendingInputBytes += retainedInputBytes;
    this.arbiterCallbacks = this.arbiterCallbacks
      .then(async () => {
        try {
          // A detached generation has lost ownership. Its queued bytes must
          // not race a newly attached terminal into the arbiter.
          if (!client.closed && this.activeClient === client) await callback();
        } finally {
          client.pendingCallbacks -= 1;
          client.pendingInputBytes -= retainedInputBytes;
        }
      })
      .catch((error) => {
        if (!client.closed) {
          this.rejectActive(client, "arbiter_callback_failed", errorMessage(error));
        }
      });
  }

  private notifyDetach(client: ClientState, reason: GrokCopresenceAttachDetachReason): void {
    if (client.detachNotified) return;
    client.detachNotified = true;
    if (!this.options.onDetach) return;
    this.arbiterCallbacks = this.arbiterCallbacks
      .then(() => this.options.onDetach?.(reason))
      .catch(() => {
        // The transport is already detached. There is no peer to trust with an
        // error and no PTY action is taken here.
      });
  }

  private releaseDisconnected(client: ClientState): void {
    if (this.activeClient === client) this.activeClient = null;
    if (!client.closed) client.closed = true;
    this.notifyDetach(client, "disconnect");
  }

  private sendActive(client: ClientState, frame: ServerFrame): boolean {
    if (client.closed || this.activeClient !== client || !client.socket.writable) return false;
    let encoded: Buffer;
    try {
      encoded = encodeFrame(frame, this.maxFrameBytes);
    } catch (error) {
      this.rejectActive(client, "outbound_frame_too_large", errorMessage(error));
      return false;
    }
    if (client.socket.writableLength + encoded.length > this.maxBufferedBytes) {
      this.rejectActive(client, "outbound_buffer_limit", "attach send buffer limit exceeded");
      return false;
    }
    client.socket.write(encoded);
    return true;
  }

  private rejectActive(client: ClientState, code: string, message: string): void {
    if (this.activeClient === client) this.activeClient = null;
    if (client.closed) return;
    client.closed = true;
    this.notifyDetach(client, "protocol_error");
    this.endWithError(client.socket, code, message);
  }

  private rejectUnattached(socket: Socket, code: string, message: string): void {
    this.endWithError(socket, code, message);
  }

  private endWithError(socket: Socket, code: string, message: string): void {
    try {
      const encoded = encodeFrame({
        type: "error",
        code,
        message: truncateUtf8(message, 512),
        fatal: true,
      }, this.maxFrameBytes);
      if (socket.writable && socket.writableLength + encoded.length <= this.maxBufferedBytes) {
        socket.end(encoded);
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  }

  private async stopListeningAfterStartFailure(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private unlinkOwnedSocket(): void {
    if (!this.identity) return;
    let stat: Stats;
    try {
      stat = lstatSync(this.socketPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    if (stat.isSocket() && !stat.isSymbolicLink()
      && stat.dev === this.identity.dev && stat.ino === this.identity.ino) {
      try {
        unlinkSync(this.socketPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
}

function validateOptions(options: GrokCopresenceAttachServerOptions): {
  maxFrameBytes: number;
  maxBufferedBytes: number;
} {
  if (typeof options.onInput !== "function" || typeof options.onResize !== "function") {
    throw new Error("Grok attach server requires onInput and onResize arbiter callbacks");
  }
  if (typeof options.alias !== "string" || options.alias.length === 0
    || Buffer.byteLength(options.alias, "utf8") > 256) {
    throw new Error("Grok attach alias must be a non-empty string of at most 256 bytes");
  }
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0
    || Buffer.byteLength(options.sessionId, "utf8") > 256) {
    throw new Error("Grok attach sessionId must be a non-empty string of at most 256 bytes");
  }
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_ATTACH_MAX_FRAME_BYTES;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_ATTACH_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < MIN_FRAME_BYTES) {
    throw new Error(`maxFrameBytes must be a safe integer >= ${MIN_FRAME_BYTES}`);
  }
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < maxFrameBytes + 1) {
    throw new Error("maxBufferedBytes must be a safe integer larger than maxFrameBytes");
  }
  return { maxFrameBytes, maxBufferedBytes };
}

function assertSafeSocketLocation(socketPath: string): void {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath) {
    throw new Error("Grok attach socket path must be absolute and normalized");
  }
  // 🔴 Windows：端点是【命名管道】而不是文件系统里的 socket 文件，
  //    所以下面这组 lstat / uid / 0700 校验对它没有意义 —— 它们的保护对象
  //    （别人能不能在同目录里塞一个同名 socket）在管道命名空间里不存在。
  //    实测：AF_UNIX 在 Windows 上 EACCES，命名管道 ok。
  //    父目录本身仍然由 ensurePrivateRuntimeDirectory 建成受控目录（锁文件放那儿）。
  if (!copresenceEndpointIsFilesystemPath(copresenceCapabilities())) return;
  const parent = dirname(socketPath);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Grok attach socket parent must be a real directory");
  }
  if (realpathSync(parent) !== parent) {
    throw new Error("Grok attach socket parent path may not contain symlinks");
  }
  if (typeof process.getuid !== "function" || parentStat.uid !== process.getuid()) {
    throw new Error("Grok attach socket parent must be owned by the current uid");
  }
  if (!modeIsOwnerOnly(parentStat.mode)) {
    throw new Error("Grok attach socket parent must be owner-only (0700)");
  }

  try {
    const existing = lstatSync(socketPath);
    if (existing.isSymbolicLink()) {
      throw new Error("Grok attach socket path may not be a symlink");
    }
    if (!existing.isSocket()) {
      throw new Error("Grok attach socket path may not be a regular filesystem entry");
    }
    throw new Error("Grok attach socket path is already in use");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function encodeFrame(frame: ServerFrame, maxFrameBytes: number): Buffer {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length > maxFrameBytes) {
    throw new Error(`outbound attach frame exceeds ${maxFrameBytes} bytes`);
  }
  return Buffer.concat([bytes, Buffer.from("\n")], bytes.length + 1);
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isStrictBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isTerminalDimension(value: unknown): boolean {
  return Number.isSafeInteger(value)
    && (value as number) > 0
    && (value as number) <= MAX_TERMINAL_DIMENSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
