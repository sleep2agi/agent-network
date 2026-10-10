import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachAdoptionCandidates,
  discoverAdoptionCandidates,
  heartbeatAdoptionCandidates,
  resetAdoptionCandidateCacheForTests,
  type DiscoverAdoptionOptions,
} from "./adopt-candidates.js";
import { verifyAdoptionLocalIdentity } from "./adopt-local-identity.js";

const roots: string[] = [];
afterEach(() => {
  resetAdoptionCandidateCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(name = "demo") {
  const root = mkdtempSync(join(tmpdir(), "adopt-candidates-"));
  roots.push(root);
  const home = join(root, "home");
  const workdir = join(home, "team", "project");
  const daemonDir = join(home, "daemon");
  const nodeDir = join(workdir, ".anet/nodes", name);
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
  const configPath = join(nodeDir, "config.json");
  const base = {
    node_id: "n_fixture", alias: name, node_name: name, hub: "http://127.0.0.1:9999",
    network_id: "net_fixture", runtime: "claude-agent-sdk", token: "ntok_supersecret",
    env: { API_KEY: "sekrit-value" },
  };
  const save = (extra: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify({ ...base, ...extra }), { mode: 0o600 });
  save();
  const opts: DiscoverAdoptionOptions = {
    workDir: daemonDir, home, hubUrl: base.hub, networkId: base.network_id, uid: process.getuid!() ?? -1,
    daemonEnv: {}, adoptRoots: [home], role: "host_supervisor", platform: "linux",
    readEnviron: () => { throw new Error("environ should not be read"); },
  };
  return { root, home, workdir, daemonDir, nodeDir, configPath, base, save, opts };
}

test("empty roots and non-linux publish nothing", () => {
  const f = layout();
  expect(discoverAdoptionCandidates({ ...f.opts, adoptRoots: [] })).toBeUndefined();
  expect(discoverAdoptionCandidates({ ...f.opts, platform: "darwin" })).toBeUndefined();
  expect(discoverAdoptionCandidates({ ...f.opts, role: "member" })).toBeUndefined();
  expect(discoverAdoptionCandidates({ ...f.opts, daemonEnv: { ANET_NODE_MARKER: "" } })).toBeUndefined();
});

test("v1 hand-started node is reported without token, env, or writes", () => {
  const f = layout("演示节点");
  f.save({ alias: "演示节点", node_name: "演示节点" });
  const before = readFileSync(f.configPath, "utf8");
  expect(before).toContain("ntok_supersecret");
  const found = discoverAdoptionCandidates(f.opts);
  expect(found).toEqual([{
    node_id: "n_fixture", alias: "演示节点", workdir: f.workdir, runtime: "claude-agent-sdk", launch_hint: "stopped",
  }]);
  expect(JSON.stringify(found)).not.toContain("ntok_supersecret");
  expect(JSON.stringify(found)).not.toContain("sekrit-value");
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  const snap = attachAdoptionCandidates({ role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }, found);
  expect(snap.daemon_capabilities).toMatchObject({ adopt_capable: true, adoption_candidates: found });
  expect(attachAdoptionCandidates(snap, undefined)).toBe(snap);
});

test("co-presence is 收编 v2 and is not a candidate", () => {
  const f = layout();
  f.save({ codexCopresence: true, runtime: "codex-app-server" });
  const req = { node_id: f.base.node_id, alias: f.base.alias, network_id: f.base.network_id, workdir: f.workdir };
  const identityOpts = { home: f.home, hubUrl: f.base.hub, networkId: f.base.network_id, adoptRoots: [f.home], uid: f.opts.uid, daemonEnv: {} };
  expect(verifyAdoptionLocalIdentity(req, { ...identityOpts, allowCodexV2: true }).nodeId).toBe(req.node_id);
  expect(discoverAdoptionCandidates(f.opts)).toEqual([]);
  for (const extra of [{ opencodeMode: "copresence" }, { grokCopresence: true }, { codexCopresence: true }]) {
    f.save(extra);
    expect(discoverAdoptionCandidates(f.opts)).toEqual([]);
  }
});

test("symlink escape, outside root, claimed registry, and unsafe registry", () => {
  const f = layout();
  const outside = join(f.root, "outside");
  const outsideNode = join(outside, ".anet/nodes/other");
  mkdirSync(outsideNode, { recursive: true, mode: 0o700 });
  writeFileSync(join(outsideNode, "config.json"), JSON.stringify({ ...f.base, node_id: "n_outside", alias: "outside" }), { mode: 0o600 });
  symlinkSync(outside, join(f.home, "linked"));
  expect(discoverAdoptionCandidates(f.opts)?.map((c) => c.node_id)).toEqual(["n_fixture"]);

  const sibling = join(f.root, "sibling-project");
  mkdirSync(join(sibling, ".anet/nodes/sib"), { recursive: true, mode: 0o700 });
  writeFileSync(join(sibling, ".anet/nodes/sib/config.json"), JSON.stringify({ ...f.base, node_id: "n_sib", alias: "sib" }), { mode: 0o600 });
  expect(discoverAdoptionCandidates({ ...f.opts, adoptRoots: [f.workdir] })?.map((c) => c.node_id)).toEqual(["n_fixture"]);

  const registry = join(f.daemonDir, ".anet");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  writeFileSync(join(registry, "child-workdirs.json"), JSON.stringify({ [f.base.alias]: { adopted: true, node_id: "n_fixture", request_id: "adopt_x", workdir: f.workdir, nodeDir: f.nodeDir, launch_mode: "tmux" } }), { mode: 0o600 });
  expect(discoverAdoptionCandidates(f.opts)).toEqual([]);
  chmodSync(join(registry, "child-workdirs.json"), 0o666);
  expect(discoverAdoptionCandidates(f.opts)).toBeUndefined();
});

test("launch hint reads only an owned pid file and never returns environ", () => {
  const f = layout();
  const pid = join(f.nodeDir, ".pid");
  writeFileSync(pid, "4242\n", { mode: 0o600 });
  const calls: number[] = [];
  const readEnviron = (n: number) => { calls.push(n); return "HOME=/x\0TMUX=/tmp/tmux-1/default,1,0\0API_KEY=sekrit-value"; };
  expect(discoverAdoptionCandidates({ ...f.opts, readEnviron })?.[0].launch_hint).toBe("tmux");
  expect(calls).toEqual([4242]);
  expect(JSON.stringify(discoverAdoptionCandidates({ ...f.opts, readEnviron }))).not.toContain("sekrit-value");
  expect(discoverAdoptionCandidates({ ...f.opts, readEnviron: () => "PATH=/bin" })?.[0].launch_hint).toBe("bare");
  chmodSync(pid, 0o666);
  expect(discoverAdoptionCandidates({ ...f.opts, readEnviron: () => { throw new Error("no"); } })?.[0].launch_hint).toBe("unverified");
});

test("visit cap skips later directories; a larger cap still strips secrets", () => {
  const f = layout();
  rmSync(f.workdir, { recursive: true, force: true });
  const secret = "ntok_later_secret";
  const later = join(f.home, "bbb", ".anet/nodes/later");
  mkdirSync(join(f.home, "aaa"), { recursive: true, mode: 0o700 });
  mkdirSync(later, { recursive: true, mode: 0o700 });
  writeFileSync(join(later, "config.json"), JSON.stringify({ ...f.base, node_id: "n_later", alias: "later", node_name: "later", token: secret }), { mode: 0o600 });
  expect(discoverAdoptionCandidates({ ...f.opts, maxVisits: 2 })).toEqual([]);
  const found = discoverAdoptionCandidates({ ...f.opts, maxVisits: 20 });
  expect(found?.map((c) => c.node_id)).toEqual(["n_later"]);
  expect(JSON.stringify(found)).not.toContain(secret);
  expect(readFileSync(join(later, "config.json"), "utf8")).toContain(secret);
});

test("heartbeat cache survives a removed node until the ttl", () => {
  const f = layout();
  const prev = process.cwd();
  const prevHome = process.env.HOME;
  try {
    process.chdir(f.daemonDir);
    process.env.HOME = f.home;
    const file = { role: "host_supervisor", adopt_roots: [f.home] };
    expect(heartbeatAdoptionCandidates(file, f.base.hub, f.base.network_id, 1_000)?.length).toBe(1);
    rmSync(f.workdir, { recursive: true, force: true });
    expect(heartbeatAdoptionCandidates(file, f.base.hub, f.base.network_id, 2_000)?.length).toBe(1);
    expect(heartbeatAdoptionCandidates(file, f.base.hub, f.base.network_id, 61_000)).toEqual([]);
  } finally { process.chdir(prev); if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
});
