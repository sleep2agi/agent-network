import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateFileCommandReceiptStore } from "./command-receipts";
import { JournaledBringBackExecutor } from "./bring-back-journal";
import { materializeCommandAttachment } from "./materialize-command-attachment";
import { SideThreadCommandConsumer } from "./command-consumer";
import { PrivateFileForkLeaseStore } from "./fork-lease";
import { PrivateFileTerminalOutbox } from "./terminal-outbox";
import {
  SIDE_THREAD_COMMAND_PROTOCOL, SideThreadCommandExecutor,
  type SideThreadCommand, type SideThreadTerminalEnvelope,
} from "./command-transport";
import type { SideThreadRuntimeAdapter } from "./domain";

function command(kind: SideThreadCommand["kind"], payload: any, attemptId: string | null = null): any {
  return { protocol: SIDE_THREAD_COMMAND_PROTOCOL, commandId: `cmd-${kind}`, operationId: `op-${kind}`,
    requestKey: `rk-${kind}`, nodeId: "node-1", sideThreadId: "side-1", attemptId, kind, payload };
}

function fixture() {
  let forkCalls = 0, startCalls = 0;
  let listener: any = () => {};
  const adapter: SideThreadRuntimeAdapter = {
    capability: () => ({ supported: true, runtime: "codex-app-server", runtimeVersion: "x", topology: "remote", evidenceRevision: "r", mode: "native-exact-fork", exactBoundary: { through: true, before: true } }),
    async fork() { forkCalls++; return { derivedThreadId: "derived-1" }; },
    async start(input) { startCalls++; expect(input.attachments?.[0]?.path).toBe("/private/cache/file"); return { turnId: "turn-1" }; },
    async cancel() {}, async archive() {}, async delete() {},
    subscribe(fn) { listener = fn; return () => { listener = () => {}; }; },
  };
  const root = mkdtempSync(join(tmpdir(), "side-command-"));
  const claims = new PrivateFileForkLeaseStore(join(root, "claims"));
  const terminalOutbox = new PrivateFileTerminalOutbox(join(root, "terminals"));
  const options = { nodeId: "node-1", adapter, receipts: new PrivateFileCommandReceiptStore(root),
    claimExecution: ({ nodeId, sideThreadId, operationId }: any) => claims.claimOperation(nodeId, sideThreadId, operationId),
    terminalOutbox };
  return { adapter, options, root, terminalOutbox, terminals: () => terminalOutbox.list(), emit: (x: any) => listener(x), calls: () => ({ forkCalls, startCalls }) };
}

describe("SideThread dedicated node command boundary", () => {
  test("durable receipt makes an ACK-loss replay mutation-free across executor restart", async () => {
    const f = fixture();
    const raw = command("fork", { sourceThreadId: "source-1", boundary: { kind: "through", turnId: "source-turn" } });
    const one = new SideThreadCommandExecutor(f.options);
    expect((await one.execute(raw)).result.threadId).toBe("derived-1");
    one.close();
    const restarted = new SideThreadCommandExecutor({ ...f.options, receipts: new PrivateFileCommandReceiptStore(f.root) });
    expect((await restarted.execute(raw)).result.threadId).toBe("derived-1");
    expect(f.calls().forkCalls).toBe(1);
    const receipt = readFileSync(join(f.root, "cmd-fork.json"), "utf8");
    expect(statSync(join(f.root, "cmd-fork.json")).mode & 0o777).toBe(0o600);
    expect(receipt).not.toContain("Bearer");
  });

  test("same command identity with changed payload fails closed", async () => {
    const f = fixture();
    const executor = new SideThreadCommandExecutor(f.options);
    const raw = command("fork", { sourceThreadId: "source-1", boundary: { kind: "through", turnId: "t1" } });
    await executor.execute(raw);
    expect((await executor.execute({ ...raw, payload: { ...raw.payload, sourceThreadId: "source-2" } })).state).toBe("failed");
    expect(f.calls().forkCalls).toBe(1);
  });

  test("all attachments materialize and verify before start; no text-only downgrade", async () => {
    const f = fixture();
    const grant = { fileId: "file_12345678", grantId: "grant-1", sha256: "a".repeat(64), size: 7, mediaType: "image/png" };
    const executor = new SideThreadCommandExecutor({ ...f.options, materializeAttachment: async (got) => ({ path: "/private/cache/file", mediaType: got.mediaType, sha256: got.sha256, size: got.size }) });
    const ack = await executor.execute(command("start", { threadId: "derived-1", question: "inspect", attachments: [grant] }, "attempt-1"));
    expect(ack.state).toBe("accepted");
    expect(f.calls().startCalls).toBe(1);

    const g = fixture();
    const refused = new SideThreadCommandExecutor({ ...g.options, materializeAttachment: async () => ({ path: "/bad", mediaType: "image/png", sha256: "b".repeat(64), size: 7 }) });
    expect((await refused.execute(command("start", { threadId: "derived-1", question: "inspect", attachments: [grant] }, "attempt-1"))).state).toBe("unsupported");
    expect(g.calls().startCalls).toBe(0);
  });

  test("bring-back is native+journal injected or unsupported, never a task fallback", async () => {
    const raw = command("bring-back", { sourceThreadId: "derived-1", sourceTurnId: "turn-1", destinationThreadId: "source-1", text: "answer" }, "attempt-1");
    const f = fixture();
    expect((await new SideThreadCommandExecutor(f.options).execute(raw)).state).toBe("unsupported");
    let calls = 0;
    const g = fixture();
    const executor = new SideThreadCommandExecutor({ ...g.options, bringBack: async () => { calls++; return { destinationTurnId: "destination-turn" }; } });
    expect((await executor.execute(raw)).result.destinationTurnId).toBe("destination-turn");
    expect((await executor.execute(raw)).result.destinationTurnId).toBe("destination-turn");
    expect(calls).toBe(1);
  });

  test("only identity-bound four-tuple terminal events leave the node", async () => {
    const f = fixture();
    new SideThreadCommandExecutor(f.options);
    f.emit({ sideThreadId: "side-1", attemptId: "attempt-1", threadId: "derived-1", turnId: "turn-1", status: "completed", text: "ok", identityBound: false });
    f.emit({ sideThreadId: "side-1", attemptId: "attempt-1", threadId: "derived-1", turnId: "turn-1", status: "completed", text: "ok", identityBound: true });
    await Bun.sleep(0);
    expect(f.terminals()).toHaveLength(1);
    expect(f.terminals()[0]).toMatchObject({ sideThreadId: "side-1", attemptId: "attempt-1", threadId: "derived-1", turnId: "turn-1" });
  });

  test("bring-back write-ahead journal fails closed after response loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "bring-back-")); let sends = 0;
    const lost = new JournaledBringBackExecutor(root, async () => { sends++; throw new Error("response lost"); });
    const input = { operationId: "op-bring", destinationThreadId: "source-1", text: "answer" };
    await expect(lost.execute(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    const restarted = new JournaledBringBackExecutor(root, async () => { sends++; return { destinationTurnId: "duplicate" }; });
    await expect(restarted.execute(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(sends).toBe(1);
  });

  test("attachment grant is bound to node token, exact size and digest", async () => {
    const bytes = new TextEncoder().encode("picture");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const cacheDir = mkdtempSync(join(tmpdir(), "grant-cache-")); let authorization = "";
    const result = await materializeCommandAttachment({ fileId: "file_12345678", grantId: "grant-1", sha256, size: bytes.length, mediaType: "image/png" }, {
      hubUrl: "https://hub.invalid/", nodeToken: "ntok_bound", cacheDir,
      fetchImpl: (async (_url, init) => { authorization = String((init?.headers as any).Authorization); return new Response(bytes, { headers: { "content-length": String(bytes.length) } }); }) as typeof fetch,
    });
    expect(authorization).toBe("Bearer ntok_bound");
    expect(readFileSync(result.path)).toEqual(Buffer.from(bytes));
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    await expect(materializeCommandAttachment({ fileId: "file_12345678", grantId: "grant-2", sha256: "0".repeat(64), size: bytes.length, mediaType: "image/png" }, {
      hubUrl: "https://hub.invalid", nodeToken: "ntok_bound", cacheDir,
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    })).rejects.toThrow(/digest mismatch/);
  });

  test("consumer replays a durable receipt after ACK response loss without native replay", async () => {
    const f = fixture(); const raw = command("fork", { sourceThreadId: "source-1", boundary: { kind: "through", turnId: "t-1" } });
    let ackPosts = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pending")) return Response.json({ ok: true, command: raw });
      if (url.endsWith("/ack")) { ackPosts++; if (ackPosts === 1) return new Response("lost", { status: 503 }); return Response.json({ ok: true }); }
      throw new Error("unexpected transport");
    }) as typeof fetch;
    const one = new SideThreadCommandConsumer({ hubUrl: "https://hub.invalid", nodeId: "node-1", token: "ntok_bound", executor: new SideThreadCommandExecutor(f.options), terminalOutbox: f.terminalOutbox, fetchImpl });
    await expect(one.trigger()).rejects.toThrow(/ACK failed/);
    const restarted = new SideThreadCommandConsumer({ hubUrl: "https://hub.invalid", nodeId: "node-1", token: "ntok_bound", executor: new SideThreadCommandExecutor({ ...f.options, receipts: new PrivateFileCommandReceiptStore(f.root) }), terminalOutbox: f.terminalOutbox, fetchImpl });
    await restarted.trigger();
    expect(f.calls().forkCalls).toBe(1);
    expect(ackPosts).toBe(2);
  });

  test("two executors cannot concurrently cross receipt/native/receipt boundary", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    f.adapter.fork = async () => { calls++; await gate; return { derivedThreadId: "derived-1" }; };
    const raw = command("fork", { sourceThreadId: "source-1", boundary: { kind: "through", turnId: "t-1" } });
    const one = new SideThreadCommandExecutor(f.options);
    const two = new SideThreadCommandExecutor({ ...f.options, receipts: new PrivateFileCommandReceiptStore(f.root) });
    const first = one.execute(raw);
    await Bun.sleep(25);
    const second = two.execute(raw).then(() => "resolved", (error) => /already claimed/.test(String(error)) ? "claimed" : "other-error");
    await Bun.sleep(25);
    const callsBeforeRelease = calls;
    release();
    expect((await first).state).toBe("accepted");
    expect(await second).toBe("claimed");
    expect(callsBeforeRelease).toBe(1);
  });

  test("terminal POST response loss survives consumer restart and drains before commands", async () => {
    const f = fixture();
    new SideThreadCommandExecutor(f.options);
    f.emit({ sideThreadId: "side-terminal", attemptId: "attempt-terminal", threadId: "derived-terminal", turnId: "turn-terminal", status: "completed", text: "answer", identityBound: true });
    await Bun.sleep(0);
    expect(f.terminalOutbox.list()).toHaveLength(1);
    let posts = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/terminals")) { posts++; return posts === 1 ? new Response("lost", { status: 503 }) : Response.json({ ok: true, idempotent: true }); }
      if (url.endsWith("/pending")) return Response.json({ ok: true, command: null });
      throw new Error("unexpected request");
    }) as typeof fetch;
    const consumer = () => new SideThreadCommandConsumer({ hubUrl: "https://hub.invalid", nodeId: "node-1", token: "ntok_bound", executor: new SideThreadCommandExecutor(f.options), terminalOutbox: new PrivateFileTerminalOutbox(join(f.root, "terminals")), fetchImpl });
    await expect(consumer().trigger()).rejects.toThrow(/terminal POST failed/);
    expect(f.terminalOutbox.list()).toHaveLength(1);
    await consumer().trigger();
    expect(f.terminalOutbox.list()).toHaveLength(0);
    expect(posts).toBe(2);
  });
});
