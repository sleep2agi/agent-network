// GET /api/requirements conditional requests: ETag on every list response, 304 with an empty body
// when If-None-Match matches. The app polls the whole list every 15 s (production: 500 rows,
// 708 KB / 163 KB gzip) and it is unchanged on almost every poll. Old clients never send
// If-None-Match and keep getting the full 200.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-requirements-etag-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

let server: { port: number; stop?: (force?: boolean) => void };
let base = "";
let ownerToken = "", network = "";

const list = (token: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/requirements?network_id=${network}`, { headers: { Authorization: `Bearer ${token}`, ...headers } });

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const owner = register(`etag_owner_${Date.now()}`, "EtagOwnerPassw0rd!", undefined, "seed");
  ownerToken = owner.token!; network = owner.network_id!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  const created = await fetch(`${base}/api/requirements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "etag card", network_id: network }),
  });
  expect(created.status).toBe(201);
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("GET /api/requirements conditional requests", () => {
  test("a plain GET is the same 200 JSON as before, plus ETag and private/no-cache", async () => {
    const res = await list(ownerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("etag")).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.requirements.map((r: any) => r.name)).toEqual(["etag card"]);
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  test("If-None-Match with the current ETag → 304, empty body, same ETag", async () => {
    const etag = (await list(ownerToken)).headers.get("etag")!;
    const res = await list(ownerToken, { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
    // strong/weak spelling and lists are accepted
    expect((await list(ownerToken, { "If-None-Match": etag.replace(/^W\//, "") })).status).toBe(304);
    expect((await list(ownerToken, { "If-None-Match": `W/"stale", ${etag}` })).status).toBe(304);
  });

  test("304 survives gzip negotiation (not compressed, still empty)", async () => {
    const etag = (await list(ownerToken, { "Accept-Encoding": "gzip" })).headers.get("etag")!;
    const res = await list(ownerToken, { "If-None-Match": etag, "Accept-Encoding": "gzip" });
    expect(res.status).toBe(304);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("any change to the list changes the ETag → full 200 again", async () => {
    const before = await list(ownerToken);
    const etag = before.headers.get("etag")!;
    const id = ((await before.json()) as any).requirements[0].id;
    const patched = await fetch(`${base}/api/requirements/${id}?network_id=${network}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "etag card renamed" }),
    });
    expect(patched.status).toBe(200);
    const res = await list(ownerToken, { "If-None-Match": etag });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(etag);
    expect(((await res.json()) as any).requirements[0].name).toBe("etag card renamed");
  });

  test("a stale or foreign ETag never yields 304", async () => {
    expect((await list(ownerToken, { "If-None-Match": 'W/"not-the-current-one"' })).status).toBe(200);
    expect((await list(ownerToken, { "If-None-Match": "" })).status).toBe(200);
  });
});
