import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDaemonNodeAction, processMatchesProfile, scanLocalNodeInventory } from "./host-control-daemon.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const actionBase = { expectedNetworkId: "net-one", expectedHubUrl: "http://hub:9200" };

function fixture(alias = "child-one") {
  const root = mkdtempSync(join(tmpdir(), "host-control-")); roots.push(root);
  const dir = join(root, ".anet", "nodes", alias); mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({
    node_id: "node_child_one", node_name: alias, alias,
    runtime: "opencode-cli", model: "openai/gpt-5.5", network_id: "net-one",
    hub: "http://hub:9200", token: "ntok_must_not_cross_wire", env: { API_KEY: "secret" },
    flags: { maxTurns: 3 }, config_revision: 4,
  }, null, 2), { mode: 0o600 });
  return { root, dir, config, alias };
}

describe("RFC-031 host daemon scanner", () => {
  test("reports a stopped profile without token, env, prompt, or absolute path", () => {
    const f = fixture();
    const r = scanLocalNodeInventory({ workRoot: f.root, daemonAlias: "server-one", networkId: "net-one", hubUrl: "http://hub:9200" });
    expect(r.skipped).toHaveLength(0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ local_node_id: "node_child_one", alias: f.alias, observed_state: "stopped", config_relpath: "child-one/config.json", config_revision: 4 });
    expect(JSON.stringify(r.items[0])).not.toContain("ntok_");
    expect(JSON.stringify(r.items[0])).not.toContain("secret");
    expect(JSON.stringify(r.items[0])).not.toContain(f.root);
  });

  test("skips symlinked profile directories", () => {
    const f = fixture("real");
    symlinkSync(f.dir, join(f.root, ".anet", "nodes", "linked"));
    const r = scanLocalNodeInventory({ workRoot: f.root, daemonAlias: "server-one", networkId: "net-one", hubUrl: "http://hub:9200" });
    expect(r.items.map(v => v.alias)).toEqual(["real"]);
  });

  test("process identity requires exact alias and exact config argv", () => {
    const raw = "node\0/usr/bin/agent-node\0--config\0/work/.anet/nodes/a/config.json\0--alias\0a\0";
    const reader = (() => raw) as any;
    expect(processMatchesProfile(44, "a", "/work/.anet/nodes/a/config.json", reader)).toBe(true);
    expect(processMatchesProfile(44, "a", "/work/.anet/nodes/other/config.json", reader)).toBe(false);
    expect(processMatchesProfile(44, "a2", "/work/.anet/nodes/a/config.json", reader)).toBe(false);
  });
});

describe("RFC-031 daemon action", () => {
  test("offline update validates revision, writes mode-0600, backs up, and acks", async () => {
    const f = fixture();
    const calls: Array<{ tool: string; args: any }> = [];
    await handleDaemonNodeAction({ action_id: "ha_update" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_update", local_node_id: "node_child_one", alias: f.alias, action: "update", patch: { model: "openai/gpt-5.6", flags: {} }, base_revision: 4 } };
        return { ok: true };
      },
    });
    const cfg = JSON.parse(readFileSync(f.config, "utf8"));
    expect(cfg.model).toBe("openai/gpt-5.6");
    expect(cfg.config_revision).toBe(5);
    expect(readFileSync(`${f.config}.prev`, "utf8")).toContain("openai/gpt-5.5");
    expect(statSync(f.config).mode & 0o777).toBe(0o600);
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "succeeded", observed_state: "stopped", config_revision: 5 } });
  });

  test("revision mismatch leaves config byte-identical and rejects", async () => {
    const f = fixture();
    const before = readFileSync(f.config, "utf8");
    const calls: Array<{ tool: string; args: any }> = [];
    await handleDaemonNodeAction({ action_id: "ha_conflict" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_conflict", local_node_id: "node_child_one", alias: f.alias, action: "update", patch: { model: "bad" }, base_revision: 3 } };
        return { ok: true };
      },
    });
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "rejected" } });
  });

  test("action rechecks network and hub after inventory instead of trusting a stale snapshot", async () => {
    const f = fixture();
    const changed = JSON.parse(readFileSync(f.config, "utf8"));
    changed.network_id = "net-attacker";
    writeFileSync(f.config, JSON.stringify(changed), { mode: 0o600 });
    const before = readFileSync(f.config, "utf8");
    const calls: Array<{ tool: string; args: any }> = [];
    await handleDaemonNodeAction({ action_id: "ha_network_drift" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_network_drift", local_node_id: "node_child_one", alias: f.alias, action: "update", patch: { model: "must-not-write" }, base_revision: 4 } };
        return { ok: true };
      },
    });
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "rejected", error: "local_network_mismatch" } });
  });

  test("action refuses a symlinked alias even when its target identity is crafted to match", async () => {
    const f = fixture("target");
    const crafted = JSON.parse(readFileSync(f.config, "utf8"));
    crafted.alias = "linked";
    crafted.node_name = "linked";
    writeFileSync(f.config, JSON.stringify(crafted), { mode: 0o600 });
    symlinkSync(f.dir, join(f.root, ".anet", "nodes", "linked"));
    const before = readFileSync(f.config, "utf8");
    const calls: Array<{ tool: string; args: any }> = [];
    await handleDaemonNodeAction({ action_id: "ha_symlink" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_symlink", local_node_id: "node_child_one", alias: "linked", action: "update", patch: { model: "must-not-write" }, base_revision: 4 } };
        return { ok: true };
      },
    });
    expect(readFileSync(f.config, "utf8")).toBe(before);
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "rejected" } });
  });

  test("config inode replacement after verified open is rejected without overwriting the replacement", async () => {
    const f = fixture();
    const originalPath = `${f.config}.original`;
    const attackerBody = JSON.stringify({
      node_id: "node_attacker",
      alias: f.alias,
      runtime: "opencode-cli",
      network_id: "net-one",
      hub: "http://hub:9200",
      config_revision: 4,
    });
    const calls: Array<{ tool: string; args: any }> = [];
    let swapped = false;
    await handleDaemonNodeAction({ action_id: "ha_inode_swap" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      verifyRunning: () => {
        if (!swapped) {
          swapped = true;
          renameSync(f.config, originalPath);
          writeFileSync(f.config, attackerBody, { mode: 0o600 });
        }
        return undefined;
      },
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_inode_swap", local_node_id: "node_child_one", alias: f.alias, action: "update", patch: { model: "must-not-write" }, base_revision: 4 } };
        return { ok: true };
      },
    });
    expect(readFileSync(f.config, "utf8")).toBe(attackerBody);
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "rejected", error: "config_identity_changed" } });
  });

  test("start uses exact argv and never a shell string", async () => {
    const f = fixture();
    let spawned: { args: string[]; cwd: string } | null = null;
    const calls: Array<{ tool: string; args: any }> = [];
    await handleDaemonNodeAction({ action_id: "ha_start" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      spawnAnet: (args, cwd) => { spawned = { args, cwd }; return 4321; },
      verifyStarted: async () => 9876,
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_start", local_node_id: "node_child_one", alias: f.alias, action: "start" } };
        return { ok: true };
      },
    });
    expect(spawned).toEqual({ args: ["node", "start", "child-one"], cwd: f.root });
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "succeeded", observed_state: "running", verified_pid: 9876 } });
  });

  test("stop uses exact argv and only succeeds after the profile is no longer running", async () => {
    const f = fixture();
    const calls: Array<{ tool: string; args: any }> = [];
    let checks = 0;
    let executed: { args: string[]; cwd: string } | null = null;
    await handleDaemonNodeAction({ action_id: "ha_stop" }, {
      ...actionBase, workRoot: f.root, log: () => {}, warn: () => {},
      verifyRunning: () => (++checks === 1 ? 9876 : undefined),
      execAnet: (args, cwd) => { executed = { args, cwd }; },
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_daemon_node_action") return { request: { action_id: "ha_stop", local_node_id: "node_child_one", alias: f.alias, action: "stop" } };
        return { ok: true };
      },
    });
    expect(executed).toEqual({ args: ["node", "stop", "child-one"], cwd: f.root });
    expect(calls.at(-1)).toMatchObject({ tool: "ack_daemon_node_action", args: { status: "succeeded", observed_state: "stopped" } });
  });
});
