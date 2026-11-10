import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db, syncScheduledRunForTask } from "./db.js";
import { runDueScheduledTasks } from "./scheduled-tasks.js";

if (!process.env.COMMHUB_DB) throw new Error("test1274 requires an explicit disposable SQLite COMMHUB_DB");
let server: any, base = "", network = "", ownerToken = "", ownerId = "";
const stamp = Date.now(), nodes: Record<string, { id: string; alias: string; token: string; tokenId: string }> = {};
async function rest(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await r.text(), line = raw.split("\n").find(x => x.startsWith("data: "));
  const envelope = JSON.parse(line ? line.slice(6) : raw);
  try { return JSON.parse(envelope.result.content[0].text); }
  catch { return { ok: false, transportError: true }; }
}
const readRun = (taskId: string) => db.get<any>(
  "SELECT run_id, schedule_id, status, work_outcome, work_outcome_node_id, schedule_revision FROM scheduled_task_runs WHERE task_id = ?1 AND network_id = ?2", taskId, network)!;
const readTask = (taskId: string) => db.get<any>("SELECT status, result FROM tasks WHERE task_id = ?1", taskId)!;
const countReplies = (taskId: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE in_reply_to = ?1 AND type = 'reply'", taskId)!.n;
async function fire() {
  const created = await rest(ownerToken, "POST", "/api/scheduled-tasks", { network_id: network,
    name: `test1274-${crypto.randomUUID()}`, target_node_id: nodes.a.id, task: "fixture1274 work",
    schedule: { type: "interval", every_seconds: 120 }, timezone: "UTC" });
  expect(created.status).toBe(201);
  const scheduleId = created.body.schedule.schedule_id;
  db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id != ?2", [new Date(Date.now() + 86400_000).toISOString(), scheduleId]);
  db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [new Date(Date.now() - 1000).toISOString(), scheduleId]);
  await runDueScheduledTasks();
  const run = db.get<any>("SELECT task_id FROM scheduled_task_runs WHERE schedule_id = ?1", scheduleId)!;
  expect(run.task_id).toBeTruthy();
  return { taskId: run.task_id as string, scheduleId };
}
const reply = (taskId: string, meta?: unknown, status = "replied", token = nodes.a.token, extra = {}) =>
  mcp(token, "send_reply", { in_reply_to: taskId, text: "本轮无新增", status, ...(meta === undefined ? {} : { meta }), ...extra });
const cadence = (id: string) => db.get<any>("SELECT next_run_at, last_run_at, revision, schedule_json, target_node_id FROM scheduled_tasks WHERE schedule_id = ?1", id)!;

beforeAll(async () => {
  const owner = register(`work_owner_${stamp}`, "Fixture1274Only!x"); ownerToken = owner.token!;
  network = owner.network_id!; ownerId = owner.user!.user_id;
  for (const key of ["a", "b"]) {
    const id = `n_work_${key}_${stamp}`, alias = `work-${key}-${stamp}`;
    const token = createNetworkTokenForNode(ownerId, network, alias, id); expect(token.ok).toBe(true);
    nodes[key] = { id, alias, token: token.token!, tokenId: token.token_id! };
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_${id}`, alias, id, network]);
  }
  const mod = await import("./server.js"); server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);
afterAll(() => server?.stop?.(true));

describe("#1274 exact successful scheduler work outcomes over real HTTP/MCP", () => {
  test("explicit no_changes persists with the same successful run and is readable; cadence stays unchanged", async () => {
    const { taskId, scheduleId } = await fire(), before = cadence(scheduleId);
    expect(readRun(taskId).schedule_revision).toBe(before.revision);
    const out = await reply(taskId, { scheduled_work_outcome: "no_changes", scheduled_run_id: "forged-and-ignored" });
    expect(out.ok).toBe(true); expect(out.scheduled_work_outcome).toBe("no_changes");
    expect(readTask(taskId).status).toBe("replied");
    expect(readRun(taskId)).toMatchObject({ status: "replied", work_outcome: "no_changes", work_outcome_node_id: nodes.a.id });
    expect(cadence(scheduleId)).toEqual(before);
    const history = await rest(ownerToken, "GET", `/api/scheduled-tasks/${scheduleId}/runs`);
    expect(history.status).toBe(200);
    expect(history.body.runs[0]).toMatchObject({ task_id: taskId, work_outcome: "no_changes", schedule_revision: before.revision, work_outcome_node_id: nodes.a.id });
  });
  test("changed is explicit even when the reply's natural-language text says no changes", async () => {
    const { taskId } = await fire(); expect((await reply(taskId, { scheduled_work_outcome: "changed" })).ok).toBe(true);
    expect(readRun(taskId).work_outcome).toBe("changed");
  });
  test("legacy success and empty-looking text remain unknown with unchanged response shape", async () => {
    const { taskId } = await fire(), out = await reply(taskId);
    expect(out.ok).toBe(true); expect(out.scheduled_work_outcome).toBeUndefined();
    expect(readRun(taskId)).toMatchObject({ status: "replied", work_outcome: null, work_outcome_node_id: null });
  });
  test("malformed, failed and cancelled signals do not write; ordinary terminal failures stay unknown", async () => {
    for (const [status, value] of [["replied", null], ["replied", "empty"], ["failed", "no_changes"], ["cancelled", "no_changes"]]) {
      const { taskId } = await fire(); expect((await reply(taskId, { scheduled_work_outcome: value }, status!)).ok).toBe(false);
      expect(readTask(taskId).status).toBe("delivered"); expect(countReplies(taskId)).toBe(0);
      expect((await reply(taskId, undefined, status!)).ok).toBe(true); expect(readRun(taskId).work_outcome).toBeNull();
    }
  });
  test("sibling node and a human token cannot classify the assigned node's run", async () => {
    const { taskId } = await fire();
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" }, "replied", nodes.b.token)).ok).toBe(false);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" }, "replied", ownerToken)).ok).toBe(false);
    expect(readTask(taskId).status).toBe("delivered"); expect(readRun(taskId).work_outcome).toBeNull(); expect(countReplies(taskId)).toBe(0);
  });
  test("a foreign network token cannot classify or terminalize the run", async () => {
    const { taskId } = await fire(), foreign = register(`work_foreign_${crypto.randomUUID()}`, "Fixture1274Only!x");
    const token = createNetworkTokenForNode(foreign.user!.user_id, foreign.network_id!, `foreign-${crypto.randomUUID()}`, `n_${crypto.randomUUID()}`);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" }, "replied", token.token!)).ok).toBe(false);
    expect(readTask(taskId).status).toBe("delivered"); expect(countReplies(taskId)).toBe(0);
  });
  test("a legacy unbound node token can still reply normally but cannot report a work signal", async () => {
    const { taskId } = await fire();
    db.run("UPDATE api_tokens SET bound_node_id = NULL WHERE token_id = ?1 AND network_id = ?2", [nodes.a.tokenId, network]);
    try {
      expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(false);
      expect((await reply(taskId)).ok).toBe(true); expect(readRun(taskId).work_outcome).toBeNull();
    } finally { db.run("UPDATE api_tokens SET bound_node_id = ?1 WHERE token_id = ?2 AND network_id = ?3", [nodes.a.id, nodes.a.tokenId, network]); }
  });
  test("forged schedule metadata on an ordinary task cannot become an authoritative occurrence", async () => {
    const { scheduleId } = await fire(); const sent = await rest(ownerToken, "POST", "/api/task", { network_id: network, alias: nodes.a.alias, task: "ordinary1274" });
    expect(sent.status).toBe(200);
    expect((await reply(sent.body.task_id, { scheduled_work_outcome: "no_changes", scheduled_task_id: scheduleId })).ok).toBe(false);
    expect(readTask(sent.body.task_id).status).toBe("delivered"); expect(countReplies(sent.body.task_id)).toBe(0);
  });
  test("multiple authoritative bindings refuse instead of fanning one outcome into two runs", async () => {
    const { taskId, scheduleId } = await fire(), run = readRun(taskId), duplicate = `srun_dup_${crypto.randomUUID()}`;
    db.run("INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, task_id, status) VALUES (?1, ?2, ?3, ?4, ?5, 'delivered')", [duplicate, scheduleId, network, new Date(Date.now() + 86400_000).toISOString(), taskId]);
    try { expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).error).toBe("scheduled_work_outcome_run_unresolved");
      expect(readTask(taskId).status).toBe("delivered"); expect(countReplies(taskId)).toBe(0); }
    finally { db.run("DELETE FROM scheduled_task_runs WHERE run_id = ?1", duplicate); }
    expect(readRun(taskId).run_id).toBe(run.run_id); expect(readRun(taskId).work_outcome).toBeNull();
  });
  test("expired/late receipts never classify a run or rewrite its original terminal state", async () => {
    const { taskId } = await fire(), thread_id = `thread_${crypto.randomUUID()}`, turn_id = `turn_${crypto.randomUUID()}`;
    db.run("UPDATE tasks SET status = 'expired', thread_id = ?1, turn_id = ?2, completed_at = datetime('now') WHERE task_id = ?3", [thread_id, turn_id, taskId]); syncScheduledRunForTask(taskId, network);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" }, "replied", nodes.a.token, { thread_id, turn_id })).error).toBe("scheduled_work_outcome_terminal");
    expect((await reply(taskId, undefined, "replied", nodes.a.token, { thread_id, turn_id })).late).toBe(true);
    expect(readTask(taskId).status).toBe("expired"); expect(readRun(taskId)).toMatchObject({ status: "expired", work_outcome: null });
  });
  test("success cannot retry; an expired fixture task clears stale outcome on retry and later failure", async () => {
    const { taskId } = await fire(); expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect((await mcp(ownerToken, "retry_task", { task_id: taskId, network_id: network })).ok).toBe(false);
    // Fixture-only legacy/corrupt terminal injection: preserve the stale run
    // signal deliberately so the retry clearing branch is load-bearing.
    db.run("UPDATE tasks SET status = 'expired' WHERE task_id = ?1", taskId);
    expect((await mcp(ownerToken, "retry_task", { task_id: taskId, network_id: network })).ok).toBe(true);
    expect(readRun(taskId)).toMatchObject({ status: "delivered", work_outcome: null, work_outcome_node_id: null });
    expect((await reply(taskId, undefined, "failed")).ok).toBe(true); expect(readRun(taskId)).toMatchObject({ status: "failed", work_outcome: null });
  });
  test("injected outcome write failure rolls back task, inbox and run atomically", async () => {
    const { taskId } = await fire(), run = readRun(taskId);
    db.exec(`CREATE TRIGGER test1274_outcome_fault BEFORE UPDATE OF work_outcome ON scheduled_task_runs WHEN NEW.run_id = '${run.run_id}' AND NEW.work_outcome IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test1274_fault'); END`);
    try { expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).not.toBe(true); }
    finally { db.exec("DROP TRIGGER test1274_outcome_fault"); }
    expect(readTask(taskId)).toMatchObject({ status: "delivered", result: null });
    expect(readRun(taskId)).toMatchObject({ status: "delivered", work_outcome: null }); expect(countReplies(taskId)).toBe(0);
    expect((await reply(taskId, { scheduled_work_outcome: "changed" })).ok).toBe(true);
  });
  test("a later schedule edit cannot relabel the dispatch revision; history alone grants no backoff", async () => {
    const { taskId, scheduleId } = await fire(), revision = readRun(taskId).schedule_revision;
    const edit = await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${scheduleId}`, { revision, name: "edited1274" }); expect(edit.status).toBe(200);
    const before = cadence(scheduleId); expect(before.revision).toBe(revision + 1);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(readRun(taskId).schedule_revision).toBe(revision); expect(cadence(scheduleId)).toEqual(before);
  });
});
