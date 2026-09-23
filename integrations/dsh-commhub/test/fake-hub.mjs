// Minimal in-process CommHub stand-in: MCP tools/call over POST /mcp and an
// SSE doorbell at /events/<alias>. Enough to exercise the node loop.
import { createServer } from "node:http";

export async function startFakeHub({ token = "ntok_test", failReplyTimes = 0 } = {}) {
  const inbox = [];            // {id, type, task_id, from_session, content, acked}
  const replies = [];          // {in_reply_to, text, status}
  const statuses = [];         // report_status args
  const calls = [];            // tool names in order
  const sent = [];             // send_task/send_message args
  const sseClients = new Set();
  let replyFailuresLeft = failReplyTimes;
  let seq = 0;

  const push = (ev) => { for (const res of sseClients) res.write(`data: ${JSON.stringify(ev)}\n\n`); };

  const tools = {
    report_status: (a) => { statuses.push(a); return { ok: true, inbox_count: inbox.filter((m) => !m.acked).length }; },
    get_inbox: (a) => ({ ok: true, messages: inbox.filter((m) => !m.acked).slice(0, a.limit ?? 10).map(({ acked, ...m }) => m) }),
    ack_inbox: (a) => { const m = inbox.find((x) => x.id === a.message_id); if (m) m.acked = true; return { ok: true }; },
    send_reply: (a) => {
      if (replyFailuresLeft > 0) { replyFailuresLeft--; throw Object.assign(new Error("hub temporarily unavailable"), { http: 503 }); }
      if (replies.some((r) => r.in_reply_to === a.in_reply_to)) return { ok: false, error: "reply_task_terminal" };
      replies.push({ in_reply_to: a.in_reply_to, text: a.text, status: a.status }); return { ok: true, message_id: `r${++seq}` };
    },
    send_task: (a) => { sent.push({ tool: "send_task", ...a }); return { ok: true, message_id: `t${++seq}` }; },
    send_message: (a) => {
      sent.push({ tool: "send_message", ...a });
      if (a.alias === "offline-peer") return { ok: false, error: "alias_offline", message: `alias is offline; message queued in inbox: ${a.alias}`, queued: true, message_id: `m${++seq}` };
      if (a.alias === "no-such-peer") return { ok: false, error: "alias_not_found" };
      return { ok: true, message_id: `m${++seq}` };
    },
    get_all_status: () => ({ ok: true, sessions: [{ alias: "peer-a", status: "idle", agent: "agent-node:claude" }] }),
  };

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method === "GET" && req.url.startsWith("/events/")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      let body = ""; for await (const c of req) body += c;
      const msg = JSON.parse(body);
      if (msg.method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "fake-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } })); return;
      }
      const name = msg.params?.name; calls.push(name);
      try {
        const out = tools[name](msg.params.arguments ?? {});
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } })}\n\n`);
      } catch (e) {
        res.writeHead(e.http ?? 500).end(String(e.message));
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, token, inbox, replies, statuses, calls, sent,
    addTask(content, from = "peer-a") {
      const id = `task-${++seq}`;
      inbox.push({ id, type: "task", task_id: id, from_session: from, content, acked: false });
      push({ type: "new_task", task_id: id });
      return id;
    },
    addMessage(content, from = "peer-a") {
      const id = `msg-${++seq}`;
      inbox.push({ id, type: "message", from_session: from, content, acked: false });
      push({ type: "new_message", id });
      return id;
    },
    /** Drop every live SSE connection (simulates a hub restart / network blip). */
    dropSse() { for (const r of sseClients) r.destroy(); sseClients.clear(); },
    sseCount: () => sseClients.size,
    close: () => new Promise((r) => { for (const c of sseClients) c.destroy(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export const waitFor = async (pred, ms = 3000, step = 20) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
};
