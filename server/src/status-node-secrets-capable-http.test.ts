// The node 密钥 page gates on node_secrets_capable. Nodes report it in
// nodes.config_snapshot; /api/status did not project it, so the app fell back to the
// runtime version (null for claude-code nodes) and told a capable node to upgrade.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-status-node-secrets-"));
let BASE = "", hub: any = null, userToken = "", userId = "", NET = "";

function seed(node: string, alias: string, snapshot: Record<string, unknown> | null) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, config_snapshot) VALUES (?1, ?2, ?2, ?3, ?4, ?5)`,
    [node, alias, NET, userId, snapshot ? JSON.stringify(snapshot) : null]);
  db.run(`INSERT INTO sessions (resume_id, alias, node_id, status, network_id, agent, updated_at, last_seen_at, registered_at)
          VALUES (?1, ?2, ?3, 'idle', ?4, 'claude-code', datetime('now'), datetime('now'), datetime('now'))`, [`r_${node}`, alias, node, NET]);
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`nsc_owner_${Date.now()}`, "NodeSecretsCapablePassw0rd!");
  userToken = a.token!; userId = a.user!.user_id; NET = a.network_id!;
  seed("node_nsc_yes", "nsc-yes", { node_secrets_capable: true });
  seed("node_nsc_no", "nsc-no", { model: "x" });
  seed("node_nsc_bad", "nsc-bad", null);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);
afterAll(() => { try { hub?.stop?.(true); } catch {} try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

test("full /api/status carries node_secrets_capable only for nodes that reported it", async () => {
  const res = await fetch(`${BASE}/api/status?network_id=${NET}&full=1`, { headers: { Authorization: `Bearer ${userToken}` } });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  const byAlias = new Map((body.sessions ?? body).map((s: any) => [s.alias, s]));
  expect((byAlias.get("nsc-yes") as any)?.node_secrets_capable).toBe(true);
  expect("node_secrets_capable" in (byAlias.get("nsc-no") as any)).toBe(false);
  expect("node_secrets_capable" in (byAlias.get("nsc-bad") as any)).toBe(false);
});
