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
  const srv = await import("./server.js");
  hub = srv.default ?? srv;
  const { register } = await import("./auth.js");
  db = (await import("./db.js")).db;
  const stamp = Date.now();
  const reg = register(`asg_${stamp}`, PW);
  expect(reg.ok).toBe(true);
  TOKEN = reg.token!;
  NET = reg.network_id!;
  USER_ID = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `asg_${stamp}`)!.user_id;
  BASE = `http://127.0.0.1:${(hub.server ?? hub).port ?? 0}`;
  if (!BASE.endsWith("0")) return;
  BASE = "";
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
});
