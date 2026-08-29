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
    const path = writeConfig();
    expect(verifyStoppedChildConfig(root, "node_child_a", "child-a")).toBe(path);
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

  test("lost success ack replays existing pid without a second spawn", async () => {
    writeConfig(); let spawns = 0; let firstAck = true;
    const deps: any = {
      workDir: root, nodesRoot: root, anetBin: () => "/trusted/anet",
      spawnChild: () => { spawns++; return { pid: 8181, unref() {} }; },
      signalProcess: () => {}, log: () => {}, warn: () => {},
      // #1448 finding-6 — legit replay: 同一个 agent-node 进程还活着,cmdline 精确匹配。
      readProcCmdline: (pid: number) => pid === 8181 ? "node\0/x/cli.js\0--alias\0child-a\0" : null,
      callCommHub: async (tool: string) => {
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_child_a", child_alias: "child-a" };
        if (tool === "ack_start_request" && firstAck) { firstAck = false; throw new Error("network lost"); }
        return { ok: true };
      },
    };
    await handleStartDoorbell({ request_id: "str_replay" }, deps);
    await handleStartDoorbell({ request_id: "str_replay" }, deps);
    expect(spawns).toBe(1);
    expect(getChildrenSnapshot()[0].pid).toBe(8181);
  });

  // #1448 finding-6 — witnessed-red：recorded.pid 通过 kill-0,但 /proc/<pid>/cmdline
  // 不再是那个 agent-node(pid 被无关进程复用)。改前:直接 ack started + 用复用的 pid,
  // node 被标 active 而实际没跑(假 started)。改后:cmdline 复验失败 → 走真启动、ack 用
  // 新 pid、不冒充。
  test("PID reuse (cmdline no longer matches) → re-starts instead of false 'started' ack", async () => {
    writeConfig(); let spawns = 0; let firstAck = true; const acks: any[] = [];
    const deps: any = {
      workDir: root, nodesRoot: root, anetBin: () => "/trusted/anet",
      spawnChild: () => { spawns++; return { pid: spawns === 1 ? 8181 : 9999, unref() {} }; },
      signalProcess: () => {}, log: () => {}, warn: () => {},
      // pid 8181 现在是别的进程(如 sshd)——kill-0 过,但 cmdline 不含 --alias child-a。
      readProcCmdline: (_pid: number) => "/usr/sbin/sshd\0-D\0",
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_child_a", child_alias: "child-a" };
        if (tool === "ack_start_request") {
          if (firstAck) { firstAck = false; throw new Error("network lost"); }
          acks.push(args);
        }
        return { ok: true };
      },
    };
    await handleStartDoorbell({ request_id: "str_reuse" }, deps);   // spawn 8181, ack throws
    await handleStartDoorbell({ request_id: "str_reuse" }, deps);   // replay: cmdline mismatch → re-start
    expect(spawns).toBe(2);                                          // 真的重启了,没拿复用 pid 冒充
    expect(acks.at(-1)).toMatchObject({ status: "started", child_pid: 9999 });   // ack 用新 pid,不是复用的 8181
    expect(getChildrenSnapshot()[0].pid).toBe(9999);
  });
});
