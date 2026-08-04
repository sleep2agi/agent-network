import { lstat as nodeLstat } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

export const GROK_ATTACH_PROTOCOL = "anet-grok-copresence-attach";
export const GROK_ATTACH_PROTOCOL_VERSION = 1;
export const GROK_ATTACH_DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
export const GROK_ATTACH_DEFAULT_MAX_BUFFER_BYTES = 128 * 1024;
export const GROK_ATTACH_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const GROK_ATTACH_DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const GROK_ATTACH_MIN_FRAME_BYTES = 256;

export type GrokAttachJsonValue =
  | null
  | boolean
  | number
  | string
  | GrokAttachJsonValue[]
  | { [key: string]: GrokAttachJsonValue };

export interface GrokAttachHelloFrame {
  type: "hello";
  protocol: typeof GROK_ATTACH_PROTOCOL;
  version: typeof GROK_ATTACH_PROTOCOL_VERSION;
  alias: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface GrokAttachOutputFrame {
  type: "output";
  data: string;
  encoding: "base64";
}

export interface GrokAttachStatusFrame {
  type: "status";
  status: GrokAttachJsonValue;
}

export interface GrokAttachErrorFrame {
  type: "error";
  code: string;
  message: string;
  fatal: boolean;
}

export interface GrokAttachDetachFrame {
  type: "detach";
}

export type GrokAttachServerFrame =
  | GrokAttachHelloFrame
  | GrokAttachOutputFrame
  | GrokAttachStatusFrame
  | GrokAttachErrorFrame
  | GrokAttachDetachFrame;

export interface GrokAttachInputFrame {
  type: "input";
  data: string;
  encoding: "base64";
}

export interface GrokAttachResizeFrame {
  type: "resize";
  cols: number;
  rows: number;
}

export type GrokAttachClientFrame = GrokAttachInputFrame | GrokAttachResizeFrame | GrokAttachDetachFrame;

export interface GrokAttachInputSource {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off?(event: "data" | "end", listener: (...args: any[]) => void): unknown;
  removeListener?(event: "data" | "end", listener: (...args: any[]) => void): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

export interface GrokAttachOutputSink {
  write(chunk: Uint8Array): boolean | void;
  columns?: number;
  rows?: number;
  once?(event: "drain", listener: () => void): unknown;
}

export interface GrokAttachSignalSource {
  on(event: "SIGWINCH", listener: () => void): unknown;
  off?(event: "SIGWINCH", listener: () => void): unknown;
  removeListener?(event: "SIGWINCH", listener: () => void): unknown;
}

export interface GrokAttachSocketStat {
  uid: number;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

export interface GrokAttachDependencies {
  lstat?: (socketPath: string) => Promise<GrokAttachSocketStat>;
  getuid?: () => number | undefined;
  connect?: (socketPath: string) => Duplex;
}

export interface GrokAttachClientOptions {
  socketPath: string;
  input: GrokAttachInputSource;
  output: GrokAttachOutputSink;
  signalSource?: GrokAttachSignalSource;
  terminalSize?: () => { cols: number | undefined; rows: number | undefined };
  maxFrameBytes?: number;
  maxBufferBytes?: number;
  handshakeTimeoutMs?: number;
  closeTimeoutMs?: number;
  detachOnInputEnd?: boolean;
  onHello?: (frame: GrokAttachHelloFrame) => void;
  onStatus?: (frame: GrokAttachStatusFrame) => void;
  onError?: (error: Error, frame?: GrokAttachErrorFrame) => void;
  onDetach?: (frame: GrokAttachDetachFrame) => void;
  dependencies?: GrokAttachDependencies;
}

export type GrokAttachCloseReason =
  | "local-detach"
  | "input-end"
  | "remote-detach"
  | "socket-close"
  | "socket-error"
  | "protocol-error";

export interface GrokAttachCloseInfo {
  reason: GrokAttachCloseReason;
  error?: Error;
}

export interface GrokAttachSession {
  readonly socketPath: string;
  readonly closed: Promise<GrokAttachCloseInfo>;
  detach(): void;
  resize(cols?: number, rows?: number): void;
}

export class GrokAttachRemoteError extends Error {
  readonly code: string;
  readonly fatal: boolean;

  constructor(frame: GrokAttachErrorFrame) {
    super(frame.message);
    this.name = "GrokAttachRemoteError";
    this.code = frame.code;
    this.fatal = frame.fatal;
  }
}

export async function validateGrokAttachSocket(
  socketPath: string,
  dependencies: GrokAttachDependencies = {},
): Promise<void> {
  if (!socketPath || socketPath.includes("\0")) {
    throw new Error("grok attach socket path must be a non-empty Unix socket path");
  }

  const readStat = dependencies.lstat ?? (nodeLstat as (path: string) => Promise<GrokAttachSocketStat>);
  let stat: GrokAttachSocketStat;
  try {
    stat = await readStat(socketPath);
  } catch (error) {
    throw new Error(`cannot inspect grok attach socket ${socketPath}: ${errorMessage(error)}`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symlink grok attach socket: ${socketPath}`);
  }
  if (!stat.isSocket()) {
    throw new Error(`grok attach path is not a Unix socket: ${socketPath}`);
  }

  const getuid = dependencies.getuid ?? (() => process.getuid?.());
  const uid = getuid();
  if (uid === undefined) {
    throw new Error("grok attach requires a platform that exposes the current Unix uid");
  }
  if (stat.uid !== uid) {
    throw new Error(`refusing grok attach socket owned by uid ${stat.uid}; current uid is ${uid}`);
  }
}

export async function connectGrokAttach(options: GrokAttachClientOptions): Promise<GrokAttachSession> {
  const maxFrameBytes = positiveInteger(
    options.maxFrameBytes ?? GROK_ATTACH_DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  const maxBufferBytes = positiveInteger(
    options.maxBufferBytes ?? GROK_ATTACH_DEFAULT_MAX_BUFFER_BYTES,
    "maxBufferBytes",
  );
  if (maxFrameBytes < GROK_ATTACH_MIN_FRAME_BYTES) {
    throw new Error(`maxFrameBytes must be at least ${GROK_ATTACH_MIN_FRAME_BYTES}`);
  }
  if (maxBufferBytes <= maxFrameBytes) {
    throw new Error("maxBufferBytes must be greater than maxFrameBytes");
  }

  const handshakeTimeoutMs = positiveInteger(
    options.handshakeTimeoutMs ?? GROK_ATTACH_DEFAULT_HANDSHAKE_TIMEOUT_MS,
    "handshakeTimeoutMs",
  );
  const closeTimeoutMs = positiveInteger(
    options.closeTimeoutMs ?? GROK_ATTACH_DEFAULT_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );

  await validateGrokAttachSocket(options.socketPath, options.dependencies);

  const connect = options.dependencies?.connect ?? ((socketPath: string) => createConnection(socketPath));
  const socket = connect(options.socketPath);
  const client = new GrokAttachClient(socket, options, maxFrameBytes, maxBufferBytes, closeTimeoutMs);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([client.connected, client.ready]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `timed out waiting for grok attach hello after ${handshakeTimeoutMs}ms`,
        )), handshakeTimeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    client.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  try {
    client.activate();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    client.abort(failure);
    throw failure;
  }
  return client;
}

class GrokAttachClient implements GrokAttachSession {
  readonly socketPath: string;
  readonly connected: Promise<void>;
  readonly ready: Promise<void>;
  readonly closed: Promise<GrokAttachCloseInfo>;

  private readonly socket: Duplex;
  private readonly options: GrokAttachClientOptions;
  private readonly maxFrameBytes: number;
  private readonly maxBufferBytes: number;
  private readonly maxInputChunkBytes: number;
  private readonly closeTimeoutMs: number;
  private readonly resolveConnected: () => void;
  private readonly rejectConnected: (error: Error) => void;
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: Error) => void;
  private readonly resolveClosed: (info: GrokAttachCloseInfo) => void;
  private pending = Buffer.alloc(0);
  private sawHello = false;
  private active = false;
  private finished = false;
  private closeInfo: GrokAttachCloseInfo | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    socket: Duplex,
    options: GrokAttachClientOptions,
    maxFrameBytes: number,
    maxBufferBytes: number,
    closeTimeoutMs: number,
  ) {
    this.socket = socket;
    this.socketPath = options.socketPath;
    this.options = options;
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferBytes = maxBufferBytes;
    this.maxInputChunkBytes = calculateMaxInputChunkBytes(maxFrameBytes);
    this.closeTimeoutMs = closeTimeoutMs;

    const connected = deferred<void>();
    this.connected = connected.promise;
    this.resolveConnected = connected.resolve;
    this.rejectConnected = connected.reject;
    const ready = deferred<void>();
    this.ready = ready.promise;
    this.resolveReady = ready.resolve;
    this.rejectReady = ready.reject;
    const closed = deferred<GrokAttachCloseInfo>();
    this.closed = closed.promise;
    this.resolveClosed = closed.resolve;

    socket.once("connect", this.handleConnect);
    socket.on("data", this.handleSocketData);
    socket.on("error", this.handleSocketError);
    socket.once("close", this.handleSocketClose);
  }

  activate(): void {
    if (this.finished) {
      throw this.closeInfo?.error ?? new Error("grok attach socket closed during handshake");
    }
    if (this.active) return;
    this.active = true;
    (this.options.signalSource ?? process).on("SIGWINCH", this.handleSigwinch);
    this.resize();
    if (this.finished) throw this.closeInfo?.error ?? new Error("grok attach closed during activation");
    this.options.input.on("data", this.handleInputData);
    this.options.input.on("end", this.handleInputEnd);
    this.options.input.resume?.();
  }

  detach(): void {
    this.detachWithReason("local-detach");
  }

  resize(cols?: number, rows?: number): void {
    if (this.finished || !this.sawHello) return;
    const size = cols === undefined || rows === undefined
      ? this.readTerminalSize()
      : normalizeTerminalSize(cols, rows);
    if (!size) return;
    this.sendFrame({ type: "resize", ...size });
  }

  abort(error: Error): void {
    if (!this.finished) {
      this.closeInfo = { reason: "protocol-error", error };
      this.rejectConnected(error);
      this.rejectReady(error);
      this.notifyError(error);
      this.cleanup();
    }
    this.clearCloseTimer();
    this.socket.destroy();
  }

  private readonly handleConnect = (): void => {
    this.resolveConnected();
  };

  private readonly handleSocketData = (chunk: Buffer | string): void => {
    if (this.finished) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    if (this.pending.length + bytes.length > this.maxBufferBytes) {
      this.protocolFailure(new Error(`grok attach receive buffer exceeds ${this.maxBufferBytes} bytes`));
      return;
    }
    let offset = 0;

    while (offset < bytes.length && !this.finished) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendPending(bytes.subarray(offset));
        return;
      }

      const segment = bytes.subarray(offset, newline);
      if (this.pending.length + segment.length > this.maxFrameBytes) {
        this.protocolFailure(new Error(`grok attach frame exceeds ${this.maxFrameBytes} bytes`));
        return;
      }

      let line = this.pending.length === 0
        ? segment
        : Buffer.concat([this.pending, segment], this.pending.length + segment.length);
      this.pending = Buffer.alloc(0);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) {
        this.protocolFailure(new Error("grok attach received an empty frame"));
        return;
      }
      this.processLine(line);
      offset = newline + 1;
    }
  };

  private appendPending(segment: Buffer): void {
    const nextLength = this.pending.length + segment.length;
    if (nextLength > this.maxFrameBytes) {
      this.protocolFailure(new Error(`grok attach frame exceeds ${this.maxFrameBytes} bytes`));
      return;
    }
    if (nextLength > this.maxBufferBytes) {
      this.protocolFailure(new Error(`grok attach receive buffer exceeds ${this.maxBufferBytes} bytes`));
      return;
    }
    this.pending = this.pending.length === 0
      ? Buffer.from(segment)
      : Buffer.concat([this.pending, segment], nextLength);
  }

  private processLine(line: Buffer): void {
    let frame: unknown;
    try {
      frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      this.protocolFailure(new Error("grok attach received malformed UTF-8 JSON frame"));
      return;
    }

    if (!isRecord(frame) || typeof frame.type !== "string") {
      this.protocolFailure(new Error("grok attach received an invalid frame"));
      return;
    }
    // A busy single-client server rejects a second attach with a fatal error
    // before hello. Surface that useful error instead of masking it as a bad
    // handshake; every other pre-hello frame still fails closed.
    if (!this.sawHello && frame.type !== "hello" && frame.type !== "error") {
      this.protocolFailure(new Error("grok attach expected hello as the first server frame"));
      return;
    }

    switch (frame.type) {
      case "hello":
        this.processHello(frame);
        return;
      case "output":
        this.processOutput(frame);
        return;
      case "status":
        if (!("status" in frame)) {
          this.protocolFailure(new Error("grok attach status frame is missing status"));
          return;
        }
        try {
          this.options.onStatus?.(frame as unknown as GrokAttachStatusFrame);
        } catch (error) {
          this.protocolFailure(new Error(`grok attach status callback failed: ${errorMessage(error)}`));
        }
        return;
      case "error":
        this.processRemoteError(frame);
        return;
      case "detach":
        this.closeInfo = { reason: "remote-detach" };
        this.cleanup();
        try {
          this.options.onDetach?.({ type: "detach" });
        } catch (error) {
          this.notifyError(new Error(`grok attach detach callback failed: ${errorMessage(error)}`));
        }
        this.beginGracefulClose();
        return;
      default:
        this.protocolFailure(new Error(`grok attach received unknown frame type: ${frame.type}`));
    }
  }

  private processHello(frame: Record<string, unknown>): void {
    if (this.sawHello) {
      this.protocolFailure(new Error("grok attach received duplicate hello"));
      return;
    }
    if (frame.protocol !== GROK_ATTACH_PROTOCOL || frame.version !== GROK_ATTACH_PROTOCOL_VERSION) {
      this.protocolFailure(new Error(
        `unsupported grok attach protocol ${String(frame.protocol)} version ${String(frame.version)}`,
      ));
      return;
    }
    if (typeof frame.alias !== "string" || frame.alias.length === 0
      || Buffer.byteLength(frame.alias) > 256
      || typeof frame.sessionId !== "string" || frame.sessionId.length === 0
      || Buffer.byteLength(frame.sessionId) > 256) {
      this.protocolFailure(new Error("grok attach hello is missing alias or sessionId"));
      return;
    }
    this.sawHello = true;
    const hello = frame as unknown as GrokAttachHelloFrame;
    try {
      this.options.onHello?.(hello);
    } catch (error) {
      this.protocolFailure(new Error(`grok attach hello callback failed: ${errorMessage(error)}`));
      return;
    }
    this.resolveReady();
  }

  private processOutput(frame: Record<string, unknown>): void {
    if (typeof frame.data !== "string" || frame.encoding !== "base64" || !isCanonicalBase64(frame.data)) {
      this.protocolFailure(new Error("grok attach output frame must contain canonical base64 data"));
      return;
    }
    const output = Buffer.from(frame.data, "base64");
    try {
      const writable = this.options.output.write(output);
      if (writable === false && this.options.output.once) {
        this.socket.pause();
        this.options.output.once("drain", () => {
          if (!this.finished) this.socket.resume();
        });
      }
    } catch (error) {
      this.protocolFailure(new Error(`grok attach output sink failed: ${errorMessage(error)}`));
    }
  }

  private processRemoteError(frame: Record<string, unknown>): void {
    if (typeof frame.code !== "string" || typeof frame.message !== "string" || typeof frame.fatal !== "boolean") {
      this.protocolFailure(new Error("grok attach received an invalid error frame"));
      return;
    }
    const typed = frame as unknown as GrokAttachErrorFrame;
    const error = new GrokAttachRemoteError(typed);
    this.notifyError(error, typed);
    if (typed.fatal) {
      this.closeInfo = { reason: "protocol-error", error };
      if (!this.sawHello) this.rejectReady(error);
      this.cleanup();
      this.beginGracefulClose();
    }
  }

  private readonly handleInputData = (chunk: unknown): void => {
    if (this.finished || !this.active) return;
    let bytes: Buffer;
    try {
      bytes = inputChunkToBuffer(chunk);
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (let offset = 0; offset < bytes.length && !this.finished; offset += this.maxInputChunkBytes) {
      const piece = bytes.subarray(offset, offset + this.maxInputChunkBytes);
      this.sendFrame({ type: "input", data: piece.toString("base64"), encoding: "base64" });
    }
  };

  private readonly handleInputEnd = (): void => {
    if (this.options.detachOnInputEnd === false) return;
    this.detachWithReason("input-end");
  };

  private readonly handleSigwinch = (): void => {
    this.resize();
  };

  private readonly handleSocketError = (error: Error): void => {
    if (this.finished) return;
    this.closeInfo = { reason: "socket-error", error };
    this.rejectConnected(error);
    this.rejectReady(error);
    this.notifyError(error);
    this.cleanup();
    this.socket.destroy();
  };

  private readonly handleSocketClose = (): void => {
    this.clearCloseTimer();
    if (!this.sawHello) {
      const error = this.closeInfo?.error ?? new Error("grok attach socket closed before hello");
      this.rejectConnected(error);
      this.rejectReady(error);
    }
    const info = this.closeInfo ?? { reason: "socket-close" as const };
    this.cleanup();
    this.resolveClosed(info);
  };

  private detachWithReason(reason: "local-detach" | "input-end"): void {
    if (this.finished) return;
    this.closeInfo = { reason };
    if (this.sawHello) this.sendFrame({ type: "detach" });
    this.cleanup();
    this.beginGracefulClose();
  }

  private sendFrame(frame: GrokAttachClientFrame): void {
    if (this.finished) return;
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (encoded.length - 1 > this.maxFrameBytes) {
      this.protocolFailure(new Error(`outbound grok attach frame exceeds ${this.maxFrameBytes} bytes`));
      return;
    }
    if (this.socket.writableLength + encoded.length > this.maxBufferBytes) {
      this.protocolFailure(new Error(`grok attach send buffer exceeds ${this.maxBufferBytes} bytes`));
      return;
    }
    const writable = this.socket.write(encoded);
    if (!writable) {
      this.options.input.pause?.();
      this.socket.once("drain", () => {
        if (!this.finished && this.active) this.options.input.resume?.();
      });
    }
  }

  private readTerminalSize(): { cols: number; rows: number } | undefined {
    const raw = this.options.terminalSize?.() ?? {
      cols: this.options.output.columns,
      rows: this.options.output.rows,
    };
    return normalizeTerminalSize(raw.cols, raw.rows);
  }

  private protocolFailure(error: Error): void {
    if (this.finished) return;
    this.closeInfo = { reason: "protocol-error", error };
    this.rejectConnected(error);
    this.rejectReady(error);
    this.notifyError(error);
    this.cleanup();
    this.socket.destroy();
  }

  private beginGracefulClose(): void {
    if (this.socket.destroyed) return;
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
      return;
    }
    if (this.socket.destroyed || this.closeTimer) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.socket.destroy();
    }, this.closeTimeoutMs);
    this.closeTimer.unref?.();
  }

  private clearCloseTimer(): void {
    if (!this.closeTimer) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  private notifyError(error: Error, frame?: GrokAttachErrorFrame): void {
    try {
      this.options.onError?.(error, frame);
    } catch {
      // A presentation callback must not break socket cleanup or frame parsing.
    }
  }

  private cleanup(): void {
    if (this.finished) return;
    this.finished = true;
    this.active = false;
    removeListener(this.options.input, "data", this.handleInputData);
    removeListener(this.options.input, "end", this.handleInputEnd);
    removeListener(this.options.signalSource ?? process, "SIGWINCH", this.handleSigwinch);
    this.options.input.pause?.();
  }
}

function calculateMaxInputChunkBytes(maxFrameBytes: number): number {
  const emptyFrameBytes = Buffer.byteLength(JSON.stringify({
    type: "input",
    data: "",
    encoding: "base64",
  }));
  const availableBase64Bytes = maxFrameBytes - emptyFrameBytes;
  const rawBytes = Math.floor(availableBase64Bytes / 4) * 3;
  if (rawBytes < 1) {
    throw new Error("maxFrameBytes is too small for a grok attach input frame");
  }
  return rawBytes;
}

function normalizeTerminalSize(
  cols: number | undefined,
  rows: number | undefined,
): { cols: number; rows: number } | undefined {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return undefined;
  if ((cols as number) < 1 || (rows as number) < 1) return undefined;
  if ((cols as number) > 16_384 || (rows as number) > 16_384) return undefined;
  return { cols: cols as number, rows: rows as number };
}

function inputChunkToBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw new Error("grok attach input source emitted a non-byte chunk");
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function removeListener(
  target: { off?: Function; removeListener?: Function },
  event: string,
  listener: (...args: any[]) => void,
): void {
  if (target.off) target.off(event, listener);
  else target.removeListener?.(event, listener);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
