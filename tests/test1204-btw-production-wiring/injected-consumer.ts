import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { startCliSideThreadConsumer } from "../../agent-node/src/runtime/side-thread/production";

class FakeCodexRpc extends EventEmitter {
  private turns = 0;
  private readonly threads = new Map<string, any>([["source-thread", { id: "source-thread", turns: [{ id: "source-turn" }] }]]);
  async request<T>(method: string, params: any): Promise<T> {
    appendFileSync("/tmp/test1204-fake-codex.log", `${JSON.stringify({ method, params })}\n`);
    if (method === "thread/list") return { data: [...this.threads.values()], nextCursor: null } as T;
    if (method === "thread/read") return { thread: this.threads.get(params.threadId) } as T;
    if (method === "thread/fork") {
      const thread = { id: "derived-production", forkedFromId: params.threadId, turns: [{ id: params.lastTurnId }] };
      this.threads.set(thread.id, thread); return { thread } as T;
    }
    if (method === "turn/start") {
      const turnId = params.threadId === "source-thread" ? "bring-back-production" : `side-turn-${++this.turns}`;
      if (params.clientUserMessageId?.startsWith("anet-side:")) queueMicrotask(() => {
        this.emit("item/started", { threadId: params.threadId, turnId, item: { type: "userMessage", clientId: params.clientUserMessageId } });
        setTimeout(() => {
          this.emit("item/started", { threadId: params.threadId, turnId, item: { type: "agentMessage", text: "PRODUCTION_SIDE_ANSWER" } });
          this.emit("turn/completed", { threadId: params.threadId, turn: { id: turnId, status: "completed" } });
        }, 20);
      });
      return { turn: { id: turnId } } as T;
    }
    return {} as T;
  }
}

const runtime = startCliSideThreadConsumer({
  enabled: true,
  client: new FakeCodexRpc() as any,
  hubUrl: process.env.TEST_HUB!,
  nodeId: process.env.TEST_NODE_ID!,
  token: process.env.TEST_NODE_TOKEN!,
  codexHome: process.env.CODEX_HOME!,
  runtimeVersion: "0.148.0",
  topology: "owned-stdio",
  experimentalApi: false,
  pollMs: 5,
  log: (message) => console.log(message),
  warn: (message) => console.error(message),
});
process.on("SIGTERM", () => { runtime.close(); process.exit(0); });
await new Promise(() => {});
