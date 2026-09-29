// GET /api/status?alias=<name> — one agent's rows instead of the whole network.
// The app's chat info / node detail read the FULL projection for a single agent; unfiltered that
// was every session (533 KB raw / 94 KB gzip on the production network) per open and per 10 s poll.
// Old hubs ignore the parameter, so the app keeps picking its row by alias; this suite pins that
// the filter narrows, never widens (network scope still applies), and that no/blank alias is the
// old response.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-status-alias-"));
let BASE = "";
let hub: any = null;
const PW = "StatusAliasPassw0rd!";
let aToken = "", aId = "", NET_A = "";
let bToken = "", bId = "", NET_B = "";

async function get(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
function seed(alias: string, node: string, net: string, owner: string, minutesAgo: number) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [node, alias, net, owner]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, task, updated_at, last_seen_at) VALUES (?1, ?2, ?3, 'idle', ?4, ?5, datetime('now', ?6), datetime('now'))`,
    [`r_${node}`, alias, node, net, `task of ${alias}`, `-${minutesAgo} minutes`],
  );
}
const aliases = (rows: any[]) => rows.map(r => r.alias);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`sa_owner_a_${Date.now()}`, PW);
  aToken = a.token!; aId = a.user!.user_id; NET_A = a.network_id!;
  const b = register(`sa_owner_b_${Date.now()}`, PW);
  bToken = b.token!; bId = b.user!.user_id; NET_B = b.network_id!;
  seed("sa-one", "node_sa_one", NET_A, aId, 1);
  seed("sa-two", "node_sa_two", NET_A, aId, 2);
  seed("sa-three", "node_sa_three", NET_A, aId, 3);
  // Same alias in someone else's network: the filter must not reach it.
  seed("sa-two", "node_sa_two_b", NET_B, bId, 0);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("/api/status?alias=", () => {
  test("no alias: every session in scope, newest first (unchanged)", async () => {
    const r = await get(aToken, `/api/status?network_id=${NET_A}`);
    expect(r.status).toBe(200);
    expect(aliases(r.body.sessions)).toEqual(["sa-one", "sa-two", "sa-three"]);
    expect(r.body.summary.total).toBe(3);
  });

  test("alias narrows the full projection to that agent", async () => {
    const r = await get(aToken, `/api/status?network_id=${NET_A}&alias=sa-two`);
    expect(r.status).toBe(200);
    expect(aliases(r.body.sessions)).toEqual(["sa-two"]);
    expect(r.body.sessions[0].node_id).toBe("node_sa_two");
    // still the full projection (capability bits / host block), not the light one
    expect(typeof r.body.sessions[0].rules_file_capable).toBe("boolean");
    expect(r.body.sessions[0].host).toBeDefined();
    expect(r.body.summary.total).toBe(1);
  });

  test("alias narrows the light projection too", async () => {
    const r = await get(aToken, `/api/status?light=1&network_id=${NET_A}&alias=sa-three`);
    expect(aliases(r.body.sessions)).toEqual(["sa-three"]);
    expect(r.body.sessions[0].host).toBeUndefined();
  });

  test("the filter never widens scope: same alias in another network stays invisible", async () => {
    const scoped = await get(aToken, `/api/status?network_id=${NET_A}&alias=sa-two`);
    expect(scoped.body.sessions.map((s: any) => s.node_id)).toEqual(["node_sa_two"]);
    // Unscoped: whatever the caller's scope already shows (the first registered user is an admin
    // here, so that is both networks) — the filter only picks rows out of it, never adds any.
    const all = await get(aToken, `/api/status`);
    const unscoped = await get(aToken, `/api/status?alias=sa-two`);
    expect(unscoped.body.sessions.map((s: any) => s.node_id)).toEqual(all.body.sessions.filter((s: any) => s.alias === "sa-two").map((s: any) => s.node_id));
  });

  test("a non-admin member only ever gets their own network's row for a shared alias", async () => {
    const r = await get(bToken, `/api/status?alias=sa-two`);
    expect(r.body.sessions.map((s: any) => s.node_id)).toEqual(["node_sa_two_b"]);
    const other = await get(bToken, `/api/status?alias=sa-one`);
    expect(other.body.sessions).toEqual([]);
  });

  test("blank alias is ignored; unknown alias is an empty list, not an error", async () => {
    expect(aliases((await get(aToken, `/api/status?network_id=${NET_A}&alias=%20`)).body.sessions)).toEqual(["sa-one", "sa-two", "sa-three"]);
    const none = await get(aToken, `/api/status?network_id=${NET_A}&alias=nobody`);
    expect(none.status).toBe(200);
    expect(none.body.sessions).toEqual([]);
  });
});
