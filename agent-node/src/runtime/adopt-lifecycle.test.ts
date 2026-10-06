import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeAdoptedChild } from "./adopt-registry.js";
import { handleAdoptedLifecycle } from "./adopt-lifecycle.js";
import { privateSocket } from "./adopt-launch-evidence.js";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture(bound = true) {
  const home = mkdtempSync(join(tmpdir(), "adopt-lifecycle-")); roots.push(home);
  const workdir = join(home, "manual"), workDir = join(home, "daemon"), nodeDir = join(workdir, ".anet/nodes/fixture");
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 }); mkdirSync(workDir);
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: "n_fixture", alias: "fixture", network_id: "net_fixture", hub: "http://127.0.0.1:9999" }), { mode: 0o600 });
  writeAdoptedChild(workDir, "fixture", { adopted: true, request_id: "adopt_fixture", node_id: "n_fixture", workdir, nodeDir, launch_mode: "tmux" });
  const calls: any[] = [];
  const deps = { home, workDir, hubUrl: "http://127.0.0.1:9999", networkId: "net_fixture", adoptRoots: [home], uid: process.getuid!(), daemonEnv: {}, warn: () => {},
    callCommHub: async (name: string, args: any) => { calls.push({ name, args }); return name === "list_my_children" ? { ok: true, children: bound ? [{ managed: "adopted", child_node_id: "n_fixture", alias: "fixture" }] : [] } : { ok: true }; } };
  return { deps, calls };
}
test("local registry without active Hub binding cannot stop", async () => {
  const f = fixture(false);
  expect(await handleAdoptedLifecycle({ request_id: "stop_fixture", child_node_id: "n_fixture", child_alias: "fixture", action: "stop" }, f.deps)).toBe(true);
  expect(f.calls.at(-1).args).toEqual({ request_id: "stop_fixture", status: "stop_failed", error: "adopt_active_binding_required" });
});
test("inferred tmux launch_mode without live evidence cannot start", async () => {
  const f = fixture();
  await handleAdoptedLifecycle({ request_id: "start_fixture", child_node_id: "n_fixture", child_alias: "fixture", action: "start" }, f.deps);
  expect(f.calls.at(-1).args.error).toBe("adopt_start_evidence_missing");
});
test("default tmux socket is refused before any command", () => {
  expect(() => privateSocket(`/tmp/tmux-${process.getuid!()}/default`, process.getuid!())).toThrow("adopt_explicit_private_socket_required");
});
