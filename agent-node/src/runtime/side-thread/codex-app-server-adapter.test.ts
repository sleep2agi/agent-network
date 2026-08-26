import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerSideThreadAdapter } from "./codex-app-server-adapter";
import { SideThreadConflictError } from "./domain";
import { operationHash, PrivateFileOperationLedger, stableOperationId, type SideThreadOperation } from "./operation-ledger";
import { PrivateFileForkLeaseStore } from "./fork-lease";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class Client extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  forkN = 0; turnN = 0;
  loseTurnStartResponse = false;
  loseForkResponse = false;
  forkResponseCreates = 1;
  holdTurnStart = false;
  loseMethods = new Set<string>();
  threads = new Map<string, any>([["main", { id: "main", turns: [{ id: "done", items: [] }] }]]);
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/list") return { data: [...this.threads.values()], nextCursor: null } as T;
    if (method === "thread/read") {
      const thread = this.threads.get(params.threadId);
      if (!thread) throw Object.assign(new Error("not found"), { code: -32001 });
      return { thread } as T;
    }
    if (method === "thread/fork") {
      let last: any;
      for (let n = 0; n < this.forkResponseCreates; n++) {
        const id = `fork-${++this.forkN}`;
        last = { id, forkedFromId: params.threadId, turns: [{ id: params.lastTurnId ?? "done", items: [] }] };
        this.threads.set(id, last);
      }
      if (this.loseForkResponse) throw new Error("fork response lost");
      return { thread: last } as T;
    }
    if (method === "turn/start") {
      if (this.holdTurnStart) return await new Promise<T>(() => {});
      const turnId = `turn-${++this.turnN}`;
      if (this.loseTurnStartResponse) {
        return await new Promise<T>((_resolve, reject) => queueMicrotask(() => {
          this.threads.get(params.threadId)?.turns.push({ id: turnId, items: [{ type: "userMessage", clientId: params.clientUserMessageId }] });
          this.emit("item/started", {
            threadId: params.threadId, turnId,
            item: { type: "userMessage", clientId: params.clientUserMessageId },
          });
          queueMicrotask(() => reject(new Error("response lost")));
        }));
      }
      this.threads.get(params.threadId)?.turns.push({ id: turnId, items: [{ type: "userMessage", clientId: params.clientUserMessageId }] });
      queueMicrotask(() => this.emit("item/started", {
          threadId: params.threadId, turnId,
          item: { type: "userMessage", clientId: params.clientUserMessageId },
        }));
      return { turn: { id: `response-${turnId}` } } as T;
    }
    if (method === "thread/delete") this.threads.delete(params.threadId);
    if (this.loseMethods.has(method)) throw new Error(`${method} response lost`);
    return {} as T;
  }
}

const make = (overrides: Partial<ConstructorParameters<typeof CodexAppServerSideThreadAdapter>[0]> = {}) => {
  const client = new Client();
  const root = mkdtempSync(join(tmpdir(), "side-adapter-")); roots.push(root);
  const adapter = new CodexAppServerSideThreadAdapter({
    client, runtimeVersion: "0.148.0", topology: "owned-stdio",
    evidenceRevision: "test1190-wire-v2", experimentalApi: true, nodeId: "node-1",
    operationLedger: new PrivateFileOperationLedger(join(root, "operations")),
    forkLeaseStore: new PrivateFileForkLeaseStore(join(root, "fork-leases")), ...overrides,
  });
  return { client, adapter, root };
};

const makeAt = (client: Client, root: string) => new CodexAppServerSideThreadAdapter({
  client, runtimeVersion: "0.148.0", topology: "owned-stdio",
  evidenceRevision: "test1190-wire-v2", experimentalApi: true, nodeId: "node-1",
  operationLedger: new PrivateFileOperationLedger(join(root, "operations")),
  forkLeaseStore: new PrivateFileForkLeaseStore(join(root, "fork-leases")), identityTimeoutMs: 5,
});

describe("CodexAppServerSideThreadAdapter", () => {
  test("capability matrix fails closed", () => {
    expect(make().adapter.capability().supported).toBe(true);
    expect(make({ runtimeVersion: "0.149.0" }).adapter.capability()).toMatchObject({ supported: false, reason: "version" });
    expect(make({ topology: "shared-websocket" }).adapter.capability()).toMatchObject({ supported: false, reason: "topology" });
    expect(make({ evidenceRevision: "blocked-v1" }).adapter.capability()).toMatchObject({ supported: false, reason: "exact-boundary" });
    expect(make({ experimentalApi: false }).adapter.capability()).toMatchObject({
      supported: true, exactBoundary: { through: true, before: false },
    });
    expect(make({ experimentalApi: "false" as any }).adapter.capability()).toMatchObject({ exactBoundary: { before: false } });
    const gatedRoot = mkdtempSync(join(tmpdir(), "side-adapter-platform-")); roots.push(gatedRoot);
    expect(make({ forkLeaseStore: new PrivateFileForkLeaseStore(gatedRoot, { platform: "win32" }) }).adapter.capability())
      .toMatchObject({ supported: false, reason: "topology" });
  });

  test("fork sends one exact boundary and no permission override", async () => {
    const { client, adapter } = make();
    await adapter.fork({ sideThreadId: "s1", sourceThreadId: "main", boundary: { kind: "through", turnId: "done-1" } });
    await adapter.fork({ sideThreadId: "s2", sourceThreadId: "main", boundary: { kind: "before", turnId: "active-2" } });
    const [a, b] = client.calls.filter((x) => x.method === "thread/fork").map((x) => x.params);
    expect(a).toEqual({ threadId: "main", ephemeral: false, lastTurnId: "done-1" });
    expect(b).toEqual({ threadId: "main", ephemeral: false, beforeTurnId: "active-2" });
    expect(JSON.stringify(client.calls)).not.toMatch(/approval|sandbox|cwd|instruction/i);
  });

  test("adapter itself fails before RPC for unsupported boundary", async () => {
    const { client, adapter } = make({ experimentalApi: false });
    await expect(adapter.fork({ sideThreadId: "s", sourceThreadId: "main", boundary: { kind: "before", turnId: "active" } }))
      .rejects.toMatchObject({ code: "SIDE_THREAD_UNSUPPORTED", reason: "experimental-api" });
    expect(client.calls).toHaveLength(0);
    await expect(adapter.fork({ sideThreadId: "s", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } }))
      .resolves.toEqual({ derivedThreadId: "fork-1" });
  });

  test("binds execution by echoed client id, not response turn id", async () => {
    const { client, adapter } = make();
    const { derivedThreadId } = await adapter.fork({ sideThreadId: "side", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const started = await adapter.start({ sideThreadId: "side", attemptId: "attempt", derivedThreadId, prompt: "question" });
    expect(started.turnId).toBe("turn-1");
    const terminals: any[] = [];
    adapter.subscribe((e) => terminals.push(e));
    client.emit("item/completed", { threadId: derivedThreadId, turnId: "turn-1", item: { type: "agentMessage", text: "answer" } });
    client.emit("turn/completed", { threadId: derivedThreadId, turn: { id: "response-turn-1", status: "completed" } });
    expect(terminals).toHaveLength(0);
    client.emit("turn/completed", { threadId: derivedThreadId, turn: { id: "turn-1", status: "completed" } });
    expect(terminals).toEqual([expect.objectContaining({ sideThreadId: "side", attemptId: "attempt", threadId: derivedThreadId, turnId: "turn-1", text: "answer" })]);
  });

  test("does not duplicate when response is lost after identity echo", async () => {
    const { client, adapter } = make();
    const { derivedThreadId } = await adapter.fork({ sideThreadId: "side", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    client.loseTurnStartResponse = true;
    await expect(adapter.start({ sideThreadId: "side", attemptId: "attempt", derivedThreadId, prompt: "q" }))
      .resolves.toEqual({ turnId: "turn-1" });
    expect(client.calls.filter((x) => x.method === "turn/start")).toHaveLength(1);
  });

  test("exact cancel refuses source, sibling, and unknown turns", async () => {
    const { client, adapter } = make();
    const a = await adapter.fork({ sideThreadId: "a", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const b = await adapter.fork({ sideThreadId: "b", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const turn = await adapter.start({ sideThreadId: "a", attemptId: "attempt-a", derivedThreadId: a.derivedThreadId, prompt: "q" });
    await expect(adapter.cancel({ derivedThreadId: "main", turnId: turn.turnId })).rejects.toBeInstanceOf(SideThreadConflictError);
    await expect(adapter.cancel({ derivedThreadId: b.derivedThreadId, turnId: turn.turnId })).rejects.toBeInstanceOf(SideThreadConflictError);
    await adapter.cancel({ derivedThreadId: a.derivedThreadId, turnId: turn.turnId });
    expect(client.calls.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: a.derivedThreadId, turnId: turn.turnId } });
  });

  test("out-of-order terminals remain isolated by thread and turn", async () => {
    const { client, adapter } = make();
    const a = await adapter.fork({ sideThreadId: "a", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const b = await adapter.fork({ sideThreadId: "b", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const ta = await adapter.start({ sideThreadId: "a", attemptId: "aa", derivedThreadId: a.derivedThreadId, prompt: "a" });
    const tb = await adapter.start({ sideThreadId: "b", attemptId: "bb", derivedThreadId: b.derivedThreadId, prompt: "b" });
    const got: string[] = []; adapter.subscribe((e) => got.push(e.attemptId));
    client.emit("turn/completed", { threadId: b.derivedThreadId, turn: { id: tb.turnId, status: "completed" } });
    client.emit("turn/completed", { threadId: a.derivedThreadId, turn: { id: ta.turnId, status: "interrupted" } });
    client.emit("turn/completed", { threadId: b.derivedThreadId, turn: { id: tb.turnId, status: "completed" } });
    expect(got).toEqual(["bb", "aa"]);
  });

  test("duplicate derived identity and delete during starting fail closed", async () => {
    const { client, adapter } = make();
    const first = await adapter.fork({ sideThreadId: "a", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    client.forkN--;
    await expect(adapter.fork({ sideThreadId: "b", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } }))
      .rejects.toThrow("reused a derived thread");
    client.holdTurnStart = true;
    void adapter.start({ sideThreadId: "a", attemptId: "pending", derivedThreadId: first.derivedThreadId, prompt: "q" }).catch(() => {});
    await Promise.resolve();
    await expect(adapter.delete({ derivedThreadId: first.derivedThreadId })).rejects.toThrow("active owned turn");
    adapter.close();
  });

  test("terminal before identity echo is buffered and unowned events are reported", async () => {
    const { client, adapter } = make();
    const fork = await adapter.fork({ sideThreadId: "a", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const dropped: string[] = []; const terminal: any[] = [];
    adapter.subscribeDropped((reason) => dropped.push(reason)); adapter.subscribe((event) => terminal.push(event));
    const start = adapter.start({ sideThreadId: "a", attemptId: "attempt", derivedThreadId: fork.derivedThreadId, prompt: "q" });
    client.emit("turn/completed", { threadId: fork.derivedThreadId, turn: { id: "turn-1", status: "completed" } });
    const started = await start;
    await Bun.sleep(5);
    expect(started.turnId).toBe("turn-1");
    expect(terminal).toHaveLength(1);
    client.emit("turn/completed", { threadId: "source", turn: { id: "other", status: "completed" } });
    expect(dropped).toContain("unowned-terminal");
  });

  test("identity timeout is ambiguous and close settles a pending start", async () => {
    const { client, adapter } = make({ identityTimeoutMs: 5 });
    const fork = await adapter.fork({ sideThreadId: "a", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    client.holdTurnStart = true;
    await expect(adapter.start({ sideThreadId: "a", attemptId: "amb", derivedThreadId: fork.derivedThreadId, prompt: "q" }))
      .rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.delete({ derivedThreadId: fork.derivedThreadId })).rejects.toThrow("active owned turn");
    const pending = adapter.start({ sideThreadId: "a", attemptId: "closing", derivedThreadId: fork.derivedThreadId, prompt: "q" });
    adapter.close();
    await expect(pending).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
  });

  test("snapshots thread/list before fork and uniquely reconciles a lost response without another RPC", async () => {
    const { client, adapter } = make(); client.loseForkResponse = true;
    const fork = await adapter.fork({ sideThreadId: "lost", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    expect(fork.derivedThreadId).toBe("fork-1");
    expect(client.calls.map((x) => x.method).slice(0, 3)).toEqual(["thread/list", "thread/fork", "thread/list"]);
    expect(client.calls.filter((x) => x.method === "thread/fork")).toHaveLength(1);
    const replay = await adapter.fork({ sideThreadId: "lost", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    expect(replay).toEqual(fork);
    expect(client.calls.filter((x) => x.method === "thread/fork")).toHaveLength(1);
  });

  test("multiple post-snapshot fork candidates stay ambiguous and retries never fork again", async () => {
    const { client, adapter } = make(); client.loseForkResponse = true; client.forkResponseCreates = 2;
    const input = { sideThreadId: "multi", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } as const };
    await expect(adapter.fork(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.fork(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((x) => x.method === "thread/fork")).toHaveLength(1);
  });

  test("an ambiguous start reconciles the unique persisted client identity without another turn/start", async () => {
    const { client, adapter } = make({ identityTimeoutMs: 5 });
    const fork = await adapter.fork({ sideThreadId: "start-lost", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    client.holdTurnStart = true;
    const input = { sideThreadId: "start-lost", attemptId: "attempt-lost", derivedThreadId: fork.derivedThreadId, prompt: "q" };
    await expect(adapter.start(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    client.threads.get(fork.derivedThreadId).turns.push({ id: "turn-recovered", items: [{ type: "userMessage", clientId: "anet-side:start-lost:attempt-lost" }] });
    await expect(adapter.start(input)).resolves.toEqual({ turnId: "turn-recovered" });
    expect(client.calls.filter((x) => x.method === "turn/start")).toHaveLength(1);
  });

  test("accepted and ambiguous start/interrupt/archive/delete operations never repeat their RPC", async () => {
    const { client, adapter } = make({ identityTimeoutMs: 5 });
    const fork = await adapter.fork({ sideThreadId: "ops", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    const accepted = { sideThreadId: "ops", attemptId: "accepted", derivedThreadId: fork.derivedThreadId, prompt: "q" };
    const first = await adapter.start(accepted); await adapter.start(accepted);
    expect(client.calls.filter((x) => x.method === "turn/start")).toHaveLength(1);
    client.loseMethods.add("turn/interrupt");
    await expect(adapter.cancel({ derivedThreadId: fork.derivedThreadId, turnId: first.turnId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.cancel({ derivedThreadId: fork.derivedThreadId, turnId: first.turnId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((x) => x.method === "turn/interrupt")).toHaveLength(1);
    client.loseMethods.add("thread/archive");
    await expect(adapter.archive({ derivedThreadId: fork.derivedThreadId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.archive({ derivedThreadId: fork.derivedThreadId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((x) => x.method === "thread/archive")).toHaveLength(1);
    client.emit("turn/completed", { threadId: fork.derivedThreadId, turn: { id: first.turnId, status: "completed" } });
    client.loseMethods.add("thread/delete");
    await expect(adapter.delete({ derivedThreadId: fork.derivedThreadId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.delete({ derivedThreadId: fork.derivedThreadId })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((x) => x.method === "thread/delete")).toHaveLength(1);
  });

  test("recovers a lease-first snapshot tear without adopting a pre-snapshot fork", async () => {
    const root = mkdtempSync(join(tmpdir(), "side-adapter-torn-")); roots.push(root);
    const client = new Client();
    client.threads.set("old-fork", { id: "old-fork", forkedFromId: "main", turns: [] });
    client.loseForkResponse = true; client.forkResponseCreates = 0;
    const sideThreadId = "torn-side"; const idempotencyKey = `fork-${sideThreadId}`;
    const operationId = stableOperationId(sideThreadId, "fork", idempotencyKey);
    const operation: SideThreadOperation = {
      version: 1, nodeId: "node-1", sideThreadId, opId: operationId, idempotencyKey, method: "fork",
      targetHash: operationHash("main"), fingerprint: operationHash(JSON.stringify(["main", "through", "done"])),
      state: "prepared", updatedAt: 1,
    };
    new PrivateFileOperationLedger(join(root, "operations")).put(operation);
    new PrivateFileForkLeaseStore(join(root, "fork-leases")).acquire({
      version: 1, nodeId: "node-1", sourceThreadHash: operationHash("main"), sideThreadId,
      operationId, fingerprint: operation.fingerprint,
      snapshotThreadIdHashes: [operationHash("main"), operationHash("old-fork")], state: "snapshot", updatedAt: 2,
    });
    await expect(makeAt(client, root).fork({ sideThreadId, sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } }))
      .rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((call) => call.method === "thread/fork")).toHaveLength(1);
    expect(new PrivateFileOperationLedger(join(root, "operations")).get("node-1", sideThreadId, operationId)?.result?.snapshotThreadIdHashes)
      .toContain(operationHash("old-fork"));
  });

  test("restart reconciliation restores exact terminal and cancel ownership", async () => {
    const root = mkdtempSync(join(tmpdir(), "side-adapter-restart-")); roots.push(root);
    const client = new Client(); const first = makeAt(client, root);
    const forkInput = { sideThreadId: "restart-side", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } as const };
    const fork = await first.fork(forkInput);
    const startInput = { sideThreadId: "restart-side", attemptId: "attempt-1", derivedThreadId: fork.derivedThreadId, prompt: "q" };
    const started = await first.start(startInput); first.close();
    const second = makeAt(client, root); await second.fork(forkInput); await second.start(startInput);
    await second.cancel({ sideThreadId: "restart-side", derivedThreadId: fork.derivedThreadId, turnId: started.turnId });
    expect(client.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(1);
    const terminal: any[] = []; second.subscribe((event) => terminal.push(event));
    client.emit("turn/completed", { threadId: fork.derivedThreadId, turn: { id: started.turnId, status: "completed" } });
    expect(terminal).toEqual([expect.objectContaining({ sideThreadId: "restart-side", attemptId: "attempt-1", turnId: started.turnId })]);
  });

  test("discard compensation is durable and response-loss replay never deletes twice", async () => {
    const { client, adapter, root } = make();
    const fork = await adapter.fork({ sideThreadId: "discard-side", sourceThreadId: "main", boundary: { kind: "through", turnId: "done" } });
    client.loseMethods.add("thread/delete");
    const operation = { nodeId: "node-1", idempotencyKey: "discard-request-1",
      operationId: stableOperationId("discard-side", "delete", "discard-request-1") };
    const input = { sideThreadId: "discard-side", derivedThreadId: fork.derivedThreadId, operation };
    await expect(adapter.discardFork(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(adapter.discardFork(input)).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(client.calls.filter((call) => call.method === "thread/delete")).toHaveLength(1);
    expect(new PrivateFileOperationLedger(join(root, "operations")).get("node-1", "discard-side", operation.operationId)?.state).toBe("ambiguous");
  });
});
