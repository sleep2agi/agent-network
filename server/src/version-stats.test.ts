// #2720 —— 版本债务聚合：无版本要按 agent 拆，别把「没有版本概念」算成债务。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { versionStats } from "./version-stats.js";

let networkId = "";

function insertSession(alias: string, agent: string, version: string | null, status: string) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, agent, version, status, network_id, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-10-01 00:00:00')`,
    [`res_${alias}`, alias, agent, version, status, networkId],
  );
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`verstats_${Date.now()}`, "VerStats-Str0ng-1!", undefined, "watcher");
  expect(auth.ok).toBe(true);
  networkId = auth.network_id!;

  insertSession("n-new", "agent-node:opencode", "2.3.0-preview.199", "idle");
  insertSession("n-old", "agent-node:opencode", "2.3.0-preview.150", "idle");
  insertSession("n-old-2", "agent-node:opencode", "2.3.0-preview.150", "working");
  insertSession("n-gone", "agent-node:opencode", "2.3.0-preview.150", "offline");
  // LLM 自己调工具的会话：没有版本是 n/a，不是债务
  insertSession("cc-1", "claude-code", null, "idle");
  insertSession("cc-2", "claude-code", null, "offline");
  // 老 agent-node：该报没报，是真债务
  insertSession("old-node-1", "agent-node:claude", null, "idle");
}, 30_000);

afterAll(() => {});

describe("versionStats (#2720)", () => {
  test("counts sessions and active sessions for the network", () => {
    const s = versionStats(networkId);
    expect(s.sessions).toBeGreaterThanOrEqual(7);
    expect(s.active).toBeGreaterThanOrEqual(5);
  });

  test("keeps 'no version' split by agent, with version_expected flag", () => {
    const s = versionStats(networkId);
    const cc = s.no_version_by_agent.find((x) => x.agent === "claude-code");
    const oldNode = s.no_version_by_agent.find((x) => x.agent === "agent-node:claude");
    expect(cc?.version_expected).toBe(false); // LLM 工具调用：n/a
    expect(oldNode?.version_expected).toBe(true); // 老节点：真债务
  });

  test("active_missing_version excludes producers with no version concept", () => {
    const s = versionStats(networkId);
    // 只有 old-node-1 计入（cc-1 是 n/a）
    expect(s.active_missing_version).toBe(1);
  });

  test("active_behind_same_agent counts actives on a non-top version", () => {
    const s = versionStats(networkId);
    // .150 有 2 个在线（idle+working），.199 是最高的一个
    expect(s.active_behind_same_agent).toBeGreaterThanOrEqual(2);
  });

  test("scoping by an unknown network yields nothing", () => {
    const s = versionStats("net_does_not_exist");
    expect(s.sessions).toBe(0);
  });
});
