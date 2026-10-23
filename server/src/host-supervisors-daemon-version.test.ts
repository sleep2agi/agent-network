// #973 — /api/host-supervisors surfaces the daemon's self-reported runtime
// version (`agent_node_version`).
//
// Why it needs a session join: nodes already send `version` in report_status
// (agent-node/src/cli.ts writes AGENT_NODE_VERSION) and the Hub stores it on the
// session row, which is why /api/status can show it. `nodes` has no version
// column, so the daemon list reads the newest session row for the same
// (network_id, node_id).
//
// 🔴 Absent stays absent: a daemon that never reported a version must NOT get a
// default, an empty string or the Hub's own version — "unknown" and "old" are
// different facts, and inventing one would make the client show a stale daemon
// as up to date.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { register, login } from "./auth.js";
import { db } from "./db.js";

let BASE = "";
let server: any = null;
let userToken = "";
let userNetworkId = "";
let userId = "";

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const password = "DaemonVersionPw123Aa!";
  const seed = register(`dver_seed_${suffix}`, password, undefined, "seed");
  if (!seed.ok) throw new Error("seed failed");
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`dver_seed_${suffix}`]);
  const u = register(`dver_u_${suffix}`, password, undefined, "seed");
  if (!u.ok || !u.token) throw new Error("user register failed");
  userToken = u.token;
  userNetworkId = u.network_id ?? "";
  userId = login(`dver_u_${suffix}`, password).user!.user_id;

  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
});

function seedDaemon(alias: string): void {
  db.run(
    `INSERT OR REPLACE INTO nodes (
       node_id, node_name, alias, runtime, model, config_path,
       channels, server, hostname, network_id,
       config_revision, config_snapshot
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [`dver_n_${alias}`, alias, alias, "claude-agent-sdk", "claude-sonnet-4-5",
     "/tmp/cfg.json", "[]", "test-host", "test-host", userNetworkId,
     0, JSON.stringify({ role: "host_supervisor" })],
  );
  db.run(
    `INSERT OR REPLACE INTO api_tokens (
       token_id, token_hash, user_id, network_id, name, scope
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [`dver_t_${alias}`, `hash_${alias}`, userId, userNetworkId, `node:${alias}`, "network"],
  );
}

function seedSession(alias: string, version: string | null): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO sessions (
       node_id, alias, network_id, registered_at, updated_at,
       peer_reply_inbox_capable, rules_file_capable, skills_capable,
       files_capable, logs_capable, version
     ) VALUES (?1, ?2, ?3, ?4, ?4, 1, 1, 1, 1, 1, ?5)`,
    [`dver_n_${alias}`, alias, userNetworkId, now, version],
  );
}

function clearAll(): void {
  db.run("DELETE FROM sessions WHERE network_id = ?1", [userNetworkId]);
  db.run("DELETE FROM nodes WHERE network_id = ?1", [userNetworkId]);
  db.run("DELETE FROM api_tokens WHERE network_id = ?1 AND name LIKE 'node:%'", [userNetworkId]);
}

async function listDaemons(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/host-supervisors`, {
    headers: { "Authorization": `Bearer ${userToken}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error("list failed: " + JSON.stringify(body));
  return body.daemons;
}

const find = (rows: any[], alias: string) => rows.find((r) => r.alias === alias)!;

describe("#973 — daemon list carries the self-reported runtime version", () => {
  test("a daemon whose newest session reported a version exposes agent_node_version", async () => {
    clearAll();
    seedDaemon("versioned-a");
    seedSession("versioned-a", "2.5.0-preview.155");
    const d = find(await listDaemons(), "versioned-a");
    expect(d.agent_node_version).toBe("2.5.0-preview.155");
  });

  test("🔴 no session / no version → the field is ABSENT (never a default)", async () => {
    clearAll();
    seedDaemon("silent-a");
    const d = find(await listDaemons(), "silent-a");
    expect("agent_node_version" in d).toBe(false);
  });

  test("an older session's version does not win over the newest one", async () => {
    clearAll();
    seedDaemon("newest-a");
    const old = new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();
    // Same (network_id, node_id) with two rows: the newest updated_at must win.
    db.run(
      `INSERT OR REPLACE INTO sessions (
         node_id, alias, network_id, registered_at, updated_at,
         peer_reply_inbox_capable, rules_file_capable, skills_capable,
         files_capable, logs_capable, version
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, 1, 1, 1, ?6)`,
      ["dver_n_newest-a", "newest-a", userNetworkId, old, old, "2.5.0-preview.146"],
    );
    db.run(
      `INSERT OR REPLACE INTO sessions (
         node_id, alias, network_id, registered_at, updated_at,
         peer_reply_inbox_capable, rules_file_capable, skills_capable,
         files_capable, logs_capable, version
       ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, 1, 1, 1, ?6)`,
      ["dver_n_newest-a", "newest-a", userNetworkId, now, now, "2.5.0-preview.155"],
    );
    const d = find(await listDaemons(), "newest-a");
    expect(d.agent_node_version).toBe("2.5.0-preview.155");
  });
});
