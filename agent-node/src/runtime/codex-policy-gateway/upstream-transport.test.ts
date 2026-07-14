import { afterEach, describe, expect, test } from "bun:test";
import WebSocket, { WebSocketServer } from "ws";
import { CodexUpstreamTransport } from "./upstream-transport";

function expectBaseNativePromise(value: Promise<unknown>): void {
  expect(Object.getPrototypeOf(value)).toBe(Promise.prototype);
  expect(Object.prototype.hasOwnProperty.call(value, "constructor")).toBe(false);
}

async function listeningServer(): Promise<{
  server: WebSocketServer;
  url: string;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server address");
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

function nextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve) => server.once("connection", resolve));
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("CodexUpstreamTransport real ws boundary", () => {
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) await closeServer(servers.pop()!);
  });

  test("connect/probe/write/close return same-realm base Promises and close observes ws close", async () => {
    const fixture = await listeningServer();
    servers.push(fixture.server);
    const peerPromise = nextConnection(fixture.server);
    const transport = new CodexUpstreamTransport({ url: fixture.url });

    const connectPromise = transport.connect();
    expectBaseNativePromise(connectPromise);
    await connectPromise;
    const peer = await peerPromise;

    let messageCount = 0;
    peer.on("message", () => messageCount++);
    const probePromise = transport.probe();
    expectBaseNativePromise(probePromise);
    await probePromise;
    await Promise.resolve();
    expect(messageCount).toBe(0);

    const received = new Promise<string>((resolve) => {
      peer.once("message", (data) => resolve(data.toString("utf8")));
    });
    const writePromise = transport.writeFrame({
      jsonrpc: "2.0",
      method: "initialized",
    });
    expectBaseNativePromise(writePromise);
    await writePromise;
    expect(JSON.parse(await received)).toEqual({ jsonrpc: "2.0", method: "initialized" });

    let localCloseObserved = false;
    transport.onClose(() => {
      localCloseObserved = true;
    });
    const peerClose = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    const closePromise = transport.close();
    expectBaseNativePromise(closePromise);
    await closePromise;
    expect(localCloseObserved).toBe(true);
    await peerClose;

    let lateCloseObserved = false;
    transport.onClose(() => {
      lateCloseObserved = true;
    });
    await Promise.resolve();
    expect(lateCloseObserved).toBe(true);
  });

  test("writeFrame waits for ws send callback", async () => {
    const fixture = await listeningServer();
    servers.push(fixture.server);
    const transport = new CodexUpstreamTransport({ url: fixture.url });
    const peerPromise = nextConnection(fixture.server);
    await transport.connect();
    const peer = await peerPromise;

    const socket = (transport as unknown as { ws: WebSocket }).ws;
    const realSend = socket.send.bind(socket);
    let release: (() => void) | null = null;
    socket.send = ((data: unknown, callback?: (error?: Error) => void) => {
      release = () => realSend(data as never, callback as never);
    }) as typeof socket.send;

    let settled = false;
    const writePromise = transport.writeFrame({ jsonrpc: "2.0", method: "initialized" });
    writePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(release).not.toBeNull();
    release!();
    await writePromise;
    expect(settled).toBe(true);
    const peerClose = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    await transport.abort();
    await peerClose;
  });

  test("abort force-terminates ws, composes provider abort, and exposes a function property", async () => {
    const fixture = await listeningServer();
    servers.push(fixture.server);
    const peerPromise = nextConnection(fixture.server);
    let providerAbortCalls = 0;
    const transport = new CodexUpstreamTransport({
      url: fixture.url,
      abortUpstream: async () => {
        providerAbortCalls++;
      },
    });
    await transport.connect();
    const peer = await peerPromise;
    const peerClose = new Promise<void>((resolve) => peer.once("close", () => resolve()));

    expect(Object.prototype.hasOwnProperty.call(transport, "abort")).toBe(true);
    const abortPromise = transport.abort();
    expectBaseNativePromise(abortPromise);
    await abortPromise;
    await peerClose;
    expect(providerAbortCalls).toBe(1);

    const secondAbort = transport.abort();
    expectBaseNativePromise(secondAbort);
    await secondAbort;
    expect(providerAbortCalls).toBe(1);
  });

  test("hostile payloads and callback errors never enter diagnostics", async () => {
    const fixture = await listeningServer();
    servers.push(fixture.server);
    const peerPromise = nextConnection(fixture.server);
    const logs: string[] = [];
    const transport = new CodexUpstreamTransport({
      url: fixture.url,
      log: (message) => logs.push(message),
    });
    const frames: unknown[] = [];
    transport.onFrame((frame) => {
      frames.push(frame);
      throw new Error("RAW_HANDLER_SECRET");
    });
    transport.onNotification(() => {
      throw new Error("RAW_NOTIFICATION_SECRET");
    });
    transport.onClose(() => {
      throw new Error("RAW_CLOSE_SECRET");
    });
    await transport.connect();
    const peer = await peerPromise;

    peer.send("RAW_MALFORMED_SECRET");
    peer.send(JSON.stringify({ method: "turn/started", params: { secret: "RAW_FRAME_SECRET" } }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const peerClose = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    await transport.close();
    await peerClose;

    expect(frames[0]).toEqual({ malformed: true });
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const line of logs) {
      expect(line).toMatch(/^code=[a-z_]+ correlation=upstream-\d+$/);
      expect(line).not.toContain("RAW_");
    }
  });

  test("R2 redacts a valid upstream error before any final-A/client frame handler", async () => {
    const fixture = await listeningServer();
    servers.push(fixture.server);
    const peerPromise = nextConnection(fixture.server);
    const transport = new CodexUpstreamTransport({ url: fixture.url });
    const received = new Promise<unknown>((resolve) => transport.onFrame(resolve));
    await transport.connect();
    const peer = await peerPromise;

    peer.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      error: {
        code: -32_000,
        message: "R2_RAW_UPSTREAM_MESSAGE_MUST_NOT_ESCAPE",
        data: { secret: "R2_RAW_UPSTREAM_DATA_MUST_NOT_ESCAPE" },
      },
    }));

    const frame = await received;
    expect(frame).toEqual({
      jsonrpc: "2.0",
      id: 41,
      error: { code: -32_000, message: "upstream request failed" },
    });
    expect(JSON.stringify(frame)).not.toContain("R2_RAW_UPSTREAM");
    await transport.abort();
  });
});
