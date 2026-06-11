// #146 PR-4 — unit tests for the live alias resolver.
//
// Coverage matrix per #146 PR-4 design contract:
//   1. current() returns startup snapshot before any refresh
//   2. refresh() warm-cache short-circuits, no fetch fired
//   3. refresh() expired-cache hits the server, updates the alias,
//      fires onDrift("fetch")
//   4. Concurrent refresh() calls dedupe onto one fetch
//   5. fetchCanonicalAlias throwing keeps the cached value (graceful
//      fallback, no propagation)
//   6. fetchCanonicalAlias returning null is treated as "server doesn't
//      know yet" and keeps the cache
//   7. After a failed fetch, the cache timestamp still bumps so we
//      don't hammer a sick hub on every call
//   8. set() force-installs the alias and fires onDrift("snapshot")
//   9. set() with the same value is a no-op (no drift event)
//   10. nodeId == null short-circuits refresh() — no fetch hook called
//   11. cacheTtlMs = 0 disables caching — every refresh() fetches
//   12. ageMs() / isFresh() reflect actual cache state for assertions
import { describe, expect, test } from "bun:test";
import { CurrentAliasResolver } from "./current-alias";

function makeResolver(opts: {
  initialAlias?: string;
  nodeId?: string | null;
  cacheTtlMs?: number;
  fetchImpl?: (nodeId: string) => Promise<string | null>;
  onDrift?: (from: string, to: string, source: "fetch" | "snapshot") => void;
  warn?: (msg: string) => void;
} = {}) {
  let fetchCalls = 0;
  return {
    resolver: new CurrentAliasResolver({
      initialAlias: opts.initialAlias ?? "old-agent",
      nodeId: opts.nodeId === undefined ? "node-x" : opts.nodeId,
      cacheTtlMs: opts.cacheTtlMs,
      fetchCanonicalAlias: opts.fetchImpl ?? (async () => { fetchCalls++; return "old-agent"; }),
      onDrift: opts.onDrift,
      warn: opts.warn,
    }),
    fetchCalls: () => fetchCalls,
  };
}

describe("CurrentAliasResolver — startup snapshot", () => {
  test("current() returns the initial alias before any refresh()", () => {
    const { resolver } = makeResolver({ initialAlias: "startup-alias" });
    expect(resolver.current()).toBe("startup-alias");
  });

  test("ageMs() reports Infinity before first fetch (cache is cold)", () => {
    const { resolver } = makeResolver();
    expect(resolver.ageMs()).toBe(Number.POSITIVE_INFINITY);
    expect(resolver.isFresh()).toBe(false);
  });
});

describe("CurrentAliasResolver — refresh() cache behaviour", () => {
  test("warm cache short-circuits — no fetch fired within TTL", async () => {
    let fetchCalls = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent-v1",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => { fetchCalls++; return "agent-v2"; },
    });
    const t0 = 1_700_000_000_000;
    await resolver.refresh(t0); // primes cache
    await resolver.refresh(t0 + 1_000); // 1s later, well within TTL
    await resolver.refresh(t0 + 29_999); // just before expiry
    expect(fetchCalls).toBe(1); // only the priming call
  });

  test("expired cache hits the server and updates the alias + fires onDrift", async () => {
    const drifts: Array<{ from: string; to: string; source: string }> = [];
    let phase = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "v1-agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => {
        phase++;
        return phase === 1 ? "v1-agent" : "v2-agent";
      },
      onDrift: (from, to, source) => { drifts.push({ from, to, source }); },
    });
    const t0 = 1_700_000_000_000;
    await resolver.refresh(t0);
    expect(resolver.current()).toBe("v1-agent");
    expect(drifts).toHaveLength(0); // no change yet

    await resolver.refresh(t0 + 30_001); // past TTL
    expect(resolver.current()).toBe("v2-agent");
    expect(drifts).toEqual([{ from: "v1-agent", to: "v2-agent", source: "fetch" }]);
  });

  test("concurrent refresh() calls dedupe onto one fetch", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
        return "new-agent";
      },
    });
    const results = await Promise.all([
      resolver.refresh(0),
      resolver.refresh(0),
      resolver.refresh(0),
      resolver.refresh(0),
      resolver.refresh(0),
    ]);
    expect(maxInflight).toBe(1);
    expect(results.every((r) => r === "new-agent")).toBe(true);
  });
});

describe("CurrentAliasResolver — graceful fetch failure", () => {
  test("fetch throwing keeps the cached value and emits a warn", async () => {
    let warned: string | undefined;
    const resolver = new CurrentAliasResolver({
      initialAlias: "stable-agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => { throw new Error("ECONNREFUSED hub is down"); },
      warn: (m) => { warned = m; },
    });
    const t0 = 1_700_000_000_000;
    const result = await resolver.refresh(t0);
    expect(result).toBe("stable-agent");
    expect(resolver.current()).toBe("stable-agent");
    expect(warned).toContain("ECONNREFUSED");
    expect(warned).toContain("stable-agent");
  });

  test("fetch returning null is treated as 'server does not know yet'", async () => {
    const resolver = new CurrentAliasResolver({
      initialAlias: "boot-agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => null,
    });
    expect(await resolver.refresh(1)).toBe("boot-agent");
  });

  test("fetch returning empty string is also treated as 'server does not know'", async () => {
    const resolver = new CurrentAliasResolver({
      initialAlias: "boot-agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => "",
    });
    expect(await resolver.refresh(1)).toBe("boot-agent");
  });

  test("after a failed fetch the cache timestamp still bumps — no hammering", async () => {
    let fetchCalls = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => { fetchCalls++; throw new Error("hub down"); },
    });
    const t0 = 1_700_000_000_000;
    await resolver.refresh(t0);
    expect(fetchCalls).toBe(1);
    // Immediately again — cache is "warm" with the failure, no new fetch.
    await resolver.refresh(t0 + 5_000);
    await resolver.refresh(t0 + 25_000);
    expect(fetchCalls).toBe(1);
    // After TTL expires, we retry.
    await resolver.refresh(t0 + 30_001);
    expect(fetchCalls).toBe(2);
  });
});

describe("CurrentAliasResolver — set() force install", () => {
  test("set() updates the alias and fires onDrift with source 'snapshot'", () => {
    const drifts: Array<{ from: string; to: string; source: string }> = [];
    const resolver = new CurrentAliasResolver({
      initialAlias: "old-name",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => "irrelevant",
      onDrift: (from, to, source) => { drifts.push({ from, to, source }); },
    });
    resolver.set("new-name", 1234);
    expect(resolver.current()).toBe("new-name");
    expect(drifts).toEqual([{ from: "old-name", to: "new-name", source: "snapshot" }]);
    expect(resolver.isFresh(1234)).toBe(true);
  });

  test("set() with the same value is a no-op (no drift event, but cache timestamp bumps)", () => {
    let driftCount = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "stable",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => "stable",
      onDrift: () => { driftCount++; },
    });
    resolver.set("stable", 1000);
    expect(driftCount).toBe(0);
    expect(resolver.ageMs(1000)).toBe(0);
  });

  test("set('') is ignored (defends against caller forgetting to validate)", () => {
    const resolver = new CurrentAliasResolver({
      initialAlias: "real-name",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => "irrelevant",
    });
    resolver.set("");
    expect(resolver.current()).toBe("real-name");
  });
});

describe("CurrentAliasResolver — edge cases", () => {
  test("nodeId = null short-circuits refresh() and never calls the fetch hook", async () => {
    let fetchCalls = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "lonely-agent",
      nodeId: null,
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => { fetchCalls++; return "x"; },
    });
    expect(await resolver.refresh(1)).toBe("lonely-agent");
    expect(await resolver.refresh(60_000)).toBe("lonely-agent");
    expect(fetchCalls).toBe(0);
  });

  test("cacheTtlMs = 0 disables caching — every refresh() fetches", async () => {
    let fetchCalls = 0;
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent",
      nodeId: "node-x",
      cacheTtlMs: 0,
      fetchCanonicalAlias: async () => { fetchCalls++; return "agent"; },
    });
    await resolver.refresh(1);
    await resolver.refresh(2);
    await resolver.refresh(3);
    expect(fetchCalls).toBe(3);
  });

  test("ageMs() reflects elapsed time after a refresh", async () => {
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent",
      nodeId: "node-x",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: async () => "agent",
    });
    await resolver.refresh(1000);
    expect(resolver.ageMs(1500)).toBe(500);
    expect(resolver.isFresh(1500)).toBe(true);
    expect(resolver.isFresh(31_001)).toBe(false);
  });
});
