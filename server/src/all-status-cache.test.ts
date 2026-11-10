import { beforeEach, expect, test } from "bun:test";
import { ALL_STATUS_TTL_MS, allStatusCacheKey, cachedAllStatus, clearAllStatusCache } from "./all-status-cache";

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
