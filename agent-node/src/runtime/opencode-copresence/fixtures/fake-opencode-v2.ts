#!/usr/bin/env bun
// Board #543 — a protocol-shaped fake of `opencode serve` (OpenCode 2.0.22),
// for unit tests of the V2 co-presence core. Shapes copied from the Docker
// probe of the real binary: /api/info, POST /api/session, async
// POST /api/session/:id/prompt (+inbox), GET …/message (desc|asc, cursor),
// DELETE …/inbox/:id, Basic auth user "opencode".
//
// Test-only hooks (same auth): POST /test/steer {text} queues a "human"
// steer into the running turn; GET /test/state dumps everything.
// Prompt text drives the fake model: "Reply with exactly X" → X;
// "STUB_FAIL" → provider error; "DELAY_<ms>" → the turn takes that long.

// Bun runtime global, typed loosely so agent-node's tsc ratchet (no bun types)
// stays flat. `export {}` keeps this a module: as a global script the `const`
// would declare `Bun` for every file and hide their real TS2868 errors.
export {};
const Bun: any = (globalThis as any).Bun;

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("opencode v2.0.22");
  process.exit(0);
}
const port = Number(args[args.indexOf("--port") + 1]);
const hostname = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1";
const password = process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? "";
const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

type Entry = Record<string, any>;
const sessions = new Map<string, { entries: Entry[]; inbox: Entry[]; running: boolean; steer: string[] }>();
let counter = 0;
const id = (prefix: string) => `${prefix}_${Date.now().toString(16)}${(++counter).toString().padStart(6, "0")}Fk`;

async function run(sid: string) {
  const s = sessions.get(sid)!;
  if (s.running) return;
  s.running = true;
  while (s.inbox.length > 0) {
    const next = s.inbox.shift()!;
    s.entries.push({ id: next.id, type: "user", text: next.payload.text, time: { created: Date.now() } });
    const text: string = next.payload.text;
    const delay = Number(/DELAY_(\d+)/.exec(text)?.[1] ?? 30);
    await new Promise((r) => setTimeout(r, delay));
    if (s.steer.length > 0) {
      // A human steered into this unfinished turn: our step ends with
      // tool-calls, the human message lands, the final answer follows it.
      s.entries.push({ id: id("msg"), type: "assistant", content: [{ type: "tool", name: "read" }], finish: "tool-calls" });
      for (const human of s.steer.splice(0)) {
        s.entries.push({ id: id("msg"), type: "user", text: human });
      }
      s.entries.push({ id: id("msg"), type: "assistant", content: [{ type: "text", text: "MERGED_ANSWER" }], finish: "stop" });
      continue;
    }
    if (/STUB_FAIL/.test(text)) {
      s.entries.push({
        id: id("msg"), type: "assistant", content: [], finish: "error",
        error: { type: "provider.invalid-request", message: "stub provider refused: STUB_FAIL requested", status: 400 },
      });
      s.entries.push({ id: id("msg"), type: "idle", outcome: "failed" });
      continue;
    }
    if (/STUB_TOOL_CAPACITY/.test(text)) {
      s.entries.push({
        id: id("msg"), type: "assistant",
        content: [{ type: "tool", name: "bash" }],
        finish: "error",
        error: { type: "APIError", message: "Selected model is at capacity. Please try a different model.", status: 503 },
      });
      s.entries.push({ id: id("msg"), type: "idle", outcome: "failed" });
      continue;
    }
    const reply = /Reply with exactly (\S+)/.exec(text)?.[1] ?? "STUB_OK";
    s.entries.push({ id: id("msg"), type: "assistant", content: [{ type: "reasoning", text: "…" }, { type: "text", text: reply }], finish: "stop" });
    // A queued prompt is delivered at the end of the execution WITHOUT an
    // idle marker in between (measured on 2.0.22).
    if (s.inbox.length === 0) s.entries.push({ id: id("msg"), type: "idle", outcome: "succeeded" });
  }
  s.running = false;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

Bun.serve({
  hostname,
  port,
  async fetch(request: Request) {
    if (request.headers.get("authorization") !== expectedAuth) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/info") return json({ version: "2.0.22", pid: process.pid, urls: [`http://${hostname}:${port}`] });
    if (path === "/api/session" && request.method === "POST") {
      const sid = `ses_${Date.now().toString(16)}Fake${++counter}`;
      sessions.set(sid, { entries: [], inbox: [], running: false, steer: [] });
      return json({ data: { id: sid } });
    }
    if (path === "/test/state") return json(Object.fromEntries(sessions));
    let m = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/(prompt|message|inbox)(?:\/(msg_[A-Za-z0-9]+))?$/.exec(path)
      ?? /^\/test\/(ses_[A-Za-z0-9]+)\/(steer)$/.exec(path);
    if (!m) return json({ error: "not found" }, 404);
    const s = sessions.get(m[1]);
    if (!s) return json({ error: "session not found" }, 404);
    const kind = m[2];
    if (kind === "steer") {
      const body: any = await request.json();
      s.steer.push(body.text);
      return json({ ok: true });
    }
    if (kind === "prompt" && request.method === "POST") {
      const body: any = await request.json();
      if (body.delivery !== "queue") return json({ error: "this fake only models delivery=queue for network prompts" }, 400);
      const entry = { id: id("msg"), type: "user", payload: { text: body.text }, delivery: "queue" };
      s.inbox.push(entry);
      queueMicrotask(() => { void run(m![1]); });
      return json({ data: entry });
    }
    if (kind === "inbox" && request.method === "GET") return json({ data: s.inbox });
    if (kind === "inbox" && request.method === "DELETE") {
      const index = s.inbox.findIndex((entry) => entry.id === m![3]);
      if (index < 0) return json({ error: "not found" }, 404);
      s.inbox.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (kind === "message" && request.method === "GET") {
      if (url.searchParams.has("cursor") && url.searchParams.has("order")) {
        return json({ name: "InvalidRequestError", message: "cursor cannot be combined with order" }, 400);
      }
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (limit > 200) return json({ message: "Expected a value less than or equal to 200" }, 400);
      const cursor = url.searchParams.get("cursor");
      let start = 0;
      const desc = [...s.entries].reverse();
      if (cursor) start = Number(JSON.parse(Buffer.from(cursor, "base64url").toString()).offset);
      const data = desc.slice(start, start + limit);
      const nextOffset = start + data.length;
      return json({
        data,
        cursor: { next: nextOffset < desc.length ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString("base64url") : null },
      });
    }
    return json({ error: "method not allowed" }, 405);
  },
});
