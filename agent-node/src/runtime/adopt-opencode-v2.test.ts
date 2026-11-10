import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAdoptionLocalIdentity } from "./adopt-local-identity.js";
import { readOpenCodeBridgePid, verifyOpenCodeBridge } from "./adopt-opencode-v2.js";

// Hand-started OpenCode V2 co-presence nodes (TMA客户端欧 et al.) were refused
// with copresence_adopt_v2, so no daemon could manage them and fork returned 409.
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "adopt-oc-v2-")); roots.push(root);
  const home = join(root, "home"); const workdir = join(root, "data", "project");
  const nodeDir = join(workdir, ".anet/nodes/TMA客户端欧");
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 });
  const req = { node_id: "n_oc", alias: "TMA客户端欧", network_id: "net_x", workdir };
  const configPath = join(nodeDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ node_id: req.node_id, alias: req.alias, node_name: req.alias, hub: "https://hub.example",
    network_id: req.network_id, runtime: "opencode-cli", opencodeMode: "copresence", opencodeGeneration: "v2", ...extra }), { mode: 0o600 });
  const opts = { home, hubUrl: "https://hub.example", networkId: req.network_id, adoptRoots: [join(root, "data")], uid: process.getuid!(), daemonEnv: {} };
  return { req, opts, nodeDir, configPath, workdir };
}

test("OpenCode V2 co-presence: refused by default, accepted only with allowOpenCodeV2", () => {
  const f = fixture();
  expect(() => verifyAdoptionLocalIdentity(f.req, f.opts)).toThrow("copresence_adopt_v2");
  expect(verifyAdoptionLocalIdentity(f.req, { ...f.opts, allowOpenCodeV2: true }).configPath).toBe(f.configPath);
});

test("allowOpenCodeV2 does not open V1, non-opencode-cli, Grok or Codex co-presence", () => {
  for (const extra of [{ opencodeGeneration: "v1" }, { runtime: "opencode-sdk" }, { grokCopresence: true }, { codexCopresence: true }]) {
    const f = fixture(extra);
    expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, allowOpenCodeV2: true })).toThrow("copresence_adopt_v2");
  }
});

test("hub, network and roots are still enforced for OpenCode V2", () => {
  const f = fixture();
  expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, allowOpenCodeV2: true, hubUrl: "http://other.example:9300" })).toThrow("adopt_hub_mismatch");
  expect(() => verifyAdoptionLocalIdentity(f.req, { ...f.opts, allowOpenCodeV2: true, adoptRoots: [f.opts.home] })).toThrow("adopt_workdir_outside_roots");
});

test("bridge pidfile: 0664 tolerated (read-only use), world-writable/symlink/missing refused", () => {
  const f = fixture(); const pidPath = join(f.nodeDir, ".pid");
  expect(() => readOpenCodeBridgePid(f.nodeDir, f.opts.uid)).toThrow("adopt_opencode_bridge_not_running");
  writeFileSync(pidPath, "4242\n"); chmodSync(pidPath, 0o664);
  expect(readOpenCodeBridgePid(f.nodeDir, f.opts.uid)).toBe(4242);
  chmodSync(pidPath, 0o666);
  expect(() => readOpenCodeBridgePid(f.nodeDir, f.opts.uid)).toThrow("adopt_pidfile_unsafe");
  rmSync(pidPath); symlinkSync("/etc/hostname", pidPath);
  expect(() => readOpenCodeBridgePid(f.nodeDir, f.opts.uid)).toThrow("adopt_pidfile_unsafe");
});

test("bridge process must be this node's agent-node with exactly its --config", () => {
  const f = fixture(); const id = verifyAdoptionLocalIdentity(f.req, { ...f.opts, allowOpenCodeV2: true });
  const ok = { pid: 4242, birth: "1", uid: f.opts.uid, cwd: f.workdir, env: { ANET_NODE_MARKER: "m" },
    argv: ["/usr/bin/node", "/x/agent-node/dist/cli.js", "--config", f.configPath, "--alias", f.req.alias] };
  expect(() => verifyOpenCodeBridge(id, ok, f.opts.uid)).not.toThrow(); // marker env is fine here
  expect(() => verifyOpenCodeBridge(id, null, f.opts.uid)).toThrow("adopt_opencode_bridge_not_running");
  expect(() => verifyOpenCodeBridge(id, { ...ok, uid: ok.uid + 1 }, f.opts.uid)).toThrow("adopt_process_identity_mismatch");
  expect(() => verifyOpenCodeBridge(id, { ...ok, cwd: "/tmp" }, f.opts.uid)).toThrow("adopt_process_identity_mismatch");
  expect(() => verifyOpenCodeBridge(id, { ...ok, argv: ["/usr/bin/node", "/x/agent-node/dist/cli.js", "--config", "/other/config.json"] }, f.opts.uid)).toThrow("adopt_process_argv_mismatch");
  expect(() => verifyOpenCodeBridge(id, { ...ok, argv: ["/usr/bin/python3", "--config", f.configPath] }, f.opts.uid)).toThrow("adopt_process_argv_mismatch");
});
