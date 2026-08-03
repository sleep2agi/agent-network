import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import {
  createDaemonAction,
  listDaemonInventory,
  syncDaemonInventory,
  validateHostInventoryItem,
} from "./daemon-control.js";

const NET = "net_daemon_control_test";
const DAEMON = "node_daemon_control_test";
const ALIAS = "server-one";
const HASH = "a".repeat(64);

beforeEach(() => {
  db.run("DELETE FROM daemon_node_actions WHERE network_id=?1", [NET]);
  db.run("DELETE FROM daemon_node_inventory WHERE network_id=?1", [NET]);
  db.run("DELETE FROM nodes WHERE network_id=?1", [NET]);
  db.run(
    `INSERT INTO nodes (node_id,node_name,alias,runtime,network_id,config_snapshot,created_at,updated_at)
     VALUES (?1,?2,?2,'claude-agent-sdk',?3,?4,datetime('now'),datetime('now'))`,
    [DAEMON, ALIAS, NET, JSON.stringify({ role: "host_supervisor" })],
  );
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    local_node_id: "node_child_one",
    alias: "child-one",
    runtime: "opencode-cli",
    config_relpath: "child-one/config.json",
    observed_state: "stopped",
    config_hash: HASH,
    config_revision: 2,
    ...overrides,
  };
}

describe("RFC-031 daemon inventory", () => {
  test("accepts a local-only node without creating or changing /api/nodes inventory", () => {
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE network_id=?1", NET)!.n;
    const r = syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()], now: 100 });
    expect(r).toMatchObject({ accepted: 1, quarantined: 0 });
    expect(listDaemonInventory(NET, DAEMON)[0]).toMatchObject({ alias: "child-one", registry_state: "local_only" });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE network_id=?1", NET)!.n).toBe(before);
  });

  test("exact registered identity is manageable", () => {
    db.run(
      `INSERT INTO nodes (node_id,node_name,alias,runtime,network_id,created_at,updated_at)
      VALUES ('node_child_one','child-one','child-one','opencode-cli',?1,datetime('now'),datetime('now'))`, [NET],
    );
    syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] });
    expect(listDaemonInventory(NET, DAEMON)[0]).toMatchObject({ registry_state: "registered", conflict_code: null });
    expect(createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "start", createdByToken: "tok" }).action_id).toStartWith("ha_");
  });

  test("node_id/alias conflict is quarantined and cannot dispatch", () => {
    db.run(
      `INSERT INTO nodes (node_id,node_name,alias,runtime,network_id,created_at,updated_at)
      VALUES ('node_child_one','other','other','opencode-cli',?1,datetime('now'),datetime('now'))`, [NET],
    );
    const r = syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] });
    expect(r.quarantined).toBe(1);
    expect(() => createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "start", createdByToken: "tok" })).toThrow("managed_node_quarantined");
  });

  test("a second daemon cannot claim the same node", () => {
    const daemon2 = "node_daemon_control_two";
    db.run(
      `INSERT INTO nodes (node_id,node_name,alias,runtime,network_id,config_snapshot,created_at,updated_at)
       VALUES (?1,'server-two','server-two','claude-agent-sdk',?2,?3,datetime('now'),datetime('now'))`,
      [daemon2, NET, JSON.stringify({ role: "host_supervisor" })],
    );
    syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] });
    const r = syncDaemonInventory({ daemonNodeId: daemon2, daemonAlias: "server-two", networkId: NET, items: [item()] });
    expect(r.quarantined).toBe(1);
  });

  test("rejects traversal, secret-shaped extras are ignored by the stored contract", () => {
    expect(() => validateHostInventoryItem(item({ config_relpath: "../victim/config.json" }))).toThrow("config_relpath_invalid");
    const clean = validateHostInventoryItem(item({ token: "ntok_secret", env: { KEY: "secret" } }));
    expect(clean).not.toHaveProperty("token");
    expect(clean).not.toHaveProperty("env");
  });

  test("non-daemon token-bound node cannot sync", () => {
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: null }), DAEMON]);
    expect(() => syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] })).toThrow("caller_not_a_daemon");
  });

  test("one in-flight action per daemon child", () => {
    syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] });
    createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "start", createdByToken: "tok" });
    expect(() => createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "restart", createdByToken: "tok" })).toThrow();
  });

  test("stop is accepted only for a verified running node", () => {
    syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item({ observed_state: "running", verified_pid: 4321 })] });
    expect(createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "stop", createdByToken: "tok" }).action_id).toStartWith("ha_");
    db.run("UPDATE daemon_node_actions SET status='succeeded' WHERE network_id=?1", [NET]);
    syncDaemonInventory({ daemonNodeId: DAEMON, daemonAlias: ALIAS, networkId: NET, items: [item()] });
    expect(() => createDaemonAction({ networkId: NET, daemonNodeId: DAEMON, localNodeId: "node_child_one", action: "stop", createdByToken: "tok" })).toThrow("managed_node_not_running");
  });
});
