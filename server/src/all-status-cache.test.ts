import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_STATUS_TTL_MS, allStatusCacheKey, cachedAllStatus, clearAllStatusCache, invalidateAllStatusCache, rosterChanged } from "./all-status-cache";

beforeEach(() => clearAllStatusCache());

test("identical scope+filters within TTL reuse one serialized response", () => {
  let builds = 0, t = 1_000;
  const key = allStatusCacheKey({ networkId: "net_a", networkIds: null }, [null, null, null]);
  const build = () => `v${++builds}`;
  expect(cachedAllStatus(key, build, () => t)).toEqual({ text: "v1", hit: false });
  t += ALL_STATUS_TTL_MS - 1;
  expect(cachedAllStatus(key, build, () => t)).toEqual({ text: "v1", hit: true });
  t += 1;
  expect(cachedAllStatus(key, build, () => t)).toEqual({ text: "v2", hit: false });
});

test("different network, scope or filters never share an entry", () => {
  let n = 0; const build = () => `r${++n}`;
  const a = allStatusCacheKey({ networkId: "net_a", networkIds: null }, [null, null, null]);
  const b = allStatusCacheKey({ networkId: "net_b", networkIds: null }, [null, null, null]);
  const c = allStatusCacheKey({ networkId: "net_a", networkIds: null }, ["idle", null, null]);
  const d = allStatusCacheKey({ networkId: "net_a", networkIds: null }, [null, null, "x,y"]);
  expect(new Set([a, b, c, d]).size).toBe(4);
  expect(new Set([a, b, c, d].map(k => cachedAllStatus(k, build).text)).size).toBe(4);
});

test("null key (restricted member scope) always rebuilds", () => {
  let n = 0; const build = () => `r${++n}`;
  expect(cachedAllStatus(null, build).text).toBe("r1");
  expect(cachedAllStatus(null, build).text).toBe("r2");
});

test("a roster change is visible to the very next call, inside the TTL", () => {
  let n = 0; const build = () => `r${++n}`;
  const key = allStatusCacheKey({ networkId: "net_a", networkIds: null }, [null, null, null]);
  expect(cachedAllStatus(key, build, () => 1_000)).toEqual({ text: "r1", hit: false });
  expect(cachedAllStatus(key, build, () => 1_001)).toEqual({ text: "r1", hit: true });
  invalidateAllStatusCache(); // a node registered
  expect(cachedAllStatus(key, build, () => 1_002)).toEqual({ text: "r2", hit: false });
  expect(cachedAllStatus(key, build, () => 1_003)).toEqual({ text: "r2", hit: true });
});

test("only appearing, returning and leaving count as a roster change — heartbeats do not", () => {
  expect(rosterChanged(undefined, "idle")).toBe(true);      // first report of this session
  expect(rosterChanged(null, "working")).toBe(true);
  expect(rosterChanged("offline", "idle")).toBe(true);      // came back
  expect(rosterChanged("stale", "idle")).toBe(true);
  expect(rosterChanged("idle", "offline")).toBe(true);      // left
  expect(rosterChanged("working", "offline")).toBe(true);
  for (const [a, b] of [["idle", "idle"], ["idle", "working"], ["working", "idle"], ["blocked", "working"], ["offline", "offline"], ["stale", "offline"]]) {
    expect(rosterChanged(a, b)).toBe(false);
  }
});

test("report_status checks for a roster change before it writes the session", () => {
  const tools = readFileSync(join(import.meta.dir, "tools.ts"), "utf8");
  const check = tools.indexOf("if (rosterChanged(db.get<{ status: string | null }>(\"SELECT status FROM sessions WHERE resume_id = ?1\", resume_id)?.status, storedStatus)) invalidateAllStatusCache();");
  const write = tools.indexOf("INSERT INTO sessions (resume_id, alias, tmux_name,");
  expect(check).toBeGreaterThan(0);
  expect(write).toBeGreaterThan(check); // the prior status must be read before the upsert replaces it
});
