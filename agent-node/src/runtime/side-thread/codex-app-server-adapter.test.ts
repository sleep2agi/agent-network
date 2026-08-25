import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexAppServerSideThreadAdapter } from "./codex-app-server-adapter";
import { SideThreadConflictError } from "./domain";

class Client extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  forkN = 0; turnN = 0;
  loseTurnStartResponse = false;
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/fork") return { thread: { id: `fork-${++this.forkN}` } } as T;
    if (method === "turn/start") {
      const turnId = `turn-${++this.turnN}`;
      if (this.loseTurnStartResponse) {
        return await new Promise<T>((_resolve, reject) => queueMicrotask(() => {
          this.emit("item/started", {
            threadId: params.threadId, turnId,
            item: { type: "userMessage", clientId: params.clientUserMessageId },
          });
          queueMicrotask(() => reject(new Error("response lost")));
        }));
      }
      queueMicrotask(() => this.emit("item/started", {
          threadId: params.threadId, turnId,
          item: { type: "userMessage", clientId: params.clientUserMessageId },
        }));
      return { turn: { id: `response-${turnId}` } } as T;
    }
    return {} as T;
  }
}

const make = (overrides: Partial<ConstructorParameters<typeof CodexAppServerSideThreadAdapter>[0]> = {}) => {
  const client = new Client();
  const adapter = new CodexAppServerSideThreadAdapter({
    client, runtimeVersion: "0.148.0", topology: "owned-stdio",
    evidenceRevision: "test1190-wire-v2", experimentalApi: true, ...overrides,
  });
  return { client, adapter };
};

describe("CodexAppServerSideThreadAdapter", () => {
  test("capability matrix fails closed", () => {
    expect(make().adapter.capability().supported).toBe(true);
    expect(make({ runtimeVersion: "0.149.0" }).adapter.capability()).toMatchObject({ supported: false, reason: "version" });
    expect(make({ topology: "shared-websocket" }).adapter.capability()).toMatchObject({ supported: false, reason: "topology" });
    expect(make({ evidenceRevision: "blocked-v1" }).adapter.capability()).toMatchObject({ supported: false, reason: "exact-boundary" });
    expect(make({ experimentalApi: false }).adapter.capability()).toMatchObject({
      supported: true, exactBoundary: { through: true, before: false },
    });
  });

  test("fork sends one exact boundary and no permission override", async () => {
    const { client, adapter } = make();
    await adapter.fork({ sideThreadId: "s1", sourceThreadId: "main", boundary: { kind: "through", turnId: "done-1" } });
    await adapter.fork({ sideThreadId: "s2", sourceThreadId: "main", boundary: { kind: "before", turnId: "active-2" } });
    const [a, b] = client.calls.map((x) => x.params);
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
});
