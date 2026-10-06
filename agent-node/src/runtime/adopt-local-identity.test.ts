import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAdoptionLocalIdentity, verifyAdoptionProcess } from "./adopt-local-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adopt-local-test-")); roots.push(root);
  const home = join(root, "home");
  const workdir = join(home, "project");
  const nodeDir = join(workdir, ".anet/nodes/local-id");
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  const req = { node_id: "n_fixture", alias: "演示节点", network_id: "net_fixture", workdir };
  const configPath = join(nodeDir, "config.json");
  const cfg = { node_id: req.node_id, alias: req.alias, hub: "http://127.0.0.1:9999", network_id: req.network_id };
  const save = (extra = {}) => writeFileSync(configPath, JSON.stringify({ ...cfg, ...extra }), { mode: 0o600 });
  save();
  const opts = { home, hubUrl: cfg.hub, networkId: req.network_id, adoptRoots: [home], uid: process.getuid!(), daemonEnv: {} };
  return { root, home, req, opts, nodeDir, configPath, save };
}
test("default empty adopt_roots refuses", () => {
  const f = fixture();
  expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, adoptRoots: [] })).toThrow("adopt_roots_not_configured");
});
test("exact CJK alias and n_ identity accepted without modifying config", () => {
  const f = fixture();
  expect(verifyAdoptionLocalIdentity(f.req, f.opts).configPath).toBe(f.configPath);
});
test("allowlist escape and marker-carrying daemon refuse", () => {
  const f = fixture();
  expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, adoptRoots: [f.nodeDir] })).toThrow("adopt_workdir_outside_roots");
  expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, daemonEnv: { ANET_NODE_MARKER: "" } })).toThrow("daemon_has_node_marker");
});
test("symlink and group writable config refuse", () => {
  const f = fixture(); chmodSync(f.configPath, 0o660);
  expect(() => verifyAdoptionLocalIdentity(f.req, f.opts)).toThrow("adopt_path_writable_by_others");
  rmSync(f.configPath); symlinkSync(join(f.root, "untrusted"), f.configPath);
  expect(() => verifyAdoptionLocalIdentity(f.req, f.opts)).toThrow("adopt_identity_not_found");
});
test("wrong alias/network/hub and co-presence refuse", () => {
  const f = fixture();
  for (const [extra, error] of [
    [{ alias: "other" }, "adopt_alias_mismatch"],
    [{ network_id: "net_other" }, "adopt_config_network_mismatch"],
    [{ hub: "http://127.0.0.1:9998" }, "adopt_hub_mismatch"],
    [{ codexCopresence: true }, "copresence_adopt_v2"],
    [{ opencodeMode: "copresence" }, "copresence_adopt_v2"],
  ] as const) { f.save(extra); expect(() => verifyAdoptionLocalIdentity(f.req, f.opts)).toThrow(error); }
});
test("process exact config/alias/home and reproducible environment", () => {
  const f = fixture(); const identity = verifyAdoptionLocalIdentity(f.req, f.opts);
  const env = { HOME: f.home, PATH: "/bin", API_KEY: "fixture-only-value" };
  const evidence = { uid: f.opts.uid, cwd: f.req.workdir, argv: ["/usr/bin/agent-node", "--alias", f.req.alias, "--config", f.configPath], env };
  const opts = { uid: f.opts.uid, home: f.home, defaultTmuxSocket: "/tmp/tmux-fixture/default", reproducibleEnv: env };
  expect(verifyAdoptionProcess(identity, evidence, opts)).toBe("bare");
  expect(verifyAdoptionProcess(identity, { ...evidence, env: { ...env, TMUX: `${opts.defaultTmuxSocket},12,0` } }, opts)).toBe("tmux");
  expect(() => verifyAdoptionProcess(identity, { ...evidence, argv: ["node", "unrelated.js", ...evidence.argv.slice(1)] }, opts)).toThrow("adopt_process_argv_mismatch");
  expect(() => verifyAdoptionProcess(identity, { ...evidence, env: { ...env, HOME: "/other" } }, opts)).toThrow("adopt_process_home_mismatch");
  expect(() => verifyAdoptionProcess(identity, { ...evidence, env: { ...env, TMUX: "/other/socket,12,0" } }, opts)).toThrow("adopt_tmux_socket_mismatch");
  expect(() => verifyAdoptionProcess(identity, evidence, { ...opts, reproducibleEnv: { HOME: env.HOME, PATH: env.PATH } })).toThrow("adopt_env_not_reproducible:API_KEY");
});
