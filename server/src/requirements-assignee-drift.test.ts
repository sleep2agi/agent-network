// 2026-10-31 —— #3270：`assignee` 是派生展示字段，但它有自己的旧写入路径，会停在旧值。
//
// 实测（ANet 项目 archived=0，1105 张）：25 张与 owner/agent_owner 不一致，
// 其中 22 张「有 assignee 但既无 owner 也无 agent_owner」。
// 读的人看的是 assignee ⇒「有人负责」这句话可以比事实晚很久。
//
// 修法（读侧，引用优先）：
//   agent_owner（node alias） > owner（username） > 自由文本 assignee
// 判据：owner/agent_owner 是**写入时被校验过的引用**；assignee 是自由文本。
// 两者冲突时以引用为准；没有引用时保留自由文本（它可能是系统外的人，删掉等于丢信息）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-assignee-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
for (const k of ["COMMHUB_DUE_REMINDER_TZ", "COMMHUB_DUE_OVERDUE_MAX_DAYS", "COMMHUB_DUE_REMINDER_NETWORKS", "COMMHUB_DUE_REMINDERS", "COMMHUB_DUE_REMINDERS_NETWORKS", "COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS", "COMMHUB_DUE_REMINDERS_OWNERS"]) delete process.env[k];

const PW = "AssigneePassw0rd!x";
let BASE = "";
let hub: any = null;
let NET = "";
let TOKEN = "";
let USER_ID = "";
let db: any;

async function send(method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

beforeAll(async () => {
  db = (await import("./db.js")).db;
  const { register } = await import("./auth.js");
  const stamp = Date.now();
  const reg = register(`asg_${stamp}`, PW);
  expect(reg.ok).toBe(true);
  TOKEN = reg.token!;
  NET = reg.network_id!;
  USER_ID = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `asg_${stamp}`)!.user_id;
  // 一个可解析的 node（agent_owner 必须是本网络 node）
  db.run(`INSERT OR REPLACE INTO nodes (node_id, node_name, network_id, alias, created_at, updated_at)
          VALUES ('n_asg_probe', 'asg-probe', ?1, 'asg-probe', ?2, ?2)`, [NET, Date.now()]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop?.(); } catch {} rmSync(DIR, { recursive: true, force: true }); });

describe("assignee never contradicts a validated owner/agent_owner reference", () => {
  test("陈旧自由文本被引用覆盖（agent_owner 优先 > owner > 文本）", async () => {
    const { displayAssignee } = await import("./requirements.js").catch(() => ({ displayAssignee: null as any })) as any;
    if (typeof displayAssignee !== "function") {
      // 函数未导出时的退路：直接验证读取路径（下面两条 HTTP 用例已经覆盖），
      // 这里不静默通过 —— 明确记录「没有读数」的边界。
      throw new Error("displayAssignee 未导出：本文件需要它导出才能做单元级断言（见 #3270）");
    }
    const row = {
      assignee: "ANet基建",
      owner_json: JSON.stringify({ kind: "user", username: "王工" }),
      agent_owner_json: JSON.stringify({ kind: "node", id: "n_x", alias: "通信欧" }),
    };
    expect(displayAssignee(row)).toBe("通信欧");
    expect(displayAssignee({ ...row, agent_owner_json: null })).toBe("王工");
    // 没有引用时保留自由文本（系统外的人，删掉等于丢信息）
    expect(displayAssignee({ assignee: " 王工 ", owner_json: null, agent_owner_json: null })).toBe("王工");
    // 全是空 ⇒ 空串，不是 "undefined"/"null"
    expect(displayAssignee({ assignee: null, owner_json: null, agent_owner_json: null })).toBe("");
  });

  test("写侧对账：设 agent_owner 时旧 assignee 被回填为引用（不再累积分叉）", async () => {
    const created = await send("POST", `/api/requirements?network_id=${NET}`, {
      name: "assignee 写侧对账",
      column: "pool",
      assignee: "ANet基建",           // 旧值（看起来有人、其实解析不到）
    });
    expect(created.status).toBe(201);
    const id = created.body.requirement.id as string;
    expect(created.body.requirement.assignee).toBe("ANet基建");

    // 只改 agent_owner，不显式给 assignee ⇒ 回填为 node alias
    const patched = await send("PATCH", `/api/requirements/${id}?network_id=${NET}`, {
      agent_owner: { kind: "node", alias: "asg-probe" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.requirement.assignee).toBe("asg-probe");

    // 显式给 assignee 且**没有引用** ⇒ 自由文本就是唯一事实（系统外的人，例如「王工」）
    const other = await send("POST", `/api/requirements?network_id=${NET}`, { name: "无引用的卡", column: "pool" });
    expect(other.status).toBe(201);
    const manual = await send("PATCH", `/api/requirements/${other.body.requirement.id}?network_id=${NET}`, { assignee: "王工" });
    expect(manual.status).toBe(200);
    expect(manual.body.requirement.assignee).toBe("王工");

    // 两者**同时存在**时读侧以引用为准（这是有意的取舍：引用写入时被校验过，自由文本没有）。
    // 记录在这里，免得下一个人把它当成 bug 再改回去。
    const both = await send("PATCH", `/api/requirements/${id}?network_id=${NET}`, { assignee: "王工" });
    expect(both.status).toBe(200);
    expect(both.body.requirement.assignee).toBe("asg-probe");
  });
});
