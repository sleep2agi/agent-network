import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROK_COPRESENCE_ATTACH_PROTOCOL,
  startGrokAttachServer,
  type GrokCopresenceAttachServer,
} from "./attach";

const roots: string[] = [];
const servers: GrokCopresenceAttachServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Grok co-presence local attach server", () => {
  it("serves one owner-only client and cleans its socket on close", async () => {
    const { root, socketPath } = temporarySocket();
    const detached = deferred<string>();
    const server = await startServer(socketPath, {
      onDetach: (reason) => detached.resolve(reason),
    });

    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);

    const client = await connect(socketPath);
    expect(await client.frames.next()).toEqual({
      type: "hello",
      protocol: GROK_COPRESENCE_ATTACH_PROTOCOL,
      version: 1,
      alias: "test-grok",
      sessionId: "session-test",
      // The first connection gets the keyboard; the handshake says so rather
      // than leaving the client to infer it from a later refusal.
      role: "terminal",
      // #1548 —— 还没广播过任何 status,所以是 null。
      // 🔴 null 的含义是「本会话还没广播过」,**不是**「状态坏了」。
      status: null,
    });
    expect(server.clientAttached).toBe(true);

    expect(server.broadcastOutput(Buffer.from([0x00, 0x0a, 0xff]))).toBe(true);
    const output = await client.frames.next();
    expect(output).toMatchObject({ type: "output", encoding: "base64" });
    expect(Buffer.from(String(output.data), "base64")).toEqual(Buffer.from([0x00, 0x0a, 0xff]));

    expect(server.broadcastStatus({ phase: "human_editing", waitingHuman: false })).toBe(true);
    expect(await client.frames.next()).toEqual({
      type: "status",
      status: { phase: "human_editing", waitingHuman: false },
    });

    const closed = waitForSocketClose(client.socket);
    writeFrame(client.socket, { type: "detach" });
    await closed;
    expect(await detached.promise).toBe("client");
    expect(server.clientAttached).toBe(false);
    expect(server.broadcastOutput("orphaned")).toBe(false);

    await server.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("🔴 a second client becomes a control connection and cannot take the keyboard", async () => {
    // The single-owner rule is about keyboard ownership, so it binds the
    // terminal seat only. A second connection still may not type — that is the
    // part being enforced here — but it is no longer turned away, because
    // refusing it made a model switch impossible in the one situation it is
    // for: somebody sitting in the TUI.
    const { socketPath } = temporarySocket();
    const received = deferred<Buffer>();
    const server = await startServer(socketPath, {
      onInput: (data) => received.resolve(data),
    });

    const first = await connect(socketPath);
    expect(await first.frames.next()).toMatchObject({ type: "hello", role: "terminal" });

    const second = await connect(socketPath);
    expect(await second.frames.next()).toMatchObject({ type: "hello", role: "control" });

    second.socket.on("error", () => {});
    writeFrame(second.socket, {
      type: "input",
      data: Buffer.from("not-the-owner").toString("base64"),
      encoding: "base64",
    });
    expect(await second.frames.next()).toMatchObject({
      type: "error",
      code: "control_client_cannot_type",
      fatal: true,
    });

    // The human keeps the seat, and their keystrokes still arrive.
    expect(server.clientAttached).toBe(true);
    writeFrame(first.socket, {
      type: "input",
      data: Buffer.from("still-owner").toString("base64"),
      encoding: "base64",
    });
    expect(await received.promise).toEqual(Buffer.from("still-owner"));
  });

  it("routes input and resize frames only through serialized arbiter callbacks", async () => {
    const { socketPath } = temporarySocket();
    const complete = deferred<void>();
    const events: string[] = [];
    const server = await startServer(socketPath, {
      onInput: async (data) => {
        events.push(`input:${data.toString("hex")}`);
        await Promise.resolve();
      },
      onResize: (cols, rows) => {
        events.push(`resize:${cols}x${rows}`);
        complete.resolve();
      },
    });

    const client = await connect(socketPath);
    await client.frames.next();
    const terminalBytes = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0x0a]);
    client.socket.write([
      JSON.stringify({
        type: "input",
        data: terminalBytes.toString("base64"),
        encoding: "base64",
      }),
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      "",
    ].join("\n"));

    await complete.promise;
    expect(events).toEqual([
      `input:${terminalBytes.toString("hex")}`,
      "resize:120x40",
    ]);
    expect(server.clientAttached).toBe(true);
  });

  it("arms a one-shot redraw for a terminal client but never for a control connection (#1412)", async () => {
    const { socketPath } = temporarySocket();
    const events: string[] = [];
    const resized = deferred<void>();
    const server = await startServer(socketPath, {
      onTerminalAttached: () => { events.push("terminal-attached"); },
      onResize: (cols, rows) => { events.push(`resize:${cols}x${rows}`); resized.resolve(); },
    });

    // First client is the terminal: onTerminalAttached fires after hello and
    // BEFORE its first resize (it rides the same serialized arbiter queue).
    const terminal = await connect(socketPath);
    await terminal.frames.next(); // hello
    terminal.socket.write(`${JSON.stringify({ type: "resize", cols: 100, rows: 30 })}\n`);
    await resized.promise;
    expect(events).toEqual(["terminal-attached", "resize:100x30"]);

    // Second client is a control connection: it must never arm a redraw.
    const control = await connect(socketPath);
    expect(await control.frames.next()).toMatchObject({ type: "hello", role: "control" });
    await Bun.sleep(50);
    expect(events.filter((e) => e === "terminal-attached")).toHaveLength(1);

    void server;
  });

  it("fails closed when an inbound frame exceeds the configured bound", async () => {
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, {
      maxFrameBytes: 256,
      maxBufferedBytes: 512,
    });
    const client = await connect(socketPath);
    await client.frames.next();

    const closed = waitForSocketClose(client.socket);
    client.socket.write(`${JSON.stringify({
      type: "input",
      data: "A".repeat(300),
      encoding: "base64",
    })}\n`);
    expect(await client.frames.next()).toMatchObject({
      type: "error",
      code: "frame_too_large",
      fatal: true,
    });
    await closed;
    expect(server.clientAttached).toBe(false);
  });

  it("routes a set-model frame through the same serialized arbiter queue as input", async () => {
    // Ordering matters, not just delivery: a switch that overtook queued
    // keystrokes would tear the TUI down with the person's line still unsent.
    const { socketPath } = temporarySocket();
    const complete = deferred<void>();
    const events: string[] = [];
    const server = await startServer(socketPath, {
      onInput: async (data) => {
        events.push(`input:${data.toString("ascii")}`);
        await Promise.resolve();
      },
      onSetModel: (model) => {
        events.push(`set-model:${model}`);
        complete.resolve();
      },
    });
    const client = await connect(socketPath);
    await client.frames.next();

    client.socket.write([
      JSON.stringify({ type: "input", data: Buffer.from("hi").toString("base64"), encoding: "base64" }),
      JSON.stringify({ type: "set-model", model: "grok-4.6" }),
      "",
    ].join("\n"));

    await complete.promise;
    expect(events).toEqual(["input:hi", "set-model:grok-4.6"]);
    expect(server.clientAttached).toBe(true);
  });

  it("🔴 refuses set-model when the runtime cannot switch, rather than accepting it silently", async () => {
    // Accepting it would tell the caller the model moved on a node that has
    // no way to move it.
    const { socketPath } = temporarySocket();
    await startServer(socketPath);
    const client = await connect(socketPath);
    await client.frames.next();

    client.socket.write(`${JSON.stringify({ type: "set-model", model: "grok-4.6" })}\n`);
    expect(await client.frames.next()).toMatchObject({
      type: "error",
      code: "unsupported_frame",
    });
  });

  it("🔴 refuses a set-model frame that is not exactly {type, model:string}", async () => {
    // The operand ends up in argv. Anything the transport is not certain about
    // must not reach the runtime at all.
    for (const frame of [
      { type: "set-model" },
      { type: "set-model", model: 42 },
      { type: "set-model", model: "grok-4.6", extra: "smuggled" },
    ]) {
      const { socketPath } = temporarySocket();
      let called = false;
      await startServer(socketPath, { onSetModel: () => { called = true; } });
      const client = await connect(socketPath);
      await client.frames.next();

      client.socket.write(`${JSON.stringify(frame)}\n`);
      expect(await client.frames.next(), JSON.stringify(frame)).toMatchObject({
        type: "error",
        code: "invalid_set_model",
      });
      expect(called, JSON.stringify(frame)).toBe(false);
    }
  });

  it("🔴 set-model works while a human is attached — that is the whole point", async () => {
    // Before the control role, this frame could not arrive at all: the
    // transport refused the second connection before parsing anything, so a
    // model switch was impossible in exactly the situation it exists for.
    const { socketPath } = temporarySocket();
    const switched = deferred<string>();
    const server = await startServer(socketPath, {
      onSetModel: (model) => switched.resolve(model),
    });

    const human = await connect(socketPath);
    expect(await human.frames.next()).toMatchObject({ type: "hello", role: "terminal" });

    const controller = await connect(socketPath);
    expect(await controller.frames.next()).toMatchObject({ type: "hello", role: "control" });
    writeFrame(controller.socket, { type: "set-model", model: "grok-4.6" });
    expect(await switched.promise).toBe("grok-4.6");

    // The human never lost the seat.
    expect(server.clientAttached).toBe(true);
  });

  it("🔴 a control connection closing is not a human detaching", async () => {
    // The runtime reacts to onDetach by writing Ctrl-C into the PTY and
    // dropping deferred bytes. If a control connection reached that callback,
    // every model switch would wipe whatever the human had half-typed.
    const { socketPath } = temporarySocket();
    const detachReasons: string[] = [];
    const server = await startServer(socketPath, {
      onSetModel: () => {},
      onDetach: (reason) => { detachReasons.push(reason); },
    });

    const human = await connect(socketPath);
    await human.frames.next();
    const control = await connect(socketPath);
    await control.frames.next();

    writeFrame(control.socket, { type: "detach" });
    await waitForSocketClose(control.socket);
    await Bun.sleep(50);
    expect(detachReasons).toEqual([]);
    expect(server.clientAttached).toBe(true);

    // The terminal seat still reports its own detach.
    const humanClosed = waitForSocketClose(human.socket);
    writeFrame(human.socket, { type: "detach" });
    await humanClosed;
    await Bun.sleep(50);
    expect(detachReasons).toEqual(["client"]);
  });

  it("🔴 bounds how many control connections may be open at once", async () => {
    // Without a cap, a caller that reconnects in a loop accumulates sockets
    // against the node — and every one of them is a socket `server.close()`
    // has to wait for.
    const { socketPath } = temporarySocket();
    await startServer(socketPath, { onSetModel: () => {} });

    const human = await connect(socketPath);
    expect(await human.frames.next()).toMatchObject({ type: "hello", role: "terminal" });

    // MAX_CONTROL_CLIENTS is 4; the fifth control connection is refused.
    for (let index = 0; index < 4; index++) {
      const control = await connect(socketPath);
      expect(await control.frames.next(), `control ${index}`).toMatchObject({
        type: "hello",
        role: "control",
      });
    }
    const overflow = await connect(socketPath);
    overflow.socket.on("error", () => {});
    expect(await overflow.frames.next()).toMatchObject({
      type: "error",
      code: "control_clients_exhausted",
      fatal: true,
    });
  });

  it("delivers status to a control connection so the caller learns the outcome", async () => {
    // A switch that is refused (busy, unchanged, invalid) has to reach whoever
    // asked. Without this the caller sees a socket that accepted the frame and
    // nothing else — the same silent shape the feature removes.
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, { onSetModel: () => {} });
    const human = await connect(socketPath);
    await human.frames.next();
    const controller = await connect(socketPath);
    await controller.frames.next();

    expect(server.broadcastStatus({ modelSwitch: { ok: false, code: "busy" } })).toBe(true);
    expect(await controller.frames.next()).toEqual({
      type: "status",
      status: { modelSwitch: { ok: false, code: "busy" } },
    });
  });

  it("🔴 never sends terminal output to a control connection", async () => {
    // A control connection is not a terminal and has no business reading what
    // the human sees.
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, { onSetModel: () => {} });
    const human = await connect(socketPath);
    await human.frames.next();
    const controller = await connect(socketPath);
    await controller.frames.next();

    expect(server.broadcastOutput(Buffer.from("secret-pane-bytes"))).toBe(true);
    expect(await human.frames.next()).toMatchObject({ type: "output" });

    // The control connection receives the next status, not the output before it.
    server.broadcastStatus({ marker: "after-output" });
    expect(await controller.frames.next()).toEqual({
      type: "status",
      status: { marker: "after-output" },
    });
  });

  it("refuses symlinks and regular files at the socket path", async () => {
    const symlinkCase = temporarySocket();
    symlinkSync(join(symlinkCase.root, "missing-target"), symlinkCase.socketPath);
    await expect(startGrokAttachServer(baseOptions(symlinkCase.socketPath))).rejects.toThrow(
      "may not be a symlink",
    );

    const regularCase = temporarySocket();
    writeFileSync(regularCase.socketPath, "do not unlink me");
    await expect(startGrokAttachServer(baseOptions(regularCase.socketPath))).rejects.toThrow(
      "regular filesystem entry",
    );
    expect(existsSync(regularCase.socketPath)).toBe(true);
  });
});

type ServerOverrides = Partial<Parameters<typeof startGrokAttachServer>[0]>;

async function startServer(
  socketPath: string,
  overrides: ServerOverrides = {},
): Promise<GrokCopresenceAttachServer> {
  const server = await startGrokAttachServer({
    ...baseOptions(socketPath),
    ...overrides,
  });
  servers.push(server);
  return server;
}

function baseOptions(socketPath: string): Parameters<typeof startGrokAttachServer>[0] {
  return {
    socketPath,
    alias: "test-grok",
    sessionId: "session-test",
    onInput: () => {},
    onResize: () => {},
  };
}

function temporarySocket(): { root: string; socketPath: string } {
  const root = mkdtempSync(join(tmpdir(), "grok-attach-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return { root, socketPath: join(root, "attach.sock") };
}

async function connect(socketPath: string): Promise<{ socket: Socket; frames: FrameReader }> {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  const frames = new FrameReader(socket);
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once("connect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  return { socket, frames };
}

function writeFrame(socket: Socket, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed || socket.destroyed) return Promise.resolve();
  return new Promise((resolveClose) => socket.once("close", () => resolveClose()));
}

class FrameReader {
  private buffer = "";
  private readonly queued: Record<string, unknown>[] = [];
  private readonly waiting: Array<{
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(frame);
        else this.queued.push(frame);
      }
    });
    socket.on("close", () => {
      for (const waiter of this.waiting.splice(0)) {
        waiter.reject(new Error("attach socket closed before the next frame"));
      }
    });
  }

  next(): Promise<Record<string, unknown>> {
    const frame = this.queued.shift();
    if (frame) return Promise.resolve(frame);
    return withTimeout(new Promise<Record<string, unknown>>((resolveFrame, rejectFrame) => {
      this.waiting.push({ resolve: resolveFrame, reject: rejectFrame });
    }), 2_000, "timed out waiting for attach frame");
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise: withTimeout(promise, 2_000, "timed out waiting for callback"), resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

/* #1548 —— `hello` 带 status 快照。
 *
 * 为什么要有:`status` 原本只在 `broadcastStatus()`(**状态变化时**)推送。
 * 于是一个刚接进来的只读 `control` 客户端,**在下一次状态变化之前什么也收不到** ——
 * 而「没收到」和「那一格是 false」在观察上**完全相同**。
 * 诊断 #1548 时正是卡在这:`tuiReady` 只活在节点进程内存里,唯一出口是这条广播,
 * 想读它就得**扰动一个活会话去逼出一次广播**。 */
describe("#1548 hello 里的 status 快照", () => {
  it("还没广播过 → status 为 null(而不是这个键不存在)", async () => {
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, {});
    const client = await connect(socketPath);
    const hello: any = await client.frames.next();
    expect(hello.type).toBe("hello");
    // 🔴 断言的是「键在、值是 null」。若这个键干脆不出现,调用方就得靠
    //    `"status" in hello` 去猜,而那正是我们要消除的那种猜。
    expect("status" in hello).toBe(true);
    expect(hello.status).toBeNull();
    client.socket.destroy();
    await server.close();
  });

  it("🔴 广播之后接进来的客户端,hello 直接带上那一份 —— 不必等下一次变化", async () => {
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, {});
    // 先来一个客户端,让广播有接收者(broadcastStatus 在无接收者时提前返回)
    const first = await connect(socketPath);
    await first.frames.next();                        // 它自己的 hello
    server.broadcastStatus({ phase: "human_editing", tuiReady: true });
    await first.frames.next();                        // 它收到的 status 推送

    const second = await connect(socketPath);
    const hello: any = await second.frames.next();
    expect(hello.status).toEqual({ phase: "human_editing", tuiReady: true });

    first.socket.destroy();
    second.socket.destroy();
    await server.close();
  });

  /* 🔴 分母自证:上一条如果只断言"拿到了非 null",一个恒返回某个固定对象的实现
   * 也能过。这里换一份**不同**的 status 再接一个客户端,确认快照跟着变。 */
  it("快照跟随最新一次广播,不是第一次那份", async () => {
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, {});
    const first = await connect(socketPath);
    await first.frames.next();
    server.broadcastStatus({ phase: "human_editing", tuiReady: true });
    await first.frames.next();
    server.broadcastStatus({ phase: "network_turn", tuiReady: false });
    await first.frames.next();

    const second = await connect(socketPath);
    const hello: any = await second.frames.next();
    expect(hello.status).toEqual({ phase: "network_turn", tuiReady: false });
    expect(hello.status).not.toEqual({ phase: "human_editing", tuiReady: true });

    first.socket.destroy();
    second.socket.destroy();
    await server.close();
  });

  /* 🔴 「从未广播」和「广播过一个 falsy 值」必须分得开 ——
   * 否则这一格会以另一种形式重犯它要修的那个错。 */
  it("广播过 falsy 值 ≠ 从未广播", async () => {
    const { socketPath } = temporarySocket();
    const server = await startServer(socketPath, {});
    const first = await connect(socketPath);
    await first.frames.next();
    server.broadcastStatus(null);
    await first.frames.next();

    const second = await connect(socketPath);
    const hello: any = await second.frames.next();
    // 两种情况这里都是 null —— 所以再加一条:广播 0 时必须是 0,不是 null
    expect(hello.status).toBeNull();

    server.broadcastStatus(0);
    await first.frames.next();
    const third = await connect(socketPath);
    const hello3: any = await third.frames.next();
    expect(hello3.status).toBe(0);           // ← falsy,但**不是** null
    expect(hello3.status).not.toBeNull();

    first.socket.destroy();
    second.socket.destroy();
    third.socket.destroy();
    await server.close();
  });
});
