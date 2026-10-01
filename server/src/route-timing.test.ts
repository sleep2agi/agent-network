import { expect, test } from "bun:test";
import {
  __resetRouteTimingForTest, callerTokenKind, labelRoute, mcpRouteLabel, recordRouteTiming, routeKey, routeStats,
  setRouteCallerMasterToken, setRouteCallerTokenReader, userAgentFamily, ROUTE_MAX_CALLERS_PER_ROUTE,
  ROUTE_BUCKET_MS, ROUTE_BUCKET_RETENTION, ROUTE_MAX_KEYS_PER_BUCKET, ROUTE_OVERFLOW_KEY,
} from "./route-timing";

const u = (s: string) => new URL(`http://hub${s}`);
const req = (path: string, method = "GET") => new Request(`http://hub${path}`, { method });
const res = (status = 200, len?: number) => new Response("x", { status, headers: len === undefined ? {} : { "Content-Length": String(len) } });
const at = (ms: number) => performance.now() - ms;

test("routeKey collapses ids, aliases and file names, keeps payload-shaping params", () => {
  expect(routeKey("GET", u("/api/requirements?network_id=net_1&limit=500"))).toBe("GET /api/requirements");
  expect(routeKey("GET", u("/api/requirements?view=summary&network_id=n"))).toBe("GET /api/requirements?view=summary");
  expect(routeKey("PATCH", u("/api/requirements/req_3f9a/checklist/c1"))).toBe("PATCH /api/requirements/:id/checklist/:id");
  expect(routeKey("GET", u("/api/requirements/stats"))).toBe("GET /api/requirements/stats");
  expect(routeKey("GET", u("/api/status?light=1"))).toBe("GET /api/status?light=1");
  expect(routeKey("GET", u(`/api/nodes/${encodeURIComponent("通信牛")}/config`))).toBe("GET /api/nodes/:id/config");
  expect(routeKey("GET", u("/api/messages?scope=user&limit=50"))).toBe("GET /api/messages?scope=user");
});

test("routeStats groups the window, sorts by total time, and counts every request (no sample cap)", () => {
  __resetRouteTimingForTest();
  const now = 1_000_000_000;
  recordRouteTiming(req("/api/requirements"), at(30), res(200, 1000), now);
  recordRouteTiming(req("/api/requirements"), at(10), res(200, 500), now);
  recordRouteTiming(req("/api/status?light=1"), at(5), res(503), now);
  recordRouteTiming(req("/api/status?light=1"), at(100), res(), now - 10 * 60_000); // 窗口外
  expect(recordRouteTiming(req("/ws"), 0, undefined, now)).toBeUndefined();
  const stats = routeStats(60_000, now);
  expect(stats.samples).toBe(3);
  expect(stats.routes.map(r => r.route)).toEqual(["GET /api/requirements", "GET /api/status?light=1"]);
  const r0 = stats.routes[0];
  expect(r0.count).toBe(2);
  expect(r0.bytes).toBe(1500);
  expect(r0.max_ms).toBeGreaterThanOrEqual(29);
  expect(r0.total_ms).toBeGreaterThanOrEqual(39);
  expect(r0.p95_ms).toBeLessThanOrEqual(r0.max_ms);
  expect(stats.routes[1].errors).toBe(1);
  // The old 4096-sample ring dropped everything past its size; the buckets count all of it.
  for (let i = 0; i < 10_000; i++) recordRouteTiming(req("/api/tasks"), at(1), res(), now);
  const after = routeStats(60_000, now);
  expect(after.routes.find(r => r.route === "GET /api/tasks")!.count).toBe(10_000);
  expect(after.samples).toBe(10_003);
});

test("?minutes=10 really covers 10 minutes: a steady 15 req/s stream is fully counted, older traffic is not", () => {
  __resetRouteTimingForTest();
  const t0 = 2_000_000_000 - (2_000_000_000 % ROUTE_BUCKET_MS); // bucket-aligned
  // 20 minutes at 15 req/s — the old ring filled in ~4.5 minutes of this.
  for (let s = 0; s < 20 * 60; s++) {
    for (let k = 0; k < 15; k++) recordRouteTiming(req("/mcp", "POST"), at(1), res(), t0 + s * 1000);
  }
  const now = t0 + 20 * 60_000;
  const ten = routeStats(10 * 60_000, now);
  // window starts at t0+10min → the ten minute buckets t0+10 … t0+19
  expect(ten.samples).toBe(10 * 60 * 15);
  expect(ten.oldest_at).toBe(new Date(t0 + 10 * 60_000).toISOString());
  expect(routeStats(20 * 60_000, now).samples).toBe(20 * 60 * 15);
  expect(routeStats(60 * 60_000, now).samples).toBe(20 * 60 * 15);
});

test("buckets older than the retention are dropped", () => {
  __resetRouteTimingForTest();
  const now = 3_000_000_000;
  const old = now - (ROUTE_BUCKET_RETENTION + 5) * ROUTE_BUCKET_MS;
  recordRouteTiming(req("/api/old"), at(1), res(), old);
  expect(routeStats(ROUTE_BUCKET_RETENTION * 2 * ROUTE_BUCKET_MS, old).samples).toBe(1);
  recordRouteTiming(req("/api/new"), at(1), res(), now);
  const s = routeStats(ROUTE_BUCKET_RETENTION * 2 * ROUTE_BUCKET_MS, now);
  expect(s.routes.map(r => r.route)).toEqual(["GET /api/new"]);
});

test("p95 comes from the histogram: close to the true value and never above max", () => {
  __resetRouteTimingForTest();
  const now = 4_000_000_000;
  // 96 fast (~1 ms) and 4 slow (~200 ms): p95 (the 96th of 100, same rank as the old ring's
  // sorted[floor(n·0.95)]) must be in the fast band, max in the slow band.
  for (let i = 0; i < 96; i++) recordRouteTiming(req("/api/p"), at(1), res(), now);
  for (let i = 0; i < 4; i++) recordRouteTiming(req("/api/p"), at(200), res(), now);
  const r = routeStats(60_000, now).routes[0];
  expect(r.p95_ms).toBeGreaterThanOrEqual(1);
  expect(r.p95_ms).toBeLessThan(5);
  expect(r.max_ms).toBeGreaterThanOrEqual(200);
  __resetRouteTimingForTest();
  recordRouteTiming(req("/api/q"), at(3), res(), now);
  const one = routeStats(60_000, now).routes[0];
  expect(one.p95_ms).toBe(one.max_ms);
});

test("distinct routes per bucket are capped; the rest land in the overflow key", () => {
  __resetRouteTimingForTest();
  const now = 5_000_000_000;
  for (let i = 0; i < ROUTE_MAX_KEYS_PER_BUCKET + 50; i++) {
    const r = req("/mcp", "POST");
    labelRoute(r, `tools/call t${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}x`);
    recordRouteTiming(r, at(1), res(), now);
  }
  const s = routeStats(60_000, now);
  expect(s.routes.length).toBe(ROUTE_MAX_KEYS_PER_BUCKET + 1);
  expect(s.routes.find(r => r.route === ROUTE_OVERFLOW_KEY)!.count).toBe(50);
  expect(s.samples).toBe(ROUTE_MAX_KEYS_PER_BUCKET + 50);
});

test("a label is appended to the route shape of that request only", () => {
  __resetRouteTimingForTest();
  const now = 6_000_000_000;
  const a = req("/mcp", "POST");
  labelRoute(a, "tools/call report_status");
  recordRouteTiming(a, at(1), res(), now);
  recordRouteTiming(req("/mcp", "POST"), at(1), res(), now);
  expect(routeStats(60_000, now).routes.map(r => r.route).sort()).toEqual(["POST /mcp", "POST /mcp tools/call report_status"]);
});

test("mcpRouteLabel: method, tool name, and nothing else", () => {
  expect(mcpRouteLabel({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_status", arguments: { task: "secret" } } })).toBe("tools/call report_status");
  expect(mcpRouteLabel({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe("tools/list");
  expect(mcpRouteLabel({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe("notifications/initialized");
  expect(mcpRouteLabel({ jsonrpc: "2.0", id: 1, method: "initialize", params: { name: "x" } })).toBe("initialize");
  // odd shapes collapse to "?"
  expect(mcpRouteLabel([{ method: "tools/list" }])).toBe("batch");
  expect(mcpRouteLabel(null)).toBe("?");
  expect(mcpRouteLabel("tools/list")).toBe("?");
  expect(mcpRouteLabel(42)).toBe("?");
  expect(mcpRouteLabel({})).toBe("?");
  expect(mcpRouteLabel({ method: 7 })).toBe("?");
  expect(mcpRouteLabel({ method: "x".repeat(65) })).toBe("?");
  expect(mcpRouteLabel({ method: "tools/call x" })).toBe("?");
  expect(mcpRouteLabel({ method: "通信" })).toBe("?");
  expect(mcpRouteLabel({ method: "tools/call" })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: "report_status" })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: { name: { toString: () => "x" } } })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: { name: "a b" } })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: { name: "../../etc/passwd" } })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: { name: "n".repeat(65) } })).toBe("tools/call ?");
  expect(mcpRouteLabel({ method: "tools/call", params: { name: "" } })).toBe("tools/call ?");
});

// ── caller classes (?by=caller) ──
const reqAs = (path: string, headers: Record<string, string>) => new Request(`http://hub${path}`, { headers });

test("userAgentFamily keeps only allow-listed product names and a sanitized version", () => {
  expect(userAgentFamily("agent-node/2.5.0-preview.88")).toBe("agent-node/2.5.0-preview.88");
  expect(userAgentFamily("node")).toBe("node");
  expect(userAgentFamily("Bun/1.2.19")).toBe("bun/1.2.19");
  expect(userAgentFamily("okhttp/4.12.0")).toBe("okhttp/4.12.0");
  expect(userAgentFamily("curl/8.5.0")).toBe("curl/8.5.0");
  expect(userAgentFamily("agent-network-desktop/0.2.170")).toBe("agent-network-desktop/0.2.170");
  expect(userAgentFamily("tauri-plugin-http/2.5.9")).toBe("tauri-plugin-http/2.5.9");
  expect(userAgentFamily("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("browser");
  expect(userAgentFamily("SomeApp/42 CFNetwork/1568.100.1 Darwin/24.0.0")).toBe("cfnetwork/1568.100.1");
  expect(userAgentFamily(null)).toBe("none");
  expect(userAgentFamily("   ")).toBe("none");
  // Free text never comes through: unknown product names, and anything after a version.
  expect(userAgentFamily("my-laptop-hostname/1.0")).toBe("other");
  expect(userAgentFamily("curl/8.5.0;user=alice@example.com")).toBe("curl/8.5.0");
  expect(userAgentFamily("node/abc-secret")).toBe("node");
});

test("callerTokenKind recognises token kinds without keeping the token", () => {
  setRouteCallerMasterToken("master-secret-xyz");
  // Header-only reader, as installed by default; another test file in the same process may have booted server.ts.
  const previous = setRouteCallerTokenReader(r => r.headers.get("authorization")?.replace("Bearer ", "") || "");
  try {
    const kind = (headers: Record<string, string>) => callerTokenKind(reqAs("/api/status", headers));
    expect(kind({ Authorization: "Bearer ntok_abc" })).toBe("node");
    expect(kind({ Authorization: "Bearer utok_abc" })).toBe("user");
    expect(kind({ Authorization: "Bearer master-secret-xyz" })).toBe("master");
    expect(kind({ Authorization: "Bearer something-else" })).toBe("token");
    expect(kind({})).toBe("anon");
    // ?token= is read only through the reader server.ts installs (requestToken); a header-only reader ignores it.
    expect(callerTokenKind(reqAs("/events/x?token=ntok_q", {}))).toBe("anon");
    setRouteCallerTokenReader(r => new URL(r.url).searchParams.get("t") || "");
    expect(callerTokenKind(reqAs("/events/x?t=ntok_q", {}))).toBe("node");
  } finally {
    setRouteCallerMasterToken(undefined);
    setRouteCallerTokenReader(previous);
  }
});

test("routeStats({byCaller}) counts per class; without it the rows have no callers field", () => {
  __resetRouteTimingForTest();
  const now = 3_000_000_000;
  const status = (headers: Record<string, string>, len: number) => recordRouteTiming(reqAs("/api/status", headers), at(1), res(200, len), now);
  for (let i = 0; i < 3; i++) status({ Authorization: "Bearer utok_secret1", "User-Agent": "node" }, 100);
  status({ Authorization: "Bearer ntok_secret2", "User-Agent": "agent-node/2.5.0-preview.88" }, 10);
  status({ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0" }, 1);
  const plain = routeStats(60_000, now);
  expect(plain.routes[0]).not.toHaveProperty("callers");
  const by = routeStats(60_000, now, { byCaller: true });
  expect(by.routes[0].callers).toEqual([
    { class: "user node", count: 3, bytes: 300 },
    { class: "node agent-node/2.5.0-preview.88", count: 1, bytes: 10 },
    { class: "anon browser", count: 1, bytes: 1 },
  ]);
  expect(JSON.stringify(by)).not.toMatch(/secret|Mozilla|Linux|Chrome/);
});

test("caller classes are capped per route: per bucket and again after merging buckets", () => {
  __resetRouteTimingForTest();
  const now = 4_000_000_000 - (4_000_000_000 % ROUTE_BUCKET_MS);
  // Minute 1: 30 distinct versions → 20 stored, 10 into (other). Minute 2: 25 more distinct ones.
  for (let i = 0; i < 30; i++) recordRouteTiming(reqAs("/api/status", { "User-Agent": `curl/${i}.0` }), at(1), res(200, 1), now - ROUTE_BUCKET_MS);
  for (let i = 100; i < 125; i++) recordRouteTiming(reqAs("/api/status", { "User-Agent": `curl/${i}.0` }), at(1), res(200, 1), now);
  const callers = routeStats(5 * 60_000, now, { byCaller: true }).routes[0].callers!;
  expect(callers.length).toBe(ROUTE_MAX_CALLERS_PER_ROUTE);
  expect(callers.at(-1)!.class).toBe(ROUTE_OVERFLOW_KEY);
  expect(callers.reduce((n, c) => n + c.count, 0)).toBe(55);
  expect(callers.reduce((n, c) => n + c.bytes, 0)).toBe(55);
});
