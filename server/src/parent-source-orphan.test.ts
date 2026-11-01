// #3348 —— 父被丢弃时，**来源必须一起丢弃**。
//
// ## 生产读数（修之前）
//
//     tasks 131684 行里 2 条：
//       meta = {"parent_source":"explicit"}，parent_task_id / in_reply_to / thread_id 全空
//       5bc82d72  2026-10-30 16:08:38 · d002b739  2026-10-31 02:23:09
//
// ## 为什么会出现
//
// `send_task` 里的顺序是：
//
//     ① `if (parentSource && parentTaskId) { meta.parent_source = parentSource }`   ← 拼 meta
//     ② 校验显式父是否存在；不存在 ⇒ `parentTaskId = null`                          ← 丢父
//     ③ INSERT（meta 用 ①，父用 ② 之后的值）
//
// ⇒ ② 与 ① 之间没有连线。`meta` 里保留了「有一个 explicit 父」这个陈述，
// 而那一行本身没有父。
//
// ## 为什么这条不变式的正向断言抓不到它
//
// `#669` 的不变式是「父有值 ⇒ 来源有值」。这一格是「来源有值 ⇒ 父有值」的反面，
// 两个方向各自都合理，合起来留了一个空格 —— 而空格里正好能站下一行坏数据。
// `scripts/report-parent-source-coverage.py` 现在把这一格单列成 `source, no parent` 并报数。
//
// ## 这里测什么
//
// 走**真 handler**（不是镜像映射）：派一条带不存在父的任务，断言
//   ① 任务照样建成（丢父是「不阻塞派发」的决定，不是错误）
//   ② parent_task_id 落库为 NULL
//   ③ meta_json 里**没有** parent_source —— 这一条是本次修的
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.COMMHUB_DB = join(mkdtempSync(join(tmpdir(), "anet-orphan-source-")), "commhub.db");

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { db } = await import("./db.js");
const { registerTools } = await import("./tools.js");

const NET = "net_orphan_src";
const USER = "u_orphan_src";
const PEER = "osp-peer";
const TARGET = "osp-target";

type Handler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup(): void {
  for (const table of ["task_events", "inbox", "tasks", "sessions", "nodes", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed(): void {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [USER, USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  for (const alias of [PEER, TARGET]) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, lifecycle_state)
       VALUES (?1, ?2, ?2, ?3, 'active')`,
      [`n_${alias}`, alias, NET],
    );
    db.run(
      `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at)
       VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`,
      [`r_${alias}`, alias, `n_${alias}`, NET],
    );
  }
}

function handlers(): Record<string, Handler> {
  const server = new McpServer({ name: "test-orphan-source", version: "0" }) as any;
  const out: Record<string, Handler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, ...args: any[]) => {
    const h = args.at(-1);
    if (typeof h === "function") out[name] = h;
    return original(name, ...args);
  };
  registerTools(server, undefined, NET, USER, PEER, false, null);
  return out;
}

async function call(handler: Handler, args: any): Promise<any> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

beforeEach(() => { cleanup(); seed(); });
afterAll(() => { cleanup(); });

describe("#3348 不存在的显式父：父与来源一起丢", () => {
  test("父不存在 ⇒ 任务照样建成，但 parent_task_id 为 NULL 且 meta 里没有 parent_source", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000"; // 不存在的父
    const r = await call(handlers().send_task, {
      alias: TARGET,
      task: "osp dispatch with a ghost parent",
      priority: "normal",
      from_session: PEER,
      network_id: NET,
      parent_task_id: ghost,
    });
    // 丢父是「不阻塞派发」的决定：这条**不能**变成错误，否则一个幻觉 id 会挡掉整条任务。
    expect(r.ok).toBe(true);

    const row = db.get<{ task_id: string; parent_task_id: string | null; meta_json: string | null }>(
      "SELECT task_id, parent_task_id, meta_json FROM tasks WHERE content = ?1",
      ["osp dispatch with a ghost parent"],
    );
    expect(row).toBeTruthy();
    expect(row!.parent_task_id).toBeNull();
    // 关键断言：来源不许单独留下。
    // 留着的后果是库里出现「有来源、没父」这一格 —— #669 的不变式两个方向都放过它，
    // 于是它既不被算作 explicit 也不被算作无父，只在有人专门数「source 无 parent」时才看得见。
    expect(String(row!.meta_json ?? "")).not.toContain("parent_source");
  });
});
