import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { expect, test } from "bun:test";
import {
  connectGrokAttach,
  GROK_ATTACH_PROTOCOL,
  GROK_ATTACH_PROTOCOL_VERSION,
  GrokAttachRemoteError,
  type GrokAttachClientFrame,
  type GrokAttachClientOptions,
  type GrokAttachErrorFrame,
  type GrokAttachHelloFrame,
  type GrokAttachSocketStat,
  type GrokAttachStatusFrame,
  validateGrokAttachSocket,
} from "./grok-attach-client";

class FakeSocket extends Duplex {
  readonly writes: Buffer[] = [];
  closeOnFinal = true;

  _read(): void {}

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    callback();
    if (this.closeOnFinal) queueMicrotask(() => this.destroy());
  }

  sendFrame(frame: unknown, splitAt?: number): void {
    const wire = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (splitAt && splitAt > 0 && splitAt < wire.length) {
      this.push(wire.subarray(0, splitAt));
      this.push(wire.subarray(splitAt));
      return;
    }
    this.push(wire);
  }

  sendBytes(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }

  clientFrames(): GrokAttachClientFrame[] {
    const wire = Buffer.concat(this.writes).toString("utf8");
    return wire
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GrokAttachClientFrame);
  }
}

class FakeInput extends EventEmitter {
  paused = false;

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }
}

class FakeOutput {
  columns = 80;
  rows = 24;
  readonly chunks: Buffer[] = [];

  write(chunk: Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
}

const ownedSocketStat = (overrides: Partial<{
  uid: number;
  socket: boolean;
  symlink: boolean;
}> = {}): GrokAttachSocketStat => ({
  uid: overrides.uid ?? 1000,
  isSocket: () => overrides.socket ?? true,
  isSymbolicLink: () => overrides.symlink ?? false,
});

function hello(overrides: Partial<GrokAttachHelloFrame> = {}): GrokAttachHelloFrame {
  return {
    type: "hello",
    protocol: GROK_ATTACH_PROTOCOL,
    version: GROK_ATTACH_PROTOCOL_VERSION,
    alias: "grok-node",
    sessionId: "session-123",
    ...overrides,
  };
}

function harness(extra: Partial<GrokAttachClientOptions> = {}) {
  const socket = new FakeSocket();
  const input = new FakeInput();
  const output = new FakeOutput();
  const signals = new EventEmitter();
  const hellos: GrokAttachHelloFrame[] = [];
  const statuses: GrokAttachStatusFrame[] = [];
  const errors: Array<{ error: Error; frame?: GrokAttachErrorFrame }> = [];
  const detaches: unknown[] = [];

  const options: GrokAttachClientOptions = {
    socketPath: "/tmp/anet-grok-attach.sock",
    input,
    output,
    signalSource: signals,
    handshakeTimeoutMs: 100,
    closeTimeoutMs: 50,
    onHello: (frame) => hellos.push(frame),
    onStatus: (frame) => statuses.push(frame),
    onError: (error, frame) => errors.push({ error, frame }),
    onDetach: (frame) => detaches.push(frame),
    dependencies: {
      lstat: async () => ownedSocketStat(),
      getuid: () => 1000,
      connect: () => {
        queueMicrotask(() => {
          socket.emit("connect");
          socket.sendFrame(hello(), 7);
        });
        return socket;
      },
    },
    ...extra,
  };

  return { socket, input, output, signals, hellos, statuses, errors, detaches, options };
}

test("validateGrokAttachSocket rejects symlinks, non-sockets, and foreign owners", async () => {
  const common = { getuid: () => 1000 };

  await expect(validateGrokAttachSocket("/tmp/link.sock", {
    ...common,
    lstat: async () => ownedSocketStat({ symlink: true }),
  })).rejects.toThrow("refusing symlink");

  await expect(validateGrokAttachSocket("/tmp/file.sock", {
    ...common,
    lstat: async () => ownedSocketStat({ socket: false }),
  })).rejects.toThrow("not a Unix socket");

  await expect(validateGrokAttachSocket("/tmp/foreign.sock", {
    ...common,
    lstat: async () => ownedSocketStat({ uid: 2000 }),
  })).rejects.toThrow("owned by uid 2000");

  await expect(validateGrokAttachSocket("/tmp/owned.sock", {
    ...common,
    lstat: async () => ownedSocketStat(),
  })).resolves.toBeUndefined();
});

test("connectGrokAttach bridges base64 terminal I/O, status, resize, and detach", async () => {
  const h = harness();
  const session = await connectGrokAttach(h.options);

  expect(h.hellos).toEqual([hello()]);
  expect(h.socket.clientFrames()).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

  const inputBytes = Buffer.from([0x00, 0x0a, 0x41, 0xff]);
  h.input.emit("data", inputBytes);
  const inputFrame = h.socket.clientFrames().find((frame) => frame.type === "input");
  expect(inputFrame).toEqual({
    type: "input",
    data: inputBytes.toString("base64"),
    encoding: "base64",
  });

  h.output.columns = 132;
  h.output.rows = 43;
  h.signals.emit("SIGWINCH");
  expect(h.socket.clientFrames()).toContainEqual({ type: "resize", cols: 132, rows: 43 });

  h.socket.sendFrame({ type: "status", status: { state: "human_turn", queued: 2 } }, 11);
  h.socket.sendFrame({
    type: "output",
    data: Buffer.from("live Grok output\n").toString("base64"),
    encoding: "base64",
  });
  h.socket.sendFrame({ type: "error", code: "waiting_human", message: "approval pending", fatal: false });

  expect(h.statuses).toEqual([{ type: "status", status: { state: "human_turn", queued: 2 } }]);
  expect(Buffer.concat(h.output.chunks).toString("utf8")).toBe("live Grok output\n");
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0].error).toBeInstanceOf(GrokAttachRemoteError);
  expect(h.errors[0].frame?.code).toBe("waiting_human");

  const countBeforeDetach = h.socket.clientFrames().length;
  session.detach();
  h.input.emit("data", "must not be forwarded");
  const info = await bounded(session.closed);

  expect(info.reason).toBe("local-detach");
  expect(h.socket.clientFrames().slice(countBeforeDetach)).toEqual([{ type: "detach" }]);
  expect(h.input.paused).toBe(true);
});

test("connectGrokAttach splits large input so every NDJSON frame stays bounded", async () => {
  const h = harness({ maxFrameBytes: 256, maxBufferBytes: 512 });
  const session = await connectGrokAttach(h.options);

  const input = Buffer.alloc(700, 0xab);
  h.input.emit("data", input);

  const wireLines = Buffer.concat(h.socket.writes).toString("utf8").split("\n").filter(Boolean);
  expect(wireLines.every((line) => Buffer.byteLength(line) <= 256)).toBe(true);
  const reconstructed = Buffer.concat(
    wireLines
      .map((line) => JSON.parse(line) as GrokAttachClientFrame)
      .filter((frame): frame is Extract<GrokAttachClientFrame, { type: "input" }> => frame.type === "input")
      .map((frame) => Buffer.from(frame.data, "base64")),
  );
  expect(reconstructed).toEqual(input);
  session.detach();
  await bounded(session.closed);
});

test("connectGrokAttach fails closed on an invalid handshake and oversized frame", async () => {
  const invalid = harness({ handshakeTimeoutMs: 100 });
  invalid.options.dependencies = {
    lstat: async () => ownedSocketStat(),
    getuid: () => 1000,
    connect: () => {
      queueMicrotask(() => {
        invalid.socket.emit("connect");
        invalid.socket.sendFrame({ ...hello(), version: 99 });
      });
      return invalid.socket;
    },
  };

  await expect(connectGrokAttach(invalid.options)).rejects.toThrow("unsupported grok attach protocol");
  expect(invalid.errors[0].error.message).toContain("unsupported grok attach protocol");

  const oversized = harness({ maxFrameBytes: 256, maxBufferBytes: 512 });
  const session = await connectGrokAttach(oversized.options);
  oversized.socket.sendBytes(Buffer.alloc(257, 0x78));
  const info = await bounded(session.closed);

  expect(info.reason).toBe("protocol-error");
  expect(info.error?.message).toContain("frame exceeds 256 bytes");
});

test("a single-client rejection before hello preserves the server error", async () => {
  const h = harness();
  h.options.dependencies = {
    lstat: async () => ownedSocketStat(),
    getuid: () => 1000,
    connect: () => {
      queueMicrotask(() => {
        h.socket.emit("connect");
        h.socket.sendFrame({
          type: "error",
          code: "client_already_attached",
          message: "a human Grok TUI client is already attached",
          fatal: true,
        });
      });
      return h.socket;
    },
  };

  await expect(connectGrokAttach(h.options)).rejects.toThrow("already attached");
  expect(h.errors).toHaveLength(1);
  expect(h.errors[0].error).toBeInstanceOf(GrokAttachRemoteError);
  expect(h.errors[0].frame?.code).toBe("client_already_attached");
});

test("hello followed by a fatal frame in the same chunk cannot return a dead session", async () => {
  const h = harness();
  h.options.dependencies = {
    lstat: async () => ownedSocketStat(),
    getuid: () => 1000,
    connect: () => {
      queueMicrotask(() => {
        h.socket.emit("connect");
        h.socket.sendBytes(Buffer.from([
          JSON.stringify(hello()),
          JSON.stringify({ type: "error", code: "fatal_race", message: "fatal after hello", fatal: true }),
          "",
        ].join("\n")));
      });
      return h.socket;
    },
  };

  await expect(bounded(connectGrokAttach(h.options))).rejects.toThrow("fatal after hello");
  expect(h.errors[0].frame?.code).toBe("fatal_race");
});

test("detach force-closes a peer that never completes its half-close", async () => {
  const h = harness({ closeTimeoutMs: 10 });
  h.socket.closeOnFinal = false;
  const session = await connectGrokAttach(h.options);

  session.detach();
  const info = await bounded(session.closed);

  expect(info.reason).toBe("local-detach");
  expect(h.socket.destroyed).toBe(true);
});

test("callback failure and invalid limits fail before returning an attached client", async () => {
  const callback = harness({
    onHello: () => {
      throw new Error("hello renderer broke");
    },
  });
  await expect(bounded(connectGrokAttach(callback.options))).rejects.toThrow("hello callback failed");

  const invalid = harness({ maxFrameBytes: 255 });
  let connectCalled = false;
  invalid.options.dependencies = {
    ...invalid.options.dependencies,
    connect: () => {
      connectCalled = true;
      return invalid.socket;
    },
  };
  await expect(connectGrokAttach(invalid.options)).rejects.toThrow("at least 256");
  expect(connectCalled).toBe(false);
});

test("remote detach is surfaced and closes without echoing a detach frame", async () => {
  const h = harness();
  const session = await connectGrokAttach(h.options);
  const framesBefore = h.socket.clientFrames().length;

  h.socket.sendFrame({ type: "detach" });
  const info = await bounded(session.closed);

  expect(info.reason).toBe("remote-detach");
  expect(h.detaches).toEqual([{ type: "detach" }]);
  expect(h.socket.clientFrames()).toHaveLength(framesBefore);
});

function bounded<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`test promise timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
