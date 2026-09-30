import { expect, test } from "bun:test";
import { __resetRouteTimingForTest, recordRouteTiming, routeKey, routeStats, ROUTE_RING_SIZE } from "./route-timing";

const u = (s: string) => new URL(`http://hub${s}`);

test("routeKey collapses ids, aliases and file names, keeps payload-shaping params", () => {
  expect(routeKey("GET", u("/api/requirements?network_id=net_1&limit=500"))).toBe("GET /api/requirements");
  expect(routeKey("GET", u("/api/requirements?view=summary&network_id=n"))).toBe("GET /api/requirements?view=summary");
  expect(routeKey("PATCH", u("/api/requirements/req_3f9a/checklist/c1"))).toBe("PATCH /api/requirements/:id/checklist/:id");
  expect(routeKey("GET", u("/api/requirements/stats"))).toBe("GET /api/requirements/stats");
  expect(routeKey("GET", u("/api/status?light=1"))).toBe("GET /api/status?light=1");
  expect(routeKey("GET", u(`/api/nodes/${encodeURIComponent("通信牛")}/config`))).toBe("GET /api/nodes/:id/config");
  expect(routeKey("GET", u("/api/messages?scope=user&limit=50"))).toBe("GET /api/messages?scope=user");
});

test("routeStats groups the window, sorts by total time, and the ring keeps only the newest samples", () => {
  __resetRouteTimingForTest();
  const now = 1_000_000;
  const req = (path: string) => new Request(`http://hub${path}`);
  const res = (status = 200, len?: number) => new Response("x", { status, headers: len === undefined ? {} : { "Content-Length": String(len) } });
  const at = (ms: number) => performance.now() - ms;
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
  expect(stats.routes[1].errors).toBe(1);
  for (let i = 0; i < ROUTE_RING_SIZE + 10; i++) recordRouteTiming(req("/api/tasks"), at(1), res(), now);
  const after = routeStats(60_000, now);
  expect(after.samples).toBe(ROUTE_RING_SIZE);
  expect(after.routes.map(r => r.route)).toEqual(["GET /api/tasks"]);
});
