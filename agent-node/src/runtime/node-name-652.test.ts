// Board #652 — daemon side of "node names may be Chinese, directories stay ASCII".
//
//  - buildAnetArgsDaemon takes the shared Unicode rule (shared/node-name.ts) and still
//    refuses path / shell characters with a reason;
//  - a create doorbell for 「测试」 writes the child under `.anet/nodes/node-<hash>/`
//    (and the app's `~/<folder>` workdir) — no non-ASCII path component anywhere —
//    while the config keeps alias 「测试」;
//  - names the old rule accepted keep their old directory (= the name);
//  - start / stop / delete find the ASCII directory from the alias.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  _resetAnetBinAbsForTest,
  buildAnetArgsDaemon,
  handleCreateNodeDoorbell,
  serializeEnvLocalDaemon,
} from "./create-node-daemon.js";
import { verifyStoppedChildConfig } from "./start-daemon.js";
import { _resetChildrenMapForTest, handleStopDoorbell } from "./stop-daemon.js";
import { resolveChildDirName } from "./child-dir-name.js";
import { NODE_NAME_CASES, nodeFolderSlug } from "../shared/node-name.js";

const CN = "测试";
const CN_DIR = nodeFolderSlug(CN);   // node-<6 hex>

describe("#652 buildAnetArgsDaemon — shared Unicode name rule", () => {
  test("Chinese / upper-case / digit-first names are accepted", () => {
    for (const name of [CN, "研发助手A", "Demo", "1demo", "demo-node"]) {
      expect(buildAnetArgsDaemon({ name, runtime: "claude-agent-sdk" }).slice(0, 3)).toEqual(["node", "create", name]);
    }
  });
  test("every shared vector gets the same verdict as the hub", () => {
    for (const c of NODE_NAME_CASES) {
      // the daemon additionally insists on the hub's normalized (trimmed) form
      const name = c.input.trim();
      const run = () => buildAnetArgsDaemon({ name, runtime: "claude-agent-sdk" });
      if (c.ok) expect(run).not.toThrow();
      else expect(run).toThrow(/^node_name_invalid/);
    }
  });
  test("illegal characters are refused with a reason a human can read", () => {
    expect(() => buildAnetArgsDaemon({ name: "a/b", runtime: "claude-agent-sdk" })).toThrow(/node_name_invalid:forbidden_char:.*「\/」/);
    expect(() => buildAnetArgsDaemon({ name: "..", runtime: "claude-agent-sdk" })).toThrow(/node_name_invalid:forbidden_char/);
    expect(() => buildAnetArgsDaemon({ name: "-x", runtime: "claude-agent-sdk" })).toThrow(/node_name_invalid:leading_dash/);
    expect(() => buildAnetArgsDaemon({ name: "x".repeat(65), runtime: "claude-agent-sdk" })).toThrow(/node_name_invalid:too_long/);
  });
  test("a name the hub would have trimmed did not come through a current hub", () => {
    expect(() => buildAnetArgsDaemon({ name: ` ${CN}`, runtime: "claude-agent-sdk" })).toThrow(/node_name_invalid:not_normalized/);
  });
});

// ── create doorbell, end to end on a scratch HOME ──────────────────────────
let home = "";
let workDir = "";
let pinRoot = "";
const killPids: number[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "ANET_BIN_ABS", "ANET_DAEMON_ALLOW_ENV_BIN", "ANET_BIN_SHA256", "ANET_DAEMON_PATH_CONF", "ANET_DAEMON_STRICT_ROOT_BIN"];

beforeEach(() => {
  _resetChildrenMapForTest();
  home = realpathSync(mkdtempSync(join(tmpdir(), "t652-home-")));
  workDir = join(home, "daemon");
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  pinRoot = mkdtempSync(join(tmpdir(), "t652-pin-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = home;
  process.env.ANET_DAEMON_PATH_CONF = join(pinRoot, "missing-path.conf");
  process.env.ANET_DAEMON_ALLOW_ENV_BIN = "1";
  process.env.ANET_BIN_ABS = writeFakeAnet(pinRoot);
  delete process.env.ANET_BIN_SHA256;
  delete process.env.ANET_DAEMON_STRICT_ROOT_BIN;
  _resetAnetBinAbsForTest();
});

afterEach(() => {
  for (const pid of killPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  _resetAnetBinAbsForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(pinRoot, { recursive: true, force: true });
});

function writeFakeAnet(root: string): string {
  const pkg = join(root, "pkg");
  const binDir = join(pkg, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-network", bin: { anet: "bin/anet.cjs" } }));
  const abs = join(binDir, "anet.cjs");
  writeFileSync(abs, "#!/usr/bin/env node\n// anet bin shim for #652 tests\n");
  chmodSync(abs, 0o755);
  return realpathSync(abs);
}

interface Spawned { bin: string; args: string[]; cwd: string }

async function runCreate(spec: Record<string, unknown>, requestId: string) {
  const acks: Record<string, any>[] = [];
  const spawned: Spawned[] = [];
  await handleCreateNodeDoorbell({ request_id: requestId }, {
    callCommHub: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "get_create_request") {
        return { ok: true, request_id: requestId, node_spec: spec, child_token: "ntok_placeholder_652" };
      }
      if (tool === "ack_create_request") { acks.push(args); return { ok: true }; }
      throw new Error(`unexpected tool ${tool}`);
    },
    workDir,
    hubUrl: "http://127.0.0.1:9",
    log: () => {},
    warn: () => {},
    serializeEnvLocal: serializeEnvLocalDaemon,
    capabilityCheckMs: 100,
    spawnChild: (bin, args, opts) => {
      spawned.push({ bin, args, cwd: opts.cwd });
      const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      if (child.pid) killPids.push(child.pid);
      return child;
    },
  });
  return { acks, spawned };
}

/** Every path created under $HOME, relative to it. */
function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(relative(home, p));
      if (e.isDirectory()) rec(p);
    }
  };
  rec(root);
  return out;
}
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

describe("#652 create doorbell — Chinese name, ASCII directories", () => {
  test("「测试」 with the app's ~/<folder> workdir: the folder the wizard shows is the folder on disk, at both levels", async () => {
    // The app shows 「文件夹：ceshi」 for 测试 and sends workdir `<default_workdir_root>/ceshi`
    // (sleep2agi/agent-network-app create-node-workdir.ts). That folder must be what lands on disk.
    const shownFolder = "ceshi";
    const { acks, spawned } = await runCreate(
      { name: CN, runtime: "claude-agent-sdk", workdir: `~/${shownFolder}` }, "cr_t652cnwd");
    expect(acks.map(a => a.status)).toEqual(["started"]);
    const cfgPath = join(home, shownFolder, ".anet", "nodes", shownFolder, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.alias).toBe(CN);
    expect(cfg.node_name).toBe(CN);
    expect(readdirSync(join(home, shownFolder, ".anet", "nodes"))).toEqual([shownFolder]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(["node", "start", shownFolder]);
    expect(spawned[0]!.cwd).toBe(join(home, shownFolder));
    const created = walk(home);
    expect(created.length).toBeGreaterThan(0);
    expect(created.filter(p => !isAscii(p))).toEqual([]);
    expect(created.some(p => p.includes(CN_DIR))).toBe(false);   // no hidden second folder

    // …and delete finds it again by alias, via the daemon's workdir registry (map-miss path;
    // the fake child's pid is not ours to signal).
    _resetChildrenMapForTest();
    const delAcks: any[] = [];
    await handleStopDoorbell({ request_id: "sr_t652cnwd" }, {
      workDir,
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_t652cnwd", child_node_id: cfg.node_id, child_alias: CN, action: "delete", delete_config: true, grace_seconds: 1, force: false };
        }
        delAcks.push(args); return { ok: true };
      },
      signalProcess: () => {}, log: () => {}, warn: () => {},
    } as any);
    expect(delAcks.at(-1)!.status).toBe("stopped");
    expect(existsSync(cfgPath)).toBe(false);
  }, 15_000);

  test("full-path edit to a non-folder-shaped last segment falls back to node-<hash>", async () => {
    const { acks, spawned } = await runCreate(
      { name: CN, runtime: "claude-agent-sdk", workdir: "~/My_Proj" }, "cr_t652cnwd2");
    expect(acks.map(a => a.status)).toEqual(["started"]);
    expect(existsSync(join(home, "My_Proj", ".anet", "nodes", CN_DIR, "config.json"))).toBe(true);
    expect(spawned[0]!.args).toEqual(["node", "start", CN_DIR]);
  }, 15_000);

  test("folder already holding ANOTHER node → refused (workdir_has_other_node), nothing written", async () => {
    const other = join(home, "ceshi", ".anet", "nodes", "ceshi");
    mkdirSync(other, { recursive: true });
    const prior = JSON.stringify({ node_id: "node_prior", alias: "别的节点" });
    writeFileSync(join(other, "config.json"), prior, { mode: 0o600 });
    const { acks, spawned } = await runCreate(
      { name: CN, runtime: "claude-agent-sdk", workdir: "~/ceshi" }, "cr_t652cnwd3");
    expect(acks.map(a => a.status)).toEqual(["rejected"]);
    expect(String(acks[0]!.error)).toMatch(/workdir_has_other_node|node_dir_taken/);
    expect(spawned).toHaveLength(0);
    expect(readFileSync(join(other, "config.json"), "utf-8")).toBe(prior);
  });

  test("「测试」 without a workdir (daemon cwd): node dir is ASCII too", async () => {
    const { acks, spawned } = await runCreate({ name: CN, runtime: "claude-agent-sdk" }, "cr_t652cncwd");
    expect(acks.map(a => a.status)).toEqual(["started"]);
    expect(existsSync(join(workDir, ".anet", "nodes", CN_DIR, "config.json"))).toBe(true);
    expect(existsSync(join(workDir, ".anet", "nodes", CN))).toBe(false);
    expect(spawned[0]!.args).toEqual(["node", "start", CN_DIR]);
    expect(walk(home).filter(p => !isAscii(p))).toEqual([]);
  }, 15_000);

  test("legacy name keeps its old directory (= the name)", async () => {
    const { acks, spawned } = await runCreate({ name: "demo-node", runtime: "claude-agent-sdk" }, "cr_t652legacy");
    expect(acks.map(a => a.status)).toEqual(["started"]);
    expect(existsSync(join(workDir, ".anet", "nodes", "demo-node", "config.json"))).toBe(true);
    expect(spawned[0]!.args).toEqual(["node", "start", "demo-node"]);
  }, 15_000);

  test("derived directory already holding ANOTHER alias → rejected, nothing overwritten, no spawn", async () => {
    const dir = join(workDir, ".anet", "nodes", CN_DIR);
    mkdirSync(dir, { recursive: true });
    const prior = JSON.stringify({ node_id: "node_prior", alias: "别的节点", node_name: "别的节点" });
    writeFileSync(join(dir, "config.json"), prior, { mode: 0o600 });
    const { acks, spawned } = await runCreate({ name: CN, runtime: "claude-agent-sdk" }, "cr_t652taken");
    expect(acks.map(a => a.status)).toEqual(["rejected"]);
    expect(String(acks[0]!.error)).toContain("node_dir_taken");
    expect(spawned).toHaveLength(0);
    expect(readFileSync(join(dir, "config.json"), "utf-8")).toBe(prior);
  });

  test("illegal name is refused by the daemon before anything touches disk", async () => {
    const { acks, spawned } = await runCreate({ name: "a/b", runtime: "claude-agent-sdk" }, "cr_t652bad");
    expect(acks.map(a => a.status)).toEqual(["rejected"]);
    expect(String(acks[0]!.error)).toContain("node_name_invalid:forbidden_char");
    expect(spawned).toHaveLength(0);
    expect(existsSync(join(workDir, ".anet", "nodes"))).toBe(false);
  });
});

describe("#652 start / stop / delete find the ASCII directory from the alias", () => {
  function seed(dirName: string, alias: string, nodeId: string): string {
    const dir = join(workDir, ".anet", "nodes", dirName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ node_id: nodeId, alias, node_name: alias }), { mode: 0o600 });
    chmodSync(join(dir, "config.json"), 0o600);
    return dir;
  }

  test("resolveChildDirName never lands on a directory whose config names another alias", () => {
    const root = join(workDir, ".anet", "nodes");
    // <root>'s own folder is "daemon"; a node dir of that name belonging to someone else
    seed("daemon", "别的节点", "node_x");
    expect(resolveChildDirName(root, CN)).toBe(CN_DIR);
    seed("daemon", CN, "node_y");
    expect(resolveChildDirName(root, CN)).toBe("daemon");
  });

  test("resolveChildDirName: legacy alias dir first, else derived; invalid alias → null", () => {
    const root = join(workDir, ".anet", "nodes");
    seed("demo-node", "demo-node", "node_a");
    seed(CN_DIR, CN, "node_b");
    expect(resolveChildDirName(root, "demo-node")).toBe("demo-node");
    expect(resolveChildDirName(root, CN)).toBe(CN_DIR);
    expect(resolveChildDirName(root, "a/b")).toBeNull();
    expect(resolveChildDirName(root, "..")).toBeNull();
  });

  test("start: verifyStoppedChildConfig resolves 「测试」 to node-<hash>/config.json", () => {
    seed(CN_DIR, CN, "node_t652start");
    const root = join(workDir, ".anet", "nodes");
    expect(verifyStoppedChildConfig(root, "node_t652start", CN)).toBe(join(realpathSync(root), CN_DIR, "config.json"));
    expect(() => verifyStoppedChildConfig(root, "node_t652start", "a/b")).toThrow("child_alias_invalid");
  });

  test("stop without a map entry: a local record under node-<hash> counts as mine", async () => {
    seed(CN_DIR, CN, "node_t652stop");
    const acks: any[] = [];
    await handleStopDoorbell({ request_id: "sr_t652stop" }, {
      workDir,
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_t652stop", child_node_id: "node_t652stop", child_alias: CN, action: "stop", delete_config: false, grace_seconds: 1, force: false };
        }
        acks.push(args); return { ok: true };
      },
      signalProcess: () => {}, log: () => {}, warn: () => {},
    } as any);
    expect(acks.at(-1)!.status).toBe("stopped");
    expect(String(acks.at(-1)!.error ?? "")).not.toContain("not_my_child");
  });

  test("delete moves node-<hash> to the trash (ASCII backup name), config gone", async () => {
    const dir = seed(CN_DIR, CN, "node_t652del");
    const acks: any[] = [];
    await handleStopDoorbell({ request_id: "sr_t652del" }, {
      workDir,
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_t652del", child_node_id: "node_t652del", child_alias: CN, action: "delete", delete_config: true, grace_seconds: 1, force: false };
        }
        acks.push(args); return { ok: true };
      },
      signalProcess: () => {}, log: () => {}, warn: () => {},
    } as any);
    expect(acks.at(-1)!.status).toBe("stopped");
    expect(existsSync(dir)).toBe(false);
    const trash = join(workDir, ".anet", "deleted");
    const entries = readdirSync(trash);
    expect(entries.some(n => n.endsWith(`-${CN_DIR}`))).toBe(true);
    expect(entries.filter(n => !isAscii(n))).toEqual([]);
  });
});
