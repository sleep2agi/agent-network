import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/late710-")}/hub.db`;

let db: any;
let hub: ReturnType<typeof Bun.serve>;
let base = "";
let owner: any;
let outsider: any;
let workerToken = "";
let siblingToken = "";
const workerId = "n_late710_worker";
const siblingId = "n_late710_sibling";
const taskId = "task_late710_terminal";
const threadId = "thread_late710_exact";
const turnId = "turn_late710_exact";

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const raw = await response.text();
  const events = raw.split("\n").filter((line) => line.startsWith("data:"));
  const envelope = JSON.parse(events.length ? events.at(-1)!.slice(5) : raw);
  expect(envelope.error).toBeUndefined();
  return JSON.parse(envelope.result.content[0].text);
}

async function get(token: string, path: string) {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as any };
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const { generateNetworkToken, hashToken } = await import("./db.js");
  owner = register("late710_owner", "Fixture-Strong1!");
  outsider = register("late710_outside", "Fixture-Strong1!");
  expect(owner.ok && outsider.ok).toBe(true);

  const addNode = (nodeId: string, alias: string) => {
    db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,lifecycle_state)
      VALUES(?1,?2,?2,?3,?4,'active')`, [nodeId, alias, owner.network_id, owner.user.user_id]);
    db.run(`INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at)
      VALUES(?1,?2,?1,?3,'idle',datetime('now'))`, [nodeId, alias, owner.network_id]);
    const raw = generateNetworkToken();
    db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id,node_identity_epoch)
      VALUES(?1,?2,?3,'network',?4,?5,?1,2)`, [nodeId, owner.user.user_id, owner.network_id, `node:${alias}`, hashToken(raw)]);
    return raw;
  };
  workerToken = addNode(workerId, "late710-worker");
  siblingToken = addNode(siblingId, "late710-sibling");
  db.run(`INSERT INTO tasks
    (task_id,from_name,to_name,to_node_id,status,content,result,network_id,thread_id,turn_id,completed_at)
    VALUES(?1,?2,'late710-worker',?3,'failed','original task','watchdog interrupted',?4,?5,?6,datetime('now'))`,
    [taskId, owner.user.username, workerId, owner.network_id, threadId, turnId]);

  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => hub?.stop(true));

test("exact executor and exact turn append one late receipt without rewriting terminal task", async () => {
  const before = db.get("SELECT status,result,completed_at FROM tasks WHERE task_id=?1", taskId);
  const accepted = await mcp(workerToken, "send_reply", {
    in_reply_to: taskId,
    text: "recovered final result",
    status: "replied",
    thread_id: threadId,
    turn_id: turnId,
  });
  expect(accepted).toMatchObject({ ok: true, late: true, duplicate: false });
  expect(db.get("SELECT status,result,completed_at FROM tasks WHERE task_id=?1", taskId)).toEqual(before);
  expect(db.get("SELECT COUNT(*) AS n FROM task_events WHERE task_id=?1", taskId).n).toBe(0);

  const detail = await get(owner.token, `/api/tasks/${taskId}`);
  expect(detail.status).toBe(200);
  expect(detail.body.task.late_replies).toEqual([expect.objectContaining({
    late: true, task_id: taskId, from_node_id: workerId,
    thread_id: threadId, turn_id: turnId, status: "replied", result: "recovered final result",
  })]);
  const legacyDetail = await get(owner.token, `/api/tasks?task_id=${taskId}&limit=1&network_id=${owner.network_id}`);
  expect(legacyDetail.body.tasks[0].late_replies).toEqual(detail.body.task.late_replies);
  const mcpDetail = await mcp(owner.token, "get_task", { task_id: taskId });
  // 2026-10-31 —— **条件键要显式登记**（#3171）：get_task 的 `pacing` 只在有 pacing 时出现，
  // 所以这里不能写「键集恒等于三键」（那也是外部复核说的「条件键」）。
  // 断言写成：两个必需键必在，且**除 pacing 外不许有别的键**。
  const ks = Object.keys(mcpDetail);
  expect(ks).toContain("ok");
  expect(ks).toContain("task");
  expect(ks.filter((k) => !["ok", "task", "pacing"].includes(k))).toEqual([]);
  expect(mcpDetail.task.late_replies).toEqual(detail.body.task.late_replies);

  const messages = await get(owner.token, `/api/messages?alias=${encodeURIComponent(owner.user.username)}&since=2000-01-01%2000:00:00`);
  expect(messages.body.messages).toContainEqual(expect.objectContaining({ id: accepted.message_id, late: true, content: "recovered final result" }));
  const inbox = await mcp(owner.token, "get_inbox", { alias: owner.user.username, limit: 100 });
  expect(inbox.messages).toContainEqual(expect.objectContaining({ id: accepted.message_id, late: true, content: "recovered final result" }));
});

test("exact retry is idempotent and a changed payload conflicts", async () => {
  const retry = await mcp(workerToken, "send_reply", {
    in_reply_to: taskId, text: "recovered final result", status: "replied", thread_id: threadId, turn_id: turnId,
  });
  expect(retry).toMatchObject({ ok: true, late: true, duplicate: true });
  expect(db.get("SELECT COUNT(*) AS n FROM task_late_replies WHERE task_id=?1", taskId).n).toBe(1);
  expect(db.get("SELECT COUNT(*) AS n FROM inbox WHERE in_reply_to=?1 AND content='recovered final result'", taskId).n).toBe(1);
  expect(await mcp(workerToken, "send_reply", {
    in_reply_to: taskId, text: "different result", status: "replied", thread_id: threadId, turn_id: turnId,
  })).toMatchObject({ ok: false, error: "late_reply_conflict" });
});

test("wrong executor, sibling turn, cross-network reader and legacy shape cannot append", async () => {
  const count = () => db.get("SELECT COUNT(*) AS n FROM task_late_replies").n;
  const before = count();
  expect(await mcp(siblingToken, "send_reply", {
    in_reply_to: taskId, text: "impostor", thread_id: threadId, turn_id: turnId,
  })).toMatchObject({ ok: false, error: "late_reply_task_not_owned" });
  expect(await mcp(workerToken, "send_reply", {
    in_reply_to: taskId, text: "wrong turn", thread_id: threadId, turn_id: "turn_late710_sibling",
  })).toMatchObject({ ok: false, error: "late_reply_context_mismatch" });
  expect(await mcp(workerToken, "send_reply", {
    in_reply_to: taskId, text: "legacy terminal reply",
  })).toMatchObject({ ok: false, error: "reply_task_terminal" });
  expect(await mcp(owner.token, "send_reply", {
    in_reply_to: taskId, text: "human cannot forge runtime evidence", thread_id: threadId, turn_id: turnId,
  })).toMatchObject({ ok: false, error: "late_reply_node_token_required" });
  // Length bound is enforced in the handler (kept out of tools/list for #476).
  for (const bad of ["", "x".repeat(201)]) {
    expect(await mcp(workerToken, "send_reply", {
      in_reply_to: taskId, text: "bad identity", thread_id: bad, turn_id: turnId,
    })).toMatchObject({ ok: false, error: "late_reply_context_invalid" });
  }
  expect(count()).toBe(before);
  expect((await get(outsider.token, `/api/tasks/${taskId}`)).status).toBe(404);
  expect((await mcp(outsider.token, "get_task", { task_id: taskId })).ok).toBe(false);
});

test("nonterminal legacy reply retains its established behavior", async () => {
  const openId = "task_late710_open";
  db.run(`INSERT INTO tasks(task_id,from_name,to_name,to_node_id,status,content,network_id)
    VALUES(?1,?2,'late710-worker',?3,'running','legacy open',?4)`, [openId, owner.user.username, workerId, owner.network_id]);
  const result = await mcp(workerToken, "send_reply", { in_reply_to: openId, text: "ordinary final" });
  expect(result).toMatchObject({ ok: true });
  expect(result.late).toBeUndefined();
  expect(db.get("SELECT status,result FROM tasks WHERE task_id=?1", openId)).toEqual({ status: "replied", result: "ordinary final" });
  expect(db.get("SELECT COUNT(*) AS n FROM task_late_replies WHERE task_id=?1", openId).n).toBe(0);
});

// #3061 —— 任务**从未记下 turn 上下文**时，迟到结果也必须能收。
//
// 现场（2026-10-30 生产实测）：
//   「仍在 TUI 会话里运行，等待回复已达 30 分钟上限」的失败任务 289 条，
//   其中 thread_id/turn_id 非空的 **0 条**；「任务未提交」781 条里只有 1 条有。
//   ⇒ 这类任务的迟到结果永远匹配不上上下文，等于「活干完了但结果必定丢弃」。
//   全库 task_late_replies 只有 4 行，正是这条路走不通的证据。
test("既有任务没有 turn 上下文时，迟到结果仍可落账并投递给发送方", async () => {
  const contextlessId = "task_late710_noctx";
  db.run(`INSERT INTO tasks
    (task_id,from_name,to_name,to_node_id,status,content,result,network_id,thread_id,turn_id,completed_at)
    VALUES(?1,?2,'late710-worker',?3,'failed','never started a turn','共享会话忙，30 分钟内未提交',?4,NULL,NULL,datetime('now'))`,
    [contextlessId, owner.user.username, workerId, owner.network_id]);

  const accepted = await mcp(workerToken, "send_reply", {
    in_reply_to: contextlessId,
    text: "结果其实跑完了",
    status: "replied",
    thread_id: "thread_from_runtime_any",
    turn_id: "turn_from_runtime_any",
  });
  expect(accepted).toMatchObject({ ok: true, late: true, duplicate: false });
  // 任务行不被改写
  expect(db.get("SELECT status,result FROM tasks WHERE task_id=?1", contextlessId))
    .toEqual({ status: "failed", result: "共享会话忙，30 分钟内未提交" });
  // 落进 append-only 账，并带上运行时给的上下文
  const row = db.get("SELECT thread_id,turn_id,status,result FROM task_late_replies WHERE task_id=?1", contextlessId);
  expect(row).toMatchObject({ thread_id: "thread_from_runtime_any", turn_id: "turn_from_runtime_any", status: "replied", result: "结果其实跑完了" });
  // 发送方能在 inbox 里看到它（否则「活干完了没人知道」）
  const inbox = await mcp(owner.token, "get_inbox", { alias: owner.user.username, limit: 100 });
  expect(inbox.messages).toContainEqual(expect.objectContaining({ id: accepted.message_id, late: true, content: "结果其实跑完了" }));
  // 不是这个任务的负责人，仍然拒（放宽只针对上下文，不放宽归属）
  expect(await mcp(siblingToken, "send_reply", {
    in_reply_to: contextlessId, text: "impostor", thread_id: "t", turn_id: "u",
  })).toMatchObject({ ok: false, error: "late_reply_task_not_owned" });
});

// #3061 续 —— 任务**从未记下 turn 上下文**时，不该再要求调用方凭空给出 thread/turn。
//
// 现场（2026-10-30 通信Dash欧）：它对一条 failed 任务调 send_reply 补结果，
// 拿到 `reply_task_terminal`（因为没带 thread_id/turn_id），只好先 retry_task 把任务
// 重置成 delivered 再回复 —— 账本里那条从 failed 变成 retried→replied，
// **「当初失败过」这个事实被抹掉了**。而 #3244 只放宽了「id 对不上」，没放宽「必须给 id」。
test("既有任务没有 turn 上下文时，不带 thread/turn 也能补迟到结果", async () => {
  const noIdTask = "task_late710_noid";
  db.run(`INSERT INTO tasks
    (task_id,from_name,to_name,to_node_id,status,content,result,network_id,thread_id,turn_id,completed_at)
    VALUES(?1,?2,'late710-worker',?3,'failed','timed out','[超时] 已达 30 分钟上限',?4,NULL,NULL,datetime('now'))`,
    [noIdTask, owner.user.username, workerId, owner.network_id]);

  const accepted = await mcp(workerToken, "send_reply", {
    in_reply_to: noIdTask,
    text: "没带 id 也应该收下",
    status: "replied",
  });
  expect(accepted).toMatchObject({ ok: true, late: true, duplicate: false });
  const row = db.get("SELECT status,result FROM task_late_replies WHERE task_id=?1", noIdTask);
  expect(row).toMatchObject({ status: "replied", result: "没带 id 也应该收下" });
  // 任务行仍不改写
  expect(db.get("SELECT status FROM tasks WHERE task_id=?1", noIdTask)).toEqual({ status: "failed" });

  // 反例：任务**有**上下文时，仍然必须给匹配的 id（不能被这次放宽带偏）
  const mismatch = await mcp(siblingToken, "send_reply", {
    in_reply_to: taskId, text: "impostor", thread_id: threadId, turn_id: turnId,
  });
  expect(mismatch).toMatchObject({ ok: false, error: "late_reply_task_not_owned" });
});
