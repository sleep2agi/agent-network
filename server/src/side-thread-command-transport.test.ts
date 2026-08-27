import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SQLiteAdapter } from "./db-adapter";
import { DurableSideThreadCommandPort, SideThreadCommandStore, handleSideThreadCommandRequest } from "./side-thread-command-transport";
import { SideThreadCoordinator, SideThreadStore } from "./side-thread";

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
  test("late fork and start ACKs reconcile the coordinator across restart", async () => {
    const f = fixture();
    const owner = { userId: "user-1", username: "owner", tokenId: "utok-1", kind: "user" as const };
    const input = { requestKey: "rk-late-create", networkId: "net-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through" as const, turnId: "source-turn" }, prompt: "late receipt", attachments: [] };
    const sideStore = new SideThreadStore(f.db);
    let coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    const originalTransaction = f.db.transaction.bind(f.db);
    const failTransaction = (...nth: number[]) => { let calls = 0; (f.db as any).transaction = (fn: () => unknown) => nth.includes(++calls) ? (() => { throw new Error("injected create apply failure"); })() : originalTransaction(fn); };
    failTransaction(2);
    await expect(coordinator.create(owner, input)).rejects.toThrow("injected create apply failure");
    const side = sideStore.getByCreateKey(owner, input.requestKey)!.record;
    expect(side).toMatchObject({ state: "creating", attempts: [{ state: "starting" }], operations: [{ kind: "fork", state: "pending" }] });
    const fork = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: fork.commandId, operationId: fork.operationId, state: "accepted", errorCode: null, result: { threadId: "derived-late", turnId: null, destinationTurnId: null } });
    (f.db as any).transaction = originalTransaction;
    coordinator.close();
    coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    failTransaction(2, 3);
    await expect(coordinator.create(owner, input)).rejects.toThrow("injected create apply failure");
    expect(sideStore.getByCreateKey(owner, input.requestKey)!.record).toMatchObject({ state: "reconciling", attempts: [{ state: "reconciling" }], operations: [{ kind: "fork", state: "pending" }] });
    expect(f.store.claim(actor())).toBeNull();
    (f.db as any).transaction = originalTransaction;
    coordinator.close();
    coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    await expect(coordinator.create(owner, input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    const start = f.store.claim(actor())!;
    expect(start.kind).toBe("start");
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: start.commandId, operationId: start.operationId, state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-late", destinationTurnId: null } });
    failTransaction(3);
    await expect(coordinator.create(owner, input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(f.store.claim(actor())).toBeNull();
    (f.db as any).transaction = originalTransaction;
    coordinator.close();
    coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    expect(await coordinator.create(owner, input)).toMatchObject({ state: "running", threadId: "derived-late", attempts: [{ turnId: "turn-late" }] });
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: side.sideChatId, attemptId: side.activeAttemptId!, threadId: "derived-late", turnId: "turn-late", status: "completed" as const, text: "late answer", errorCode: null };
    expect((await f.port.acceptTerminal(actor(), terminal)).confirmed).toBe(true);

    expect(await coordinator.create(owner, input)).toMatchObject({ sideChatId: side.sideChatId, state: "completed", threadId: "derived-late", attempts: [{ turnId: "turn-late", result: "late answer" }] });
    expect(coordinator.get(owner, side.sideChatId).operations.filter((operation) => operation.kind === "fork" || operation.kind === "start")).toHaveLength(2);
    expect(f.store.claim(actor())).toBeNull();
    expect((await f.port.acceptTerminal(actor(), terminal)).idempotent).toBe(true);
    expect(coordinator.get(owner, side.sideChatId)).toMatchObject({ state: "completed", attempts: [{ result: "late answer" }] });
    coordinator.close();
  });

  for (const receipt of [
    { state: "unsupported", errorCode: "SIDE_THREAD_UNSUPPORTED", code: "SIDE_THREAD_UNSUPPORTED", status: 501 },
    { state: "failed", errorCode: "SIDE_THREAD_CONFLICT", code: "SIDE_THREAD_CONFLICT", status: 409 },
  ] as const) test(`late ${receipt.state} fork ACK converges to stable failed across coordinators`, async () => {
    const f = fixture();
    const owner = { userId: "user-1", username: "owner", tokenId: "utok-1", kind: "user" as const };
    const input = { requestKey: `rk-late-${receipt.state}`, networkId: "net-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through" as const, turnId: "source-turn" }, prompt: "late failure", attachments: [] };
    const sideStore = new SideThreadStore(f.db);
    let first = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    await expect(first.create(owner, input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: command.operationId, state: receipt.state, errorCode: receipt.errorCode, result: { threadId: null, turnId: null, destinationTurnId: null } });
    first.close();

    const second = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    await expect(second.create(owner, input)).rejects.toMatchObject({ code: receipt.code, status: receipt.status });
    const failed = sideStore.getByCreateKey(owner, input.requestKey)!.record;
    expect(failed).toMatchObject({ state: "failed", attempts: [{ state: "failed" }], operations: [{ kind: "fork", state: "failed", errorCode: receipt.code }] });
    expect(failed.activeAttemptId).toBeUndefined();
    expect(f.db.get<{ active: string | null }>("SELECT active_attempt_id active FROM side_chats WHERE side_chat_id=?1", failed.sideChatId)?.active).toBeNull();
    expect(await second.create(owner, input)).toMatchObject({ sideChatId: failed.sideChatId, state: "failed" });
    expect(f.store.claim(actor())).toBeNull();
    second.close();
  });

  for (const action of ["cancel", "archive", "purge", "bring-back"] as const)
    for (const receipt of [
      { state: "accepted", errorCode: null, code: null },
      { state: "unsupported", errorCode: "SIDE_THREAD_UNSUPPORTED", code: "SIDE_THREAD_UNSUPPORTED" },
      { state: "failed", errorCode: "SIDE_THREAD_CONFLICT", code: "SIDE_THREAD_CONFLICT" },
    ] as const) test(`${action} consumes a late ${receipt.state} receipt after restart`, async () => {
      const f = fixture();
      const owner = { userId: "user-1", username: "owner", tokenId: "utok-1", kind: "user" as const };
      const input = { requestKey: `rk-create-${action}-${receipt.state}`, networkId: "net-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through" as const, turnId: "source-turn" }, prompt: "lifecycle", attachments: [] };
      const sideStore = new SideThreadStore(f.db);
      let coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
      await coordinator.create(owner, input).catch(() => {});
      const fork = f.store.claim(actor())!;
      f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: fork.commandId, operationId: fork.operationId, state: "accepted", errorCode: null, result: { threadId: "derived-life", turnId: null, destinationTurnId: null } });
      await coordinator.create(owner, input).catch(() => {});
      const start = f.store.claim(actor())!;
      f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: start.commandId, operationId: start.operationId, state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-life", destinationTurnId: null } });
      const running = await coordinator.create(owner, input);
      if (action !== "cancel") await f.port.acceptTerminal(actor(), { protocol: "side_thread.terminal.v1", sideThreadId: running.sideChatId, attemptId: running.activeAttemptId!, threadId: "derived-life", turnId: "turn-life", status: "completed", text: "answer", errorCode: null });
      const requestKey = `rk-${action}-${receipt.state}`;
      const invoke = (c: SideThreadCoordinator) => action === "cancel" ? c.cancel(owner, running.sideChatId, { requestKey })
        : action === "archive" ? c.archive(owner, running.sideChatId, { requestKey })
        : action === "purge" ? c.purge(owner, running.sideChatId, { requestKey })
        : c.bringBack(owner, running.sideChatId, { requestKey, destinationThreadId: "source-1" });
      await invoke(coordinator).catch(() => {});
      const command = f.store.claim(actor())!;
      f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: command.operationId, state: receipt.state, errorCode: receipt.errorCode, result: { threadId: null, turnId: null, destinationTurnId: action === "bring-back" && receipt.state === "accepted" ? "destination-life" : null } });
      coordinator.close();
      coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
      if (receipt.code) {
        await expect(invoke(coordinator)).rejects.toMatchObject({ code: receipt.code });
        await expect(invoke(coordinator)).rejects.toMatchObject({ code: receipt.code });
      } else {
        if (action === "archive" || action === "bring-back") {
          const originalTransaction = f.db.transaction.bind(f.db);
          let failApply = true;
          (f.db as any).transaction = (fn: () => unknown) => {
            if (failApply) { failApply = false; throw new Error("injected local apply failure"); }
            return originalTransaction(fn);
          };
          await expect(invoke(coordinator)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS", status: 202 });
          const unsettled = sideStore.getByCreateKey(owner, input.requestKey)!.record.operations.find((op) => op.kind === action && op.requestKey === requestKey)!;
          expect(["ambiguous", "reconciling"]).toContain(unsettled.state);
          expect(unsettled.state).not.toBe("failed");
          (f.db as any).transaction = originalTransaction;
          coordinator.close();
          coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
        }
        const [one, two] = await Promise.all([invoke(coordinator), invoke(coordinator)]);
        if (action === "bring-back") expect(one).toEqual({ bringBackId: expect.any(String), destinationTurnId: "destination-life" });
        else expect(one).toMatchObject({ state: action === "cancel" ? "running" : action === "archive" ? "archived" : "purged" });
        expect(two).toEqual(one);
        const hydrated = coordinator.get(owner, running.sideChatId);
        const operation = hydrated.operations.find((op) => op.kind === action && op.requestKey === requestKey)!;
        expect(operation).toMatchObject({ state: "completed", threadId: action === "bring-back" ? "source-1" : "derived-life" });
        if (action === "bring-back") expect(operation.turnId).toBe("destination-life");
        if (action === "cancel") expect(operation.turnId).toBe("turn-life");
        const domainType = action === "bring-back" ? "side_chat.brought_back" : action === "archive" ? "side_chat.archived" : action === "purge" ? "side_chat.purged" : null;
        const afterEvents = coordinator.listEvents(owner, running.sideChatId);
        if (domainType) expect(afterEvents.filter((event) => event.type === domainType)).toHaveLength(1);
        else expect(afterEvents.filter((event) => ["side_chat.brought_back", "side_chat.archived", "side_chat.purged"].includes(event.type))).toHaveLength(0);
      }
      expect(f.store.claim(actor())).toBeNull();
      coordinator.close();
    });

  test("two coordinators race a late archive receipt but persist one domain event", async () => {
    const f = fixture();
    const owner = { userId: "user-1", username: "owner", tokenId: "utok-1", kind: "user" as const };
    const input = { requestKey: "rk-multi-archive-create", networkId: "net-1", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through" as const, turnId: "source-turn" }, prompt: "multi", attachments: [] };
    const sideStore = new SideThreadStore(f.db);
    const bootstrap = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    await bootstrap.create(owner, input).catch(() => {});
    const fork = f.store.claim(actor())!; f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: fork.commandId, operationId: fork.operationId, state: "accepted", errorCode: null, result: { threadId: "derived-multi", turnId: null, destinationTurnId: null } });
    await bootstrap.create(owner, input).catch(() => {});
    const start = f.store.claim(actor())!; f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: start.commandId, operationId: start.operationId, state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-multi", destinationTurnId: null } });
    const running = await bootstrap.create(owner, input);
    await f.port.acceptTerminal(actor(), { protocol: "side_thread.terminal.v1", sideThreadId: running.sideChatId, attemptId: running.activeAttemptId!, threadId: "derived-multi", turnId: "turn-multi", status: "completed", text: "done", errorCode: null });
    await bootstrap.archive(owner, running.sideChatId, { requestKey: "rk-multi-archive" }).catch(() => {});
    const archive = f.store.claim(actor())!; f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: archive.commandId, operationId: archive.operationId, state: "accepted", errorCode: null, result: { threadId: null, turnId: null, destinationTurnId: null } });
    bootstrap.close();
    const port = () => new DurableSideThreadCommandPort({ store: f.store, networkForNode: () => "net-1", capabilityForNode: () => ({ supported: true, mode: "native-exact-fork", exactBoundary: { through: true, before: true } }), grantAttachment: (_node, ref) => ({ fileId: ref.fileId }) });
    const a = new SideThreadCoordinator(sideStore, port(), { enabled: true, authorizeNode: () => true });
    const b = new SideThreadCoordinator(sideStore, port(), { enabled: true, authorizeNode: () => true });
    const [one, two] = await Promise.all([a.archive(owner, running.sideChatId, { requestKey: "rk-multi-archive" }), b.archive(owner, running.sideChatId, { requestKey: "rk-multi-archive" })]);
    expect(one.state).toBe("archived"); expect(two.state).toBe("archived");
    expect(sideStore.events(running.sideChatId).filter((event) => event.type === "side_chat.archived")).toHaveLength(1);
    expect(f.store.claim(actor())).toBeNull();
    a.close(); b.close();
  });

  test("fails closed on the currently non-atomic PostgreSQL adapter", () => {
    expect(() => new SideThreadCommandStore({ dialect: "postgres" } as any)).toThrow(/atomic SQLite/);
  });
  test("allows exactly one durable terminal applier", () => {
    const f = fixture(); const close = f.port.subscribe(async () => {});
    expect(() => f.port.subscribe(async () => {})).toThrow(/exactly one/);
    close();
  });
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
    await expect(f.port.acceptTerminal(actor(), { ...terminal, turnId: "turn-foreign" })).rejects.toThrow(/four-tuple/);
    expect((await f.port.acceptTerminal(actor(), terminal)).idempotent).toBe(false);
    expect((await f.port.acceptTerminal(actor(), terminal)).idempotent).toBe(true);
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
    const f = fixture(); f.port.subscribe(async () => {});
    await f.port.start({ operationId: "op-hostile", requestKey: "rk-hostile", sideChatId: "side-hostile", attemptId: "attempt-hostile", nodeId: "node-1", threadId: "derived-hostile", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    const clean = { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-hostile", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-hostile", destinationTurnId: null } };
    expect(() => f.store.ack(actor(), { ...clean, exception: "Bearer ntok_secret" })).toThrow(/unexpected protocol fields/);
    f.store.ack(actor(), clean);
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-hostile", attemptId: "attempt-hostile", threadId: "derived-hostile", turnId: "turn-hostile", status: "completed", text: "ok", errorCode: null };
    await expect(f.port.acceptTerminal(actor(), { ...terminal, stack: "secret" })).rejects.toThrow(/unexpected protocol fields/);
    await expect(f.port.acceptTerminal(actor(), { ...terminal, text: "x".repeat(1_000_001) })).rejects.toThrow(/completed terminal payload/);
    expect((await f.port.acceptTerminal(actor(), terminal)).idempotent).toBe(false);
  });

  test("receipt commit followed by listener failure remains durably redeliverable", async () => {
    const f = fixture(); let calls = 0;
    f.port.subscribe(async () => { calls++; if (calls === 1) throw new Error("coordinator crashed"); });
    await f.port.start({ operationId: "op-terminal-crash", requestKey: "rk-terminal-crash", sideChatId: "side-crash", attemptId: "attempt-crash", nodeId: "node-1", threadId: "derived-crash", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-terminal-crash", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-crash", destinationTurnId: null } });
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-crash", attemptId: "attempt-crash", threadId: "derived-crash", turnId: "turn-crash", status: "completed", text: "answer", errorCode: null };
    await expect(f.port.acceptTerminal(actor(), terminal)).rejects.toThrow(/coordinator crashed/);
    expect((await f.port.acceptTerminal(actor(), terminal)).pending).toBe(false);
    expect(calls).toBe(2);
  });

  test("concurrent terminal POST cannot acknowledge WAL deletion while apply is pending", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.port.subscribe(async () => { await gate; throw new Error("late apply failure"); });
    await f.port.start({ operationId: "op-concurrent-terminal", requestKey: "rk-concurrent-terminal", sideChatId: "side-concurrent", attemptId: "attempt-concurrent", nodeId: "node-1", threadId: "derived-concurrent", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-concurrent-terminal", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-concurrent", destinationTurnId: null } });
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-concurrent", attemptId: "attempt-concurrent", threadId: "derived-concurrent", turnId: "turn-concurrent", status: "completed", text: "answer", errorCode: null };
    const url = new URL("http://hub/api/nodes/node-1/side-thread-commands/terminals");
    const call = () => handleSideThreadCommandRequest({ req: new Request(url, { method: "POST", body: JSON.stringify(terminal) }), url, actor: actor(), store: f.store, port: f.port });
    const first = call(); await Bun.sleep(10);
    const second = await call();
    expect(second?.status).toBe(503);
    expect(await second?.json()).toMatchObject({ ok: false, retryable: true });
    release();
    expect((await first)?.status).toBe(409);
    expect(f.store.terminalApplyState(["side-concurrent", "attempt-concurrent", "derived-concurrent", "turn-concurrent"])).toBe("received");
  });

  test("real coordinator database failure rejects apply and leaves receipt retryable", async () => {
    const f = fixture();
    const sideStore = new SideThreadStore(f.db);
    const coordinator = new SideThreadCoordinator(sideStore, f.port, { enabled: true, authorizeNode: () => true });
    await f.port.start({ operationId: "op-db-fail", requestKey: "rk-db-fail", sideChatId: "side-db", attemptId: "attempt-db", nodeId: "node-1", threadId: "derived-db", prompt: "q", attachments: [] }).catch(() => {});
    const command = f.store.claim(actor())!;
    f.store.ack(actor(), { protocol: "side_thread.ack.v1", commandId: command.commandId, operationId: "op-db-fail", state: "accepted", errorCode: null, result: { threadId: null, turnId: "turn-db", destinationTurnId: null } });
    const original = f.db.transaction.bind(f.db);
    (f.db as any).transaction = () => { throw new Error("disk I/O failure"); };
    const terminal = { protocol: "side_thread.terminal.v1", sideThreadId: "side-db", attemptId: "attempt-db", threadId: "derived-db", turnId: "turn-db", status: "completed", text: "answer", errorCode: null };
    await expect(f.port.acceptTerminal(actor(), terminal)).rejects.toThrow(/disk I\/O/);
    expect(f.store.terminalApplyState(["side-db", "attempt-db", "derived-db", "turn-db"])).toBe("received");
    (f.db as any).transaction = original;
    coordinator.close();
  });
});
