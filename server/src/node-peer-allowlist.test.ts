// #2969 —— 节点级对端白名单。
//
// 需求（admin 2026-10-29）：「限制他能和哪些节点通信」。
// 现有能力只有「人这一层」的 agent_access=granted（授权一个 Agent = 它能找**所有**被授权对端），
// 做不到「只许 A 找 B，不许 A 找 C」。
//
// 这一列是**主人主动设的**，因此与 readonly / restricted 同类：设了就立刻生效、不看开关。
// NULL = 不限制 ⇒ 对现有 300+ 节点行为零变化。
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-peer-allow-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");

let mod: typeof import("./node-permissions.js");
beforeAll(async () => { mod = await import("./node-permissions.js"); });

const id = (peerAllowlist: string[] | null, mode: "normal" | "readonly" | "restricted" = "normal", toolAllowlist: string[] | null = null) => ({
  networkId: "net_test",
  nodeId: "n_self",
  logKey: "n_self",
  aliases: ["self-alias"],
  ownerUserId: "u_owner",
  mode,
  peerAllowlist,
  toolAllowlist,
});

describe("#2969 对端白名单", () => {
  test("null ⇒ 完全不受限（与今天的行为一致）", () => {
    expect(mod.dispatchVerdict(id(null), { alias: "anyone", nodeId: "n_any" })).toBeNull();
  });

  test("名单命中（按 alias）⇒ 放行", () => {
    expect(mod.dispatchVerdict(id(["alice"]), { alias: "alice", nodeId: "n_alice" })).toBeNull();
  });

  test("名单命中（按 node_id）⇒ 放行 —— 主人可能只写 id", () => {
    expect(mod.dispatchVerdict(id(["n_alice"]), { alias: "alice", nodeId: "n_alice" })).toBeNull();
  });

  test("不在名单上 ⇒ peer_not_allowed", () => {
    expect(mod.dispatchVerdict(id(["alice"]), { alias: "bob", nodeId: "n_bob" }))
      .toEqual({ reason: "peer_not_allowed", sample: "bob" });
  });

  test("发给自己的另一个 alias 仍然放行（白名单不该挡住自派）", () => {
    // dispatchVerdict 的第一条早退：目标是自己的 alias / node_id ⇒ null
    expect(mod.dispatchVerdict(id(["alice"]), { alias: "self-alias", nodeId: "n_self" })).toBeNull();
  });

  test("白名单是显式原因：开关为 off 也照拒（与 readonly 同类）", () => {
    const saved = process.env.COMMHUB_NODE_PERMISSIONS;
    process.env.COMMHUB_NODE_PERMISSIONS = "off";
    try {
      expect(mod.nodeDecide(id(["alice"]), "mcp:send_task", { reason: "peer_not_allowed" })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.COMMHUB_NODE_PERMISSIONS;
      else process.env.COMMHUB_NODE_PERMISSIONS = saved;
    }
  });

  test("设了白名单 ⇒ 不能广播（广播的收件人是任意对端）", () => {
    expect(mod.broadcastVerdict(id(["alice"]))).toEqual({ reason: "peer_not_allowed" });
    expect(mod.broadcastVerdict(id(null))).toBeNull();
  });

  test("正常模式下的人类专属写操作，开关为 off 时仍放行（对照，防止把一切都变显式）", () => {
    const saved = process.env.COMMHUB_NODE_PERMISSIONS;
    process.env.COMMHUB_NODE_PERMISSIONS = "off";
    try {
      expect(mod.nodeDecide(id(null), "mcp:projects_create", { reason: "human_only" })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.COMMHUB_NODE_PERMISSIONS;
      else process.env.COMMHUB_NODE_PERMISSIONS = saved;
    }
  });
});

// #2969 后半 —— 接口白名单。
describe("#2969 接口白名单", () => {
  test("null ⇒ 不限制（与今天一致）", () => {
    expect(mod.toolAllowlistVerdict(id(null, "normal", null), "send_task", false)).toBeNull();
  });

  test("名单内的工具 ⇒ 放行", () => {
    expect(mod.toolAllowlistVerdict(id(null, "normal", ["send_task"]), "send_task", false)).toBeNull();
  });

  test("名单外的工具 ⇒ tool_not_allowed", () => {
    expect(mod.toolAllowlistVerdict(id(null, "normal", ["send_task"]), "broadcast", false))
      .toEqual({ reason: "tool_not_allowed", sample: "broadcast" });
  });

  test("always 类永远放行 —— 否则节点连回报都做不了", () => {
    const listed = id(null, "normal", ["send_task"]);
    for (const t of ["get_inbox", "ack_inbox", "send_reply", "report_status"]) {
      expect(mod.toolAllowlistVerdict(listed, t, true)).toBeNull();
    }
  });

  test("它是显式原因：开关 off 也照拒", () => {
    const saved = process.env.COMMHUB_NODE_PERMISSIONS;
    process.env.COMMHUB_NODE_PERMISSIONS = "off";
    try {
      expect(mod.nodeDecide(id(null, "normal", ["send_task"]), "mcp:broadcast", { reason: "tool_not_allowed" })).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.COMMHUB_NODE_PERMISSIONS;
      else process.env.COMMHUB_NODE_PERMISSIONS = saved;
    }
  });
});
