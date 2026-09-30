import { expect, test } from "bun:test";
import {
  __resetRouteTimingForTest, labelRoute, mcpRouteLabel, recordRouteTiming, routeKey, routeStats,
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
