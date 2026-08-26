import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteAdapter } from "./db-adapter";
import { DurableSideThreadCommandPort, SideThreadCommandStore, handleSideThreadCommandRequest } from "./side-thread-command-transport";

function actor(tokenId = "tok-node") { return { tokenId, networkId: "net-1", nodeId: "node-1" }; }
function fixture() {
  const db = new SQLiteAdapter(new Database(":memory:"));
  db.exec("CREATE TABLE inbox(id TEXT PRIMARY KEY, content TEXT)");
  const store = new SideThreadCommandStore(db, () => 123);
  const port = new DurableSideThreadCommandPort({ store, networkForNode: (id) => id === "node-1" ? "net-1" : null,
    capabilityForNode: () => ({ supported: true, mode: "native-exact-fork", exactBoundary: { through: true, before: true } }),
    grantAttachment: (_node, ref) => ({ fileId: ref.fileId, grantId: `grant-${ref.fileId}`, sha256: "a".repeat(64), size: 7, mediaType: "image/png" }) });
  return { db, store, port };
}

describe("Hub durable SideThread command outbox", () => {
  test("queues outside inbox/FIFO and only exact node token can retain the delivery", async () => {
    const f = fixture();
    await expect(f.port.fork({ operationId: "op-1", requestKey: "rk-1", sideChatId: "side-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through", turnId: "source-turn" } })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) n FROM inbox")!.n).toBe(0);
    expect(f.store.claim({ ...actor(), nodeId: "node-2" })).toBeNull();
    const delivered = f.store.claim(actor())!;
    expect(delivered).toMatchObject({ protocol: "side_thread.command.v1", operationId: "op-1", nodeId: "node-1" });
    expect(f.store.claim(actor())).toEqual(delivered);
  });

  test("ACK response loss is idempotent and foreign token/collision cannot rewrite it", async () => {
    const f = fixture();
    await f.port.start({ operationId: "op-start", requestKey: "rk-start", sideChatId: "side-1", attemptId: "attempt-1", nodeId: "node-1", threadId: "derived-1", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    const ack = { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-start", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-1", destinationTurnId: null } };
    expect(f.store.ack(actor(), ack).idempotent).toBe(false);
    expect(f.store.ack(actor(), ack).idempotent).toBe(true);
    expect(() => f.store.ack(actor("tok-foreign"), ack)).toThrow(/ownership/);
    expect(() => f.store.ack(actor(), { ...ack, state: "failed", errorCode: "SIDE_THREAD_CONFLICT" })).toThrow(/immutable/);
  });

  test("terminal receipt requires exact side/attempt/thread/turn tuple and is replay-safe", async () => {
    const f = fixture(); const events: any[] = []; f.port.subscribe((e) => events.push(e));
    await f.port.start({ operationId: "op-start", requestKey: "rk-start", sideChatId: "side-1", attemptId: "attempt-1", nodeId: "node-1", threadId: "derived-1", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-start", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-1", destinationTurnId: null } });
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-1", attemptId: "attempt-1", threadId: "derived-1", turnId: "turn-1", status: "completed", text: "answer", errorCode: null };
    expect(() => f.port.acceptTerminal(actor(), { ...terminal, turnId: "turn-foreign" })).toThrow(/four-tuple/);
    expect(f.port.acceptTerminal(actor(), terminal).idempotent).toBe(false);
    expect(f.port.acceptTerminal(actor(), terminal).idempotent).toBe(true);
    expect(events).toHaveLength(1);
  });

  test("durable accepted receipt reconciles a later POST retry without a second delivery", async () => {
    const f = fixture(); const input = { operationId: "op-fork", requestKey: "rk-fork", sideChatId: "side-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "before" as const, turnId: "source-turn" } };
    await f.port.fork(input).catch(() => {});
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: input.operationId, state: "accepted", errorCode: null, result: { threadId: "derived-1", turnId: null, destinationTurnId: null } });
    expect(await f.port.fork(input)).toEqual({ threadId: "derived-1" });
    expect(f.store.claim(actor())).toBeNull();
  });

  test("HTTP surface binds path node and ACK body to the authenticated node actor", async () => {
    const f = fixture();
    await f.port.fork({ operationId: "op-http", requestKey: "rk-http", sideChatId: "side-http", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through", turnId: "t-1" } }).catch(() => {});
    const foreign = await handleSideThreadCommandRequest({ req: new Request("http://hub/api/nodes/node-1/side-thread-commands/pending"), url: new URL("http://hub/api/nodes/node-1/side-thread-commands/pending"), actor: { ...actor(), nodeId: "node-2" }, store: f.store, port: f.port });
    expect(foreign?.status).toBe(403);
    const pulled = await handleSideThreadCommandRequest({ req: new Request("http://hub/api/nodes/node-1/side-thread-commands/pending"), url: new URL("http://hub/api/nodes/node-1/side-thread-commands/pending"), actor: actor(), store: f.store, port: f.port });
    const command = (await pulled!.json() as any).command;
    const badBody = { protocol: "side_thread.ack.v1", commandId: "other-command", operationId: command.operationId, state: "accepted", errorCode: null, result: { threadId: "derived", turnId: null, destinationTurnId: null } };
    const rejected = await handleSideThreadCommandRequest({ req: new Request(`http://hub/api/nodes/node-1/side-thread-commands/${command.commandId}/ack`, { method: "POST", body: JSON.stringify(badBody) }), url: new URL(`http://hub/api/nodes/node-1/side-thread-commands/${command.commandId}/ack`), actor: actor(), store: f.store, port: f.port });
    expect(rejected?.status).toBe(409);
  });

  test("hostile node cannot smuggle extra receipt fields or unbounded terminal text", async () => {
    const f = fixture();
    await f.port.start({ operationId: "op-hostile", requestKey: "rk-hostile", sideChatId: "side-hostile", attemptId: "attempt-hostile", nodeId: "node-1", threadId: "derived-hostile", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    const clean = { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-hostile", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-hostile", destinationTurnId: null } };
    expect(() => f.store.ack(actor(), { ...clean, exception: "Bearer ntok_secret" })).toThrow(/unexpected protocol fields/);
    f.store.ack(actor(), clean);
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-hostile", attemptId: "attempt-hostile", threadId: "derived-hostile", turnId: "turn-hostile", status: "completed", text: "ok", errorCode: null };
    expect(() => f.port.acceptTerminal(actor(), { ...terminal, stack: "secret" })).toThrow(/unexpected protocol fields/);
    expect(() => f.port.acceptTerminal(actor(), { ...terminal, text: "x".repeat(1_000_001) })).toThrow(/completed terminal payload/);
    expect(f.port.acceptTerminal(actor(), terminal).idempotent).toBe(false);
  });
});
