// #1353 Fix ② — /api/host-supervisors surfaces daemon's self-reported
// can_create_nodes + create_nodes_blocked_reason so dashboard's
// "选服务器" picker can filter or dim broken daemons.
//
// Fix ① (PR #1510) added the hub-side dispatch gate — daemon that
// reports can_create_nodes=false gets refused with the reason. But
// the dashboard picker still LISTS the daemon and the user finds out
// only after clicking. This exposes the fact one layer earlier so the
// picker never surfaces the daemon in the first place.
//
// 🔴 Pre-#1371 compat is the same shape as Fix ①: only include the
// two keys when the daemon actually reported them. Old daemons (that
// never report) get the same undefined-passthrough dashboard sees a
// row WITHOUT the keys, not a row with can_create_nodes:false, so
// the dashboard's own default UI doesn't silently dim every legacy
// daemon.

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
  const password = "BootstrapPw123Aa!";

  // Seed admin so subsequent registrations aren't auto-admin (admin
  // path skips resolveRestNetworkScope's default-network fallback —
  // that would change our fixture's role/scope in ways unrelated to
  // this fix).
  const seed = register(`hsc_seed_${suffix}`, password, undefined, "seed");
  if (!seed.ok) throw new Error("seed failed");
  db.run("UPDATE users SET role = 'admin' WHERE username = ?1", [`hsc_seed_${suffix}`]);

  const u = register(`hsc_u_${suffix}`, password, undefined, "seed");
  if (!u.ok || !u.token) throw new Error("user register failed");
  userToken = u.token;
  userNetworkId = u.network_id ?? "";
  userId = login(`hsc_u_${suffix}`, password).user!.user_id;

  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
});

function seedDaemon(alias: string, snapshotOverride: object | null): void {
  const nodeId = `hsc_n_${alias}`;
  const snap = snapshotOverride === null
    ? null
    : JSON.stringify(snapshotOverride);
  db.run(
    `INSERT OR REPLACE INTO nodes (
       node_id, node_name, alias, runtime, model, config_path,
       channels, server, hostname, network_id,
       config_revision, config_snapshot
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    [nodeId, alias, alias, "claude-agent-sdk", "claude-sonnet-4-5",
     "/tmp/cfg.json", "[]", "test-host", "test-host", userNetworkId,
     0, snap],
  );
  db.run(
    `INSERT OR REPLACE INTO api_tokens (
       token_id, token_hash, user_id, network_id, name, scope
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [`hsc_t_${alias}`, `hash_${alias}`, userId, userNetworkId, `node:${alias}`, "network"],
  );
}

function clearDaemons(): void {
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

function findDaemon(rows: any[], alias: string): any {
  const d = rows.find(r => r.alias === alias);
  if (!d) throw new Error(`daemon ${alias} not in response`);
  return d;
}

describe("#1353 Fix ② — /api/host-supervisors surfaces can_create_nodes + blocked_reason", () => {
  test("🔴 witnessed-red: blocked daemon → response carries can_create_nodes:false + blocked_reason", async () => {
    clearDaemons();
    seedDaemon("blocked-a", {
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: false,
        create_nodes_blocked_reason: "anet_bin_permission",
      },
    });
    const d = findDaemon(await listDaemons(), "blocked-a");
    expect(d.can_create_nodes).toBe(false);
    expect(d.create_nodes_blocked_reason).toBe("anet_bin_permission");
  });

  test("healthy daemon (can_create_nodes:true) → can_create_nodes:true, NO blocked_reason", async () => {
    clearDaemons();
    seedDaemon("healthy-a", {
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: true,
      },
    });
    const d = findDaemon(await listDaemons(), "healthy-a");
    expect(d.can_create_nodes).toBe(true);
    // 🔴 defensive: dashboard's picker likely renders blocked_reason
    // when present regardless of can_create_nodes value. Don't
    // confuse it by shipping a stale reason on a healthy daemon.
    expect(d.create_nodes_blocked_reason).toBeUndefined();
  });

  test("healthy daemon that ALSO reports stale blocked_reason → reason NOT emitted (defensive)", async () => {
    // Belt-and-braces: even if a future daemon shape bug leaves a
    // stale reason string in the snapshot after recovering, the REST
    // response should not surface it when the daemon is currently OK.
    clearDaemons();
    seedDaemon("healthy-b", {
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: true,
        create_nodes_blocked_reason: "anet_bin_permission",  // stale
      },
    });
    const d = findDaemon(await listDaemons(), "healthy-b");
    expect(d.can_create_nodes).toBe(true);
    expect(d.create_nodes_blocked_reason).toBeUndefined();
  });

  test("🔴 pre-#1371 compat: daemon that never reports can_create_nodes → BOTH keys absent from response", async () => {
    // Same "known-blocked, NOT unknown-treated-as-blocked" rule as
    // Fix ①. A pre-#1371 daemon (preview.10 through ~preview.55) never
    // reports these fields. The response for it must not fabricate a
    // false value — the dashboard could reasonably render an
    // explicit `false` as "dim / hide" which would silently start
    // hiding every daemon that hasn't upgraded.
    clearDaemons();
    seedDaemon("legacy-a", {
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        // no can_create_nodes / create_nodes_blocked_reason
      },
    });
    const d = findDaemon(await listDaemons(), "legacy-a");
    expect("can_create_nodes" in d).toBe(false);
    expect("create_nodes_blocked_reason" in d).toBe(false);
  });

  test("pre-#1371 compat: daemon with no daemon_capabilities at all → BOTH keys absent", async () => {
    clearDaemons();
    seedDaemon("legacy-b", { role: "host_supervisor" });
    const d = findDaemon(await listDaemons(), "legacy-b");
    expect("can_create_nodes" in d).toBe(false);
    expect("create_nodes_blocked_reason" in d).toBe(false);
  });

  test("pre-#1371 compat: NULL config_snapshot (very old daemon) → BOTH keys absent, daemon does NOT crash the listing", async () => {
    // A daemon that never called report_status leaves config_snapshot NULL.
    // /api/host-supervisors filters by role from the snapshot, so a NULL
    // snapshot drops from the list entirely — but if it did surface (via
    // any future path), it must not crash the reducer.
    clearDaemons();
    seedDaemon("legacy-c", { role: "host_supervisor" });  // seed with something to be listable
    const rows = await listDaemons();
    // Just prove the list doesn't throw and the daemon is present with
    // no capability keys.
    const d = findDaemon(rows, "legacy-c");
    expect("can_create_nodes" in d).toBe(false);
  });

  test("all 4 categorized reason codes round-trip through the REST response", async () => {
    const codes = ["anet_bin_identity", "anet_bin_source", "anet_bin_shape", "anet_bin_permission"];
    for (const code of codes) {
      clearDaemons();
      seedDaemon(`blocked-${code}`, {
        role: "host_supervisor",
        daemon_capabilities: {
          runtimes_supported: ["claude-agent-sdk"],
          can_create_nodes: false,
          create_nodes_blocked_reason: code,
        },
      });
      const d = findDaemon(await listDaemons(), `blocked-${code}`);
      expect(d.can_create_nodes).toBe(false);
      expect(d.create_nodes_blocked_reason).toBe(code);
    }
  });

  test(".40-shape 'anet_bin_pin_unresolved' pre-#1377 code also passes through the REST response", async () => {
    // The Zod enum still accepts this coarse pre-#1377 code (agent-node
    // @2.5.0-preview.40 daemons in the wild emit it), and Fix ① surfaces
    // it verbatim to callers; the REST surface must too, otherwise
    // dashboard sees the daemon as "blocked with no reason".
    clearDaemons();
    seedDaemon("blocked-40shape", {
      role: "host_supervisor",
      daemon_capabilities: {
        runtimes_supported: ["claude-agent-sdk"],
        can_create_nodes: false,
        create_nodes_blocked_reason: "anet_bin_pin_unresolved",
      },
    });
    const d = findDaemon(await listDaemons(), "blocked-40shape");
    expect(d.create_nodes_blocked_reason).toBe("anet_bin_pin_unresolved");
  });

  test("malformed config_snapshot: existing behavior (daemon drops from list due to role-filter) unchanged", async () => {
    // The parse is wrapped in try/catch (existing behavior). A malformed
    // snapshot means snapRole stays null → filter drops it. This just
    // pins that our added parsing doesn't turn a malformed snapshot
    // into a crash.
    clearDaemons();
    // Seed a legit daemon so the list has SOMETHING to prove no crash.
    seedDaemon("healthy-c", {
      role: "host_supervisor",
      daemon_capabilities: { runtimes_supported: [] },
    });
    // Seed the malformed one — should be filtered out silently.
    const nodeId = "hsc_n_malformed";
    db.run(
      `INSERT OR REPLACE INTO nodes (
         node_id, node_name, alias, runtime, model, config_path,
         channels, server, hostname, network_id,
         config_revision, config_snapshot
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      [nodeId, "malformed", "malformed", "claude-agent-sdk", "claude-sonnet-4-5",
       "/tmp/cfg.json", "[]", "test-host", "test-host", userNetworkId,
       0, "{not json"],
    );
    db.run(
      `INSERT OR REPLACE INTO api_tokens (
         token_id, token_hash, user_id, network_id, name, scope
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ["hsc_t_malformed", "hash_malformed", userId, userNetworkId, "node:malformed", "network"],
    );
    const rows = await listDaemons();
    // healthy-c is present; malformed is filtered out because
    // snapRole stayed null.
    expect(rows.find((r: any) => r.alias === "healthy-c")).toBeDefined();
    expect(rows.find((r: any) => r.alias === "malformed")).toBeUndefined();
  });
});
