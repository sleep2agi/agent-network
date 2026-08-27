import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _resetChildrenMapForTest, getChildrenSnapshot } from "./stop-daemon";
import { handleStartDoorbell, verifyStoppedChildConfig } from "./start-daemon";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "start-daemon-")); _resetChildrenMapForTest(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeConfig(alias = "child-a", nodeId = "node_child_a") {
  const dir = join(root, alias);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ node_id: nodeId, node_name: alias, alias }), { mode: 0o600 });
  return path;
}

describe("verifyStoppedChildConfig", () => {
  test("accepts exact node id + alias from private config", () => {
    expect(verifyStoppedChildConfig(root, "node_child_a", "child-a")).toBe(writeConfig());
  });
  test("rejects mismatched node id and alias", () => {
    writeConfig();
    expect(() => verifyStoppedChildConfig(root, "node_other", "child-a")).toThrow("node_id_mismatch");
    expect(() => verifyStoppedChildConfig(root, "node_child_a", "child-b")).toThrow();
  });
  test("rejects group-writable config", () => {
    const p = writeConfig(); chmodSync(p, 0o660);
    expect(() => verifyStoppedChildConfig(root, "node_child_a", "child-a")).toThrow("writable_by_group");
  });
});

describe("handleStartDoorbell", () => {
  test("recovers stopped child from disk after childrenMap was cleared", async () => {
    writeConfig();
    const calls: Array<{ tool: string; args: any }> = [];
    let spawnArgs: string[] = [];
    await handleStartDoorbell({ request_id: "str_1" }, {
      workDir: root, nodesRoot: root,
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_child_a", child_alias: "child-a" };
        return { ok: true };
      },
      anetBin: () => "/trusted/anet",
      spawnChild: ((bin: string, args: string[]) => {
        expect(bin).toBe("/trusted/anet"); spawnArgs = args;
        return { pid: 4242, unref() {} } as any;
      }) as any,
      signalProcess: () => {}, log: () => {}, warn: () => {},
    });
    expect(spawnArgs).toEqual(["node", "start", "child-a"]);
    expect(calls.at(-1)).toEqual({ tool: "ack_start_request", args: { request_id: "str_1", status: "started", child_pid: 4242 } });
    expect(getChildrenSnapshot()).toEqual([{ pid: 4242, started_at: expect.any(Number), child_node_id: "node_child_a", alias: "child-a" }]);
  });

  test("local identity mismatch fails before binary resolution or spawn", async () => {
    writeConfig("child-a", "node_wrong");
    const calls: string[] = []; let resolved = false;
    await handleStartDoorbell({ request_id: "str_bad" }, {
      workDir: root, nodesRoot: root,
      callCommHub: async (tool) => {
        calls.push(tool);
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_child_a", child_alias: "child-a" };
        return { ok: true };
      },
      anetBin: () => { resolved = true; return "/trusted/anet"; },
      log: () => {}, warn: () => {},
    });
    expect(resolved).toBe(false);
    expect(calls).toEqual(["get_start_request", "ack_start_request"]);
    expect(getChildrenSnapshot()).toEqual([]);
  });
});
