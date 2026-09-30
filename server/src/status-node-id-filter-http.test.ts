// GET /api/status?node_id=<id> — one node's rows instead of the whole network.
// Every agent-node resolves its own current alias every 30 s (CurrentAliasResolver). Unfiltered that
// is the whole network's full projection (~91 KB gzip per call on production, ~90 nodes ⇒ ~3 req/s)
// to read one row. This suite pins that the filter narrows, never widens (it is exactly the caller's
// unfiltered rows with that node_id, for every kind of caller), that it combines with light=1 (which
// then carries node_id so the caller can check the row is its own), that an unknown id is an empty
// list rather than an error, that no/blank node_id is byte-identical to the old response, and that
// /health advertises it.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-status-node-id-"));
let BASE = "";
let hub: any = null;
const PW = "StatusNodeIdPassw0rd!";
let aToken = "", aId = "", NET_A = "";
let bToken = "", bId = "", NET_B = "";
let nodeToken = "";

async function raw(token: string | null, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, text: await res.text() };
}
async function get(token: string, path: string) {
  const r = await raw(token, path);
  return { status: r.status, body: JSON.parse(r.text) as any };
}
function seed(alias: string, node: string, net: string, owner: string, minutesAgo: number) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)`, [node, alias, net, owner]);
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, task, updated_at, last_seen_at) VALUES (?1, ?2, ?3, 'idle', ?4, ?5, datetime('now', ?6), datetime('now'))`,
    [`r_${node}`, alias, node, net, `task of ${alias}`, `-${minutesAgo} minutes`],
  );
}
const nodeIds = (rows: any[]) => rows.map(r => r.node_id);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`sn_owner_a_${Date.now()}`, PW);
  aToken = a.token!; aId = a.user!.user_id; NET_A = a.network_id!;
  const b = register(`sn_owner_b_${Date.now()}`, PW);
  bToken = b.token!; bId = b.user!.user_id; NET_B = b.network_id!;
  seed("sn-one", "node_sn_one", NET_A, aId, 1);
  seed("sn-two", "node_sn_two", NET_A, aId, 2);
  seed("sn-three", "node_sn_three", NET_A, aId, 3);
  seed("sn-b-only", "node_sn_b_only", NET_B, bId, 0);
  const minted = createNetworkTokenForNode(aId, NET_A, "sn-two", "node_sn_two");
  nodeToken = minted.token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("/api/status?node_id=", () => {
  test("node_id narrows the full projection to that node", async () => {
    const r = await get(aToken, `/api/status?network_id=${NET_A}&node_id=node_sn_two`);
    expect(r.status).toBe(200);
    expect(nodeIds(r.body.sessions)).toEqual(["node_sn_two"]);
    expect(r.body.sessions[0].alias).toBe("sn-two");
    expect(typeof r.body.sessions[0].rules_file_capable).toBe("boolean");
    expect(r.body.sessions[0].host).toBeDefined();
    expect(r.body.summary.total).toBe(1);
  });

  test("combines with light=1: light projection, one row, and it carries node_id", async () => {
    const r = await get(aToken, `/api/status?light=1&network_id=${NET_A}&node_id=node_sn_three`);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toHaveLength(1);
    expect(r.body.sessions[0].alias).toBe("sn-three");
    expect(r.body.sessions[0].node_id).toBe("node_sn_three");
    expect(r.body.sessions[0].host).toBeUndefined();
    expect(Object.keys(r.body.sessions[0]).sort()).toEqual(
      ["agent", "alias", "network_id", "node_id", "runtime", "server", "status", "task", "updated_at"],
    );
  });

  test("unknown id is an empty list with 200, not a 404", async () => {
    for (const path of [`/api/status?network_id=${NET_A}&node_id=node_nobody`, `/api/status?light=1&node_id=node_nobody`]) {
      const r = await get(aToken, path);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.sessions).toEqual([]);
      expect(r.body.summary.total).toBe(0);
    }
  });

  test("absent or blank node_id: response bytes identical to the old read (full and light)", async () => {
    for (const base of [`/api/status?network_id=${NET_A}`, `/api/status?light=1&network_id=${NET_A}`, `/api/status`]) {
      const plain = await raw(aToken, base);
      const blank = await raw(aToken, `${base}${base.includes("?") ? "&" : "?"}node_id=%20`);
      expect(plain.status).toBe(200);
      expect(blank.text).toBe(plain.text);
    }
    // the light rows without the param never gained a node_id field
    const light = await get(aToken, `/api/status?light=1&network_id=${NET_A}`);
    expect(light.body.sessions.length).toBe(3);
    for (const s of light.body.sessions) expect("node_id" in s).toBe(false);
  });

  test("never widens: for every caller, filtered == that caller's unfiltered rows with that node_id", async () => {
    const callers = [aToken, bToken, nodeToken];
    const ids = ["node_sn_one", "node_sn_two", "node_sn_three", "node_sn_b_only", "node_nobody"];
    for (const tok of callers) {
      const full = await get(tok, `/api/status`);
      expect(full.status).toBe(200);
      for (const id of ids) {
        const one = await get(tok, `/api/status?node_id=${id}`);
        expect(one.status).toBe(full.status);
        expect(one.body.sessions).toEqual(full.body.sessions.filter((s: any) => s.node_id === id));
      }
    }
  });

  test("a member of another network gets nothing for a node outside their network", async () => {
    const r = await get(bToken, `/api/status?node_id=node_sn_one`);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toEqual([]);
    const own = await get(bToken, `/api/status?node_id=node_sn_b_only`);
    expect(nodeIds(own.body.sessions)).toEqual(["node_sn_b_only"]);
  });

  test("a node token reads its own row (light) and nothing from another network", async () => {
    const own = await get(nodeToken, `/api/status?light=1&node_id=node_sn_two`);
    expect(own.status).toBe(200);
    expect(own.body.sessions.map((s: any) => [s.node_id, s.alias])).toEqual([["node_sn_two", "sn-two"]]);
    const foreign = await get(nodeToken, `/api/status?light=1&node_id=node_sn_b_only`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.sessions).toEqual([]);
    // explicit other network_id is refused exactly as without the filter
    const cross = await raw(nodeToken, `/api/status?network_id=${NET_B}&node_id=node_sn_b_only`);
    const crossNoFilter = await raw(nodeToken, `/api/status?network_id=${NET_B}`);
    expect(cross.status).toBe(crossNoFilter.status);
    if (cross.status !== 200) expect(cross.text).toBe(crossNoFilter.text);
    else expect(JSON.parse(cross.text).sessions).toEqual([]);
  });

  test("unauthenticated read is refused exactly as without the filter", async () => {
    const withFilter = await raw(null, `/api/status?node_id=node_sn_one`);
    const without = await raw(null, `/api/status`);
    expect(withFilter.status).toBe(without.status);
    expect(withFilter.text).toBe(without.text);
  });

  test("/health advertises status_node_id", async () => {
    const r = await raw(null, `/health`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).capabilities).toContain("status_node_id");
  });
});
