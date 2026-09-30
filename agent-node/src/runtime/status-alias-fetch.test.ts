// status-alias-fetch — CurrentAliasResolver's transport picks the small ?node_id=&light=1 read on hubs
// that advertise `status_node_id` in /health, and the old full-network read otherwise.
//
//   1. new hub → one /health probe, then ONE small request per refresh (never the full read)
//   2. old hub (no capabilities / /health fails / non-2xx) → the full read, same URL as before
//   3. new hub, unknown node → empty list → null, no full read
//   4. hub advertises the flag but ignores the param → full read now, flag distrusted until re-probe
//   5. filtered read non-2xx → full read
//   6. probe is cached, re-probed after the TTL (hub upgrade picked up without a restart)
//   7. token read per request; network_id kept on both reads; fetch errors → null
//   8. with CurrentAliasResolver: the 30 s cache still means one request per 30 s
import { describe, expect, test } from "bun:test";
import { createStatusAliasFetcher, STATUS_NODE_ID_CAPABILITY } from "./status-alias-fetch";
import { CurrentAliasResolver } from "./current-alias";

type Call = { url: string; auth: string | null };
type Route = (url: URL) => Response | Promise<Response>;

function fakeHub(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    calls.push({ url: `${url.pathname}${url.search}`, auth: init?.headers?.Authorization ?? null });
    return route(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const FULL = { ok: true, sessions: [
  { node_id: "node-a", alias: "agent-a", host: {} },
  { node_id: "node-b", alias: "agent-b", host: {} },
] };

/** A hub from after the node_id filter: honours ?node_id= and advertises it. */
function newHub() {
  return fakeHub((url) => {
    if (url.pathname === "/health") return json({ ok: true, capabilities: [STATUS_NODE_ID_CAPABILITY] });
    const id = url.searchParams.get("node_id");
    if (id) return json({ ok: true, sessions: FULL.sessions.filter((s) => s.node_id === id).map((s) => ({ alias: s.alias, node_id: s.node_id })) });
    return json(FULL);
  });
}
/** A hub from before: no capabilities, ignores ?node_id= (light rows carry no node_id). */
function oldHub() {
  return fakeHub((url) => {
    if (url.pathname === "/health") return json({ ok: true, version: "0.9.0-preview.75" });
    if (url.searchParams.get("light") === "1") return json({ ok: true, sessions: FULL.sessions.map((s) => ({ alias: s.alias })) });
    return json(FULL);
  });
}

const opts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  ({ hubUrl: "http://hub", token: () => "ntok_x", networkId: "net_1", fetchImpl, ...extra });

describe("createStatusAliasFetcher", () => {
  test("new hub: one probe, then one small filtered request per call", async () => {
    const hub = newHub();
    const f = createStatusAliasFetcher(opts(hub.fetchImpl));
    expect(await f("node-b")).toBe("agent-b");
    expect(await f("node-b")).toBe("agent-b");
    expect(hub.calls.map((c) => c.url)).toEqual([
      "/health",
      "/api/status?network_id=net_1&node_id=node-b&light=1",
      "/api/status?network_id=net_1&node_id=node-b&light=1",
    ]);
    // /health is anonymous; the status reads carry the token
    expect(hub.calls[0].auth).toBeNull();
    expect(hub.calls[1].auth).toBe("Bearer ntok_x");
  });

  test("old hub: falls back to today's full read (same URL as before)", async () => {
    const hub = oldHub();
    const f = createStatusAliasFetcher(opts(hub.fetchImpl));
    expect(await f("node-a")).toBe("agent-a");
    expect(await f("node-a")).toBe("agent-a");
    expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1", "/api/status?network_id=net_1"]);
  });

  test("/health failing or non-2xx is treated as an old hub", async () => {
    for (const health of [() => { throw new Error("ECONNRESET"); }, () => json({ ok: false }, 503), () => new Response("not json")]) {
      const hub = fakeHub((url) => (url.pathname === "/health" ? health() : json(FULL)));
      const f = createStatusAliasFetcher(opts(hub.fetchImpl));
      expect(await f("node-b")).toBe("agent-b");
      expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1"]);
    }
  });

  test("new hub, unknown node: empty list → null, and no full read", async () => {
    const hub = newHub();
    const f = createStatusAliasFetcher(opts(hub.fetchImpl));
    expect(await f("node-nobody")).toBeNull();
    expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1&node_id=node-nobody&light=1"]);
  });

  test("flag advertised but param ignored: full read now, and the flag is not trusted again until re-probe", async () => {
    let t = 1_000;
    const hub = fakeHub((url) => {
      if (url.pathname === "/health") return json({ ok: true, capabilities: [STATUS_NODE_ID_CAPABILITY] });
      if (url.searchParams.get("light") === "1") return json({ ok: true, sessions: FULL.sessions.map((s) => ({ alias: s.alias })) });
      return json(FULL);
    });
    const f = createStatusAliasFetcher(opts(hub.fetchImpl, { now: () => t, probeTtlMs: 60_000 }));
    expect(await f("node-b")).toBe("agent-b");
    expect(await f("node-b")).toBe("agent-b");
    expect(hub.calls.map((c) => c.url)).toEqual([
      "/health",
      "/api/status?network_id=net_1&node_id=node-b&light=1",
      "/api/status?network_id=net_1",
      "/api/status?network_id=net_1",
    ]);
    t += 60_000;
    hub.calls.length = 0;
    await f("node-b");
    expect(hub.calls[0].url).toBe("/health");
  });

  test("filtered read non-2xx → full read", async () => {
    const hub = fakeHub((url) => {
      if (url.pathname === "/health") return json({ ok: true, capabilities: [STATUS_NODE_ID_CAPABILITY] });
      if (url.searchParams.has("node_id")) return json({ ok: false }, 500);
      return json(FULL);
    });
    const f = createStatusAliasFetcher(opts(hub.fetchImpl));
    expect(await f("node-a")).toBe("agent-a");
    expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1&node_id=node-a&light=1", "/api/status?network_id=net_1"]);
  });

  test("probe is cached for the TTL and re-read after it: a hub upgrade is picked up without a restart", async () => {
    let t = 5_000;
    let upgraded = false;
    const hub = fakeHub((url) => {
      if (url.pathname === "/health") return json(upgraded ? { ok: true, capabilities: [STATUS_NODE_ID_CAPABILITY] } : { ok: true });
      const id = url.searchParams.get("node_id");
      if (upgraded && id) return json({ ok: true, sessions: FULL.sessions.filter((s) => s.node_id === id) });
      return json(FULL);
    });
    const f = createStatusAliasFetcher(opts(hub.fetchImpl, { now: () => t, probeTtlMs: 600_000 }));
    await f("node-a");
    upgraded = true;
    t += 30_000;
    await f("node-a"); // still within the probe TTL → full read, no second probe
    expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1", "/api/status?network_id=net_1"]);
    t += 600_000;
    hub.calls.length = 0;
    expect(await f("node-a")).toBe("agent-a");
    expect(hub.calls.map((c) => c.url)).toEqual(["/health", "/api/status?network_id=net_1&node_id=node-a&light=1"]);
  });

  test("token is read per request; no network_id → no network_id param; fetch errors → null", async () => {
    let token = "ntok_first";
    const hub = newHub();
    const f = createStatusAliasFetcher({ hubUrl: "http://hub", token: () => token, fetchImpl: hub.fetchImpl });
    await f("node-a");
    token = "ntok_rotated";
    await f("node-a");
    expect(hub.calls.slice(1).map((c) => [c.url, c.auth])).toEqual([
      ["/api/status?node_id=node-a&light=1", "Bearer ntok_first"],
      ["/api/status?node_id=node-a&light=1", "Bearer ntok_rotated"],
    ]);
    const dead = fakeHub(() => { throw new Error("ECONNREFUSED"); });
    expect(await createStatusAliasFetcher(opts(dead.fetchImpl))("node-a")).toBeNull();
  });

  test("node ids are URL-encoded", async () => {
    const hub = newHub();
    await createStatusAliasFetcher(opts(hub.fetchImpl))("node a&b=c");
    expect(hub.calls[1].url).toBe("/api/status?network_id=net_1&node_id=node%20a%26b%3Dc&light=1");
  });

  test("with CurrentAliasResolver: the 30 s cache still means one status request per 30 s", async () => {
    const hub = newHub();
    const resolver = new CurrentAliasResolver({
      initialAlias: "agent-b-old",
      nodeId: "node-b",
      cacheTtlMs: 30_000,
      fetchCanonicalAlias: createStatusAliasFetcher(opts(hub.fetchImpl)),
    });
    expect(await resolver.refresh(1_000)).toBe("agent-b");
    expect(await resolver.refresh(20_000)).toBe("agent-b");
    expect(await resolver.refresh(30_999)).toBe("agent-b");
    const statusCalls = () => hub.calls.filter((c) => c.url.startsWith("/api/status"));
    expect(statusCalls()).toHaveLength(1);
    await resolver.refresh(31_000);
    expect(statusCalls()).toHaveLength(2);
    expect(statusCalls().every((c) => c.url.includes("node_id=node-b&light=1"))).toBe(true);
  });
});
