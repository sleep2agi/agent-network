import { appendFileSync } from "node:fs";

const endpoint = new URL(process.argv[2]);
const port = Number(endpoint.port);
const turnShape = (id, items = []) => ({ id, items, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 });
const threadShape = (id, forkedFromId = null, turns = []) => ({
  id, sessionId: id, forkedFromId, preview: "", ephemeral: false,
  modelProvider: "openai", createdAt: 1, updatedAt: 2, status: { type: "idle" },
  path: null, cwd: "/repo", cliVersion: "0.148.0", source: "appServer",
  threadSource: "user", agentNickname: null, agentRole: null, gitInfo: null, name: null, turns,
});
const threads = new Map([
  ["source-thread", threadShape("source-thread", null, [turnShape("source-turn")])],
]);
let derived = 0;
let turn = 0;
const log = (method, params) => appendFileSync("/tmp/test1204-fake-codex.log", `${JSON.stringify({ method, params })}\n`);

const server = Bun.serve({
  hostname: "127.0.0.1", port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("upgrade required", { status: 426 });
  },
  websocket: {
    open() {},
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (typeof msg.method !== "string" || msg.id == null) return;
      const p = msg.params ?? {}; log(msg.method, p);
      const reply = (result) => {
        const wire = { jsonrpc: "2.0", id: msg.id, result };
        appendFileSync("/tmp/test1204-fake-codex.log", `${JSON.stringify({ response: wire })}\n`);
        ws.send(JSON.stringify(wire));
      };
      if (msg.method === "initialize") return reply({ userAgent: "codex-cli/0.148.0" });
      if (msg.method === "thread/list") return reply({ data: [...threads.values()], nextCursor: null });
      if (msg.method === "thread/read") return reply({ thread: threads.get(p.threadId) ?? null });
      if (msg.method === "thread/start") {
        const id = p.threadId ?? `source-created-${++derived}`;
        const thread = threadShape(id); threads.set(id, thread); return reply({ thread });
      }
      if (msg.method === "thread/fork") {
        const id = `derived-${++derived}`;
        const thread = threadShape(id, p.threadId, [turnShape(p.lastTurnId)]);
        threads.set(id, thread);
        return setTimeout(() => reply({ thread }), 10);
      }
      if (msg.method === "turn/start") {
        const id = `turn-${++turn}`; const thread = threads.get(p.threadId) ?? threadShape(p.threadId);
        const completedTurn = turnShape(id, [{ type: "agentMessage", id: `item-${turn}`, text: "PRODUCTION_SIDE_ANSWER", phase: null }]);
        thread.turns.push(completedTurn); threads.set(p.threadId, thread);
        reply({ turn: completedTurn });
        if (p.clientUserMessageId) ws.send(JSON.stringify({ method: "item/started", params: {
          threadId: p.threadId, turnId: id, item: { type: "userMessage", clientId: p.clientUserMessageId },
        } }));
        setTimeout(() => ws.send(JSON.stringify({ method: "turn/completed", params: {
          threadId: p.threadId, turn: completedTurn,
        } })), 10);
        return;
      }
      if (msg.method === "turn/interrupt") return reply({});
      if (msg.method === "thread/archive" || msg.method === "thread/unarchive" || msg.method === "thread/delete") return reply({});
      reply({});
    },
    close() {},
  },
});

process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
