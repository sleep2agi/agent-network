// #507 — two live copies of one node (directory copied verbatim: same node token,
// same alias) used to hold two SSE subscriptions on `${net}:${alias}`. Every new
// task was pushed to BOTH (each copy ran it), and either copy's shutdown
// report_status(offline) took the node offline under the other → alias_offline.
//
// Pinned here, through the real HTTP entrances (GET /events/:alias with the node
// token, POST /mcp report_status, POST /api/task, GET /api/stats/sse):
//   1. newest connection wins: the older node stream gets node_connection_superseded
//      (reason superseded_by_new_connection) and is closed; /api/stats/sse shows 1.
//   2. a new task reaches exactly ONE node subscriber; a dashboard monitor on the
//      same channel is untouched and still sees it.
//   3. node_identity_conflict reaches the network observer stream and
//      /api/stats/sse.identity_conflicts, with both remotes and no token.
//   4. offline only when the last node connection leaves; tasks in between are
//      delivered, not alias_offline.
//   5. same instance id = a reconnect (replaced_by_reconnect, no conflict);
//      different ids = instance_match "different"; another node's token watching
//      this alias never supersedes it; a plain single-node stop is offline at once.
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/node-identity-conflict-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "anet-node-conflict-"));
const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-identity-conflict requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
let server: any;
let base = "";
let ownerToken = "", ownerId = "", NET = "";
const nodes: Record<string, { alias: string; nodeId: string; token: string }> = {};

type Sub = { events: any[]; done: boolean; abort: () => void; ready: Promise<void> };

function subscribe(path: string, token: string, headers: Record<string, string> = {}): Sub {
  const ctrl = new AbortController();
  const sub: Sub = { events: [], done: false, abort: () => ctrl.abort(), ready: Promise.resolve() };
  let markReady!: () => void;
  sub.ready = new Promise<void>((r) => { markReady = r; });
  (async () => {
    try {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", ...headers }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`subscribe ${path} → ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          sub.events.push(ev);
          if (ev.type === "connected") markReady();
        }
      }
    } catch { /* aborted */ }
    sub.done = true;
    markReady();
  })();
  return sub;
}

async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = payload.result.content[0].text;
  if (!text.startsWith("{")) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const reportStatus = (n: { alias: string; nodeId: string; token: string }, status: string) =>
  tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status, node_id: n.nodeId, network_id: NET });
const storedStatus = (alias: string) =>
  db.get<{ status: string }>("SELECT status FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, NET)?.status;
let seq = 0;
const sendTask = (alias: string) => api(ownerToken, "POST", "/api/task", { alias, task: `conflict task ${stamp} #${++seq}`, network_id: NET });
const nodeStream = (n: { alias: string; token: string }, headers: Record<string, string> = {}) =>
  subscribe(`/events/${encodeURIComponent(n.alias)}`, n.token, headers);
const newTasks = (s: Sub) => s.events.filter((e) => e.type === "new_task");
const sseCount = async (alias: string) => (await api(nodes.a.token, "GET", "/api/stats/sse")).body.sessions[`${NET}:${alias}`] ?? 0;

beforeAll(async () => {
  process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
  process.env.HOST = "127.0.0.1";
  const owner = register(`nic_owner_${stamp}`, "NodeConflictOwner123!", undefined, "seed");
  ownerToken = owner.token!; ownerId = owner.user!.user_id; NET = owner.network_id!;
  for (const key of ["a", "b", "c", "d", "e"]) {
    const alias = `nic-${key}-${stamp}`;
    const nodeId = `n_nic_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(ownerId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  for (const n of Object.values(nodes)) expect((await reportStatus(n, "idle")).ok).toBe(true);
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("#507 two copies of one node (same token, same alias)", () => {
  const subs: Record<string, Sub> = {};

  test("newest connection wins: the older node stream is told why and closed", async () => {
    const n = nodes.a;
    subs.observer = subscribe(`/events/network/${NET}`, ownerToken);
    subs.monitor = subscribe(`/events/${encodeURIComponent(n.alias)}?network_id=${NET}`, ownerToken);
    await subs.observer.ready; await subs.monitor.ready;
    subs.copyA = nodeStream(n, { "User-Agent": "copy-A" });
    await subs.copyA.ready;
    expect(await sseCount(n.alias)).toBe(2); // copy A + dashboard monitor

    subs.copyB = nodeStream(n, { "User-Agent": "copy-B" });
    await subs.copyB.ready;
    await until(() => subs.copyA.done, "copy A's stream to be closed");
    const notice = subs.copyA.events.find((e) => e.type === "node_connection_superseded");
    expect(notice).toBeTruthy();
    expect(notice.reason).toBe("superseded_by_new_connection");
    expect(notice.instance_match).toBe("unknown");
    expect(subs.copyB.done).toBe(false);
    expect(subs.monitor.done).toBe(false); // a monitor is never superseded
    expect(await sseCount(n.alias)).toBe(2); // copy B + monitor
  });

  test("a new task reaches exactly one node subscriber (the monitor still sees it)", async () => {
    const r = await sendTask(nodes.a.alias);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    await until(() => newTasks(subs.copyB).length >= 1 && newTasks(subs.monitor).length >= 1, "new_task on copy B + monitor");
    await settle();
    expect(newTasks(subs.copyB).length).toBe(1);
    expect(newTasks(subs.copyA).length).toBe(0);
    expect(newTasks(subs.monitor).length).toBe(1);
  });

  test("node_identity_conflict reaches the observer stream and /api/stats/sse, with remotes and no token", async () => {
    await until(() => subs.observer.events.some((e) => e.type === "node_identity_conflict"), "observer conflict event");
    const ev = subs.observer.events.find((e) => e.type === "node_identity_conflict");
    expect(ev.alias).toBe(nodes.a.alias);
    expect(ev.node_id).toBe(nodes.a.nodeId);
    expect(ev.policy).toBe("newest_connection_wins");
    expect(ev.superseded.user_agent).toBe("copy-A");
    expect(ev.current.user_agent).toBe("copy-B");
    expect(ev.superseded.remote).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(ev.current.remote).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(ev.superseded.remote).not.toBe(ev.current.remote);
    const stats = await api(nodes.a.token, "GET", "/api/stats/sse");
    const mine = stats.body.identity_conflicts.filter((c: any) => c.alias === nodes.a.alias);
    expect(mine.length).toBe(1);
    expect(mine[0].network_id).toBe(NET);
    const raw = JSON.stringify(stats.body) + JSON.stringify(ev);
    expect(raw).not.toContain("ntok_");
    expect(raw).not.toContain(nodes.a.token);
    const audit = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'node_identity_conflict' AND target_id = ?1", nodes.a.nodeId);
    expect(audit?.n).toBe(1);
  });

  test("offline only when the last node connection leaves; tasks in between are delivered", async () => {
    const n = nodes.a;
    // Copy A (the superseded one) shuts down and says so.
    const fromA = await reportStatus(n, "offline");
    expect(fromA.ok).toBe(true);
    expect(fromA.offline_deferred).toBe(true);
    expect(storedStatus(n.alias)).not.toBe("offline");
    const r = await sendTask(n.alias);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.error).toBeUndefined();
    await until(() => newTasks(subs.copyB).length >= 2, "second new_task on copy B");

    // Copy B stops too: it reports offline while its stream is still open, then exits.
    const fromB = await reportStatus(n, "offline");
    expect(fromB.offline_deferred).toBe(true);
    expect(storedStatus(n.alias)).not.toBe("offline");
    subs.copyB.abort();
    await until(() => storedStatus(n.alias) === "offline", "deferred offline applied once the last node stream closed");
    expect((await sendTask(n.alias)).body.error).toBe("alias_offline");
    subs.monitor.abort(); subs.observer.abort();
  });
});

describe("#507 what is and is not a conflict", () => {
  test("same instance id = a reconnect of the same process: replaced, no conflict recorded", async () => {
    const n = nodes.b;
    const first = nodeStream(n, { "X-Anet-Instance-Id": "inst-b-1" });
    await first.ready;
    const second = nodeStream(n, { "X-Anet-Instance-Id": "inst-b-1" });
    await second.ready;
    await until(() => first.done, "old stream replaced");
    expect(first.events.find((e) => e.type === "node_connection_superseded")?.reason).toBe("replaced_by_reconnect");
    const stats = await api(n.token, "GET", "/api/stats/sse");
    expect(stats.body.identity_conflicts.filter((c: any) => c.alias === n.alias)).toEqual([]);
    // No conflict → a stop is exactly as before: offline at once.
    const r = await reportStatus(n, "offline");
    expect(r.offline_deferred).toBeUndefined();
    expect(storedStatus(n.alias)).toBe("offline");
    second.abort();
  });

  test("different instance ids are reported as instance_match=different", async () => {
    const n = nodes.c;
    const first = nodeStream(n, { "X-Anet-Instance-Id": "inst-c-host1" });
    await first.ready;
    const second = subscribe(`/events/${encodeURIComponent(n.alias)}?instance_id=inst-c-host2`, n.token);
    await second.ready;
    await until(() => first.done, "old stream superseded");
    const stats = await api(n.token, "GET", "/api/stats/sse");
    const mine = stats.body.identity_conflicts.filter((c: any) => c.alias === n.alias);
    expect(mine.length).toBe(1);
    expect(mine[0].instance_match).toBe("different");
    expect(mine[0].superseded.instance_id).toBe("inst-c-host1");
    expect(mine[0].current.instance_id).toBe("inst-c-host2");
    second.abort();
  });

  test("another node's token watching this alias never supersedes the node", async () => {
    const n = nodes.d;
    const own = nodeStream(n);
    await own.ready;
    const watcher = subscribe(`/events/${encodeURIComponent(n.alias)}`, nodes.e.token);
    await watcher.ready;
    await settle();
    expect(own.done).toBe(false);
    expect(own.events.some((e) => e.type === "node_connection_superseded")).toBe(false);
    watcher.abort();
    // And a plain single-node stop (no conflict) is offline immediately, as before.
    const r = await reportStatus(n, "offline");
    expect(r.offline_deferred).toBeUndefined();
    expect(storedStatus(n.alias)).toBe("offline");
    own.abort();
  });
});
