import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleStopDoorbell, rebuildChildrenMapOnBoot, _resetChildrenMapForTest } from "./stop-daemon.js";

for (const action of ["stop", "delete"] as const) for (const ok of [true, false]) {
  test(`Windows ${action} delegates by local identity; CLI success=${ok}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "windows-stop-"));
    const nodes = join(root, ".anet", "nodes");
    const dir = join(nodes, "child");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ node_id: "node_child", runtime: "claude-agent-sdk" }));
    const acks: any[] = [], runs: string[][] = [];
    _resetChildrenMapForTest();
    try {
      await handleStopDoorbell({ request_id: "sr_test" }, {
        platform: "win32", workdirRoot: nodes, deletedRoot: join(root, "trash"),
        log() {}, warn() {},
        signalProcess() { throw Error("POSIX signal path reached"); },
        listMatchingChildPids() { throw Error("POSIX scan reached"); },
        stopCopresenceNode: async (alias, cwd) => { runs.push([alias, cwd]); return { ok, detail: "fixture" }; },
        callCommHub: async (tool, args) => {
          if (tool === "get_stop_request") return { ok: true, child_node_id: "node_child", child_alias: "child", action, delete_config: true };
          acks.push(args); return { ok: true };
        },
      });
      expect(runs).toEqual([["child", root]]);
      expect(acks[0].status).toBe(ok ? "stopped" : "stop_failed");
      expect(existsSync(dir)).toBe(!(ok && action === "delete"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Windows rejects a mismatched local node before invoking CLI stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "windows-stop-"));
  const dir = join(root, "child"); mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ node_id: "other", runtime: "claude-agent-sdk" }));
  const acks: any[] = [];
  try {
    await handleStopDoorbell({ request_id: "sr_test" }, {
      platform: "win32", workdirRoot: root, log() {}, warn() {},
      stopCopresenceNode: async () => { throw Error("must not run"); },
      callCommHub: async (tool, args) => {
        if (tool === "get_stop_request") return { ok: true, child_node_id: "node_child", child_alias: "child", action: "stop" };
        acks.push(args); return { ok: true };
      },
    });
    expect(acks[0].status).toBe("stop_failed");
    expect(acks[0].error).toContain("identity/runtime mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows boot recovery never invokes POSIX pgrep", async () => {
  const result = await rebuildChildrenMapOnBoot({
    platform: "win32", log() {}, warn() {},
    callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_child", alias: "child", lifecycle_state: "active" }] }),
    pgrepAlias: async () => { throw Error("POSIX scan reached"); },
  });
  expect(result.total_children_from_hub).toBe(1);
  expect(result.recovered).toBe(0);
});
