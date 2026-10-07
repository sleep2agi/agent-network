import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { CodexAppServerBridge } from "../codex-app-server-bridge";

class FakeClient extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  constructor(private readonly answer: (method: string, params: any) => unknown) { super(); }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    return this.answer(method, params) as T;
  }
  notify(): void {}
}

describe("#703 exact persisted turn inspection", () => {
  test("paginates by exact turn id and extracts only final_answer", async () => {
    const client = new FakeClient((_method, params) => params.cursor
      ? {
          data: [{
            id: "turn-target", status: "completed",
            items: [
              { type: "agentMessage", phase: "commentary", text: "working" },
              { type: "agentMessage", phase: "final_answer", text: "durable final" },
            ],
          }],
          nextCursor: null,
        }
      : { data: [{ id: "turn-newer", status: "completed", items: [] }], nextCursor: "page-two" });
    const bridge = new CodexAppServerBridge({ client: client as never, threadId: "thread-fixture" });
    expect(await bridge.inspectPersistedTurn("thread-fixture", "turn-target")).toEqual({
      state: "completed", text: "durable final",
    });
    expect(client.calls.map((call) => call.params.cursor)).toEqual([undefined, "page-two"]);
  });

  test("classifies running, interrupted and exhaustive missing without starting a turn", async () => {
    for (const [turn, expected] of [
      [{ id: "target", status: "inProgress" }, { state: "running" }],
      [{ id: "target", status: "interrupted", completedAt: 1_791_374_454, error: { message: "watchdog stopped process" } }, { state: "interrupted", error: "watchdog stopped process", completedAt: 1_791_374_454 }],
    ] as const) {
      const client = new FakeClient(() => ({ data: [turn], nextCursor: null }));
      const bridge = new CodexAppServerBridge({ client: client as never, threadId: "thread-fixture" });
      expect(await bridge.inspectPersistedTurn("thread-fixture", "target")).toEqual(expected);
      expect(client.calls.every((call) => call.method === "thread/turns/list")).toBe(true);
    }
    const client = new FakeClient(() => ({ data: [], nextCursor: null }));
    const bridge = new CodexAppServerBridge({ client: client as never, threadId: "thread-fixture" });
    expect(await bridge.inspectPersistedTurn("thread-fixture", "absent")).toEqual({ state: "missing" });
  });
});
