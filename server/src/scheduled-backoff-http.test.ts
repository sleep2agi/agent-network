import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db, syncScheduledRunForTask } from "./db.js";
import { refreshScheduledBackoff } from "./scheduled-backoff.js";
import { getScheduleRow, dispatchScheduledOccurrence, runDueScheduledTasks } from "./scheduled-tasks.js";

if (!process.env.COMMHUB_DB) throw new Error("test1278 requires an explicit disposable SQLite COMMHUB_DB");
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
async function fire(enabled = true, interval = 120) {
  const created = await rest(ownerToken, "POST", "/api/scheduled-tasks", { network_id: network,
    name: `test1278-${crypto.randomUUID()}`, target_node_id: nodes.a.id, task: "fixture1278 work",
    schedule: { type: "interval", every_seconds: interval }, timezone: "UTC", no_change_backoff: enabled });
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


const state = (id: string) => db.get<any>("SELECT no_change_backoff, backoff_streak, backoff_effective_seconds, backoff_last_run_id, next_run_at, revision, schedule_json, status FROM scheduled_tasks WHERE schedule_id = ?1", id)!;
let occurrence = 0;
async function nextRun(id: string) {
  // Isolated fixture accelerates the clock, without touching live schedules.
  const date = new Date(Date.now() + (++occurrence) * 1000).toISOString();
  const out = dispatchScheduledOccurrence(getScheduleRow(id)!, date, true);
  expect(out.taskId).toBeTruthy(); return out.taskId!;
}
async function empties(id: string, n: number) {
  for (let i = 0; i < n; i++) expect((await reply(await nextRun(id), { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
}
async function atThree() {
  const x = await fire(); expect((await reply(x.taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
  await empties(x.scheduleId, 2); return x;
}
describe("#1278 opt-in durable no-change backoff through real HTTP/MCP", () => {
  test("3 and 6 exact empty successes change effective cadence, preserving base and revision", async () => {
    const { taskId, scheduleId } = await fire(), initial = state(scheduleId);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    await empties(scheduleId, 1); expect(state(scheduleId).backoff_effective_seconds).toBe(120);
    await empties(scheduleId, 1); const three = state(scheduleId);
    expect(three).toMatchObject({ backoff_streak: 3, backoff_effective_seconds: 600, revision: initial.revision, schedule_json: initial.schedule_json });
    expect(Date.parse(three.next_run_at) - Date.now()).toBeGreaterThan(590_000);
    await empties(scheduleId, 3); expect(state(scheduleId)).toMatchObject({ backoff_streak: 6, backoff_effective_seconds: 1800 });
    const wire = await rest(ownerToken, "GET", `/api/scheduled-tasks/${scheduleId}`);
    expect(wire.body.schedule).toMatchObject({ no_change_backoff: true, schedule: { every_seconds: 120 }, backoff: { streak: 6, effective_seconds: 1800 } });
    expect(wire.body.schedule.backoff_last_run_id).toBeUndefined();
  });
  test("changed restores base and nearer next occurrence; no natural-language inference", async () => {
    const { scheduleId } = await atThree();
    expect((await reply(await nextRun(scheduleId), { scheduled_work_outcome: "changed" })).ok).toBe(true);
    expect(state(scheduleId)).toMatchObject({ backoff_streak: 0, backoff_effective_seconds: 120 });
    expect(Date.parse(state(scheduleId).next_run_at) - Date.now()).toBeLessThanOrEqual(120_000);
  });
  test("unknown success and ordinary failure break the sequence", async () => {
    for (const status of ["replied", "failed"]) {
      const { scheduleId } = await atThree();
      expect((await reply(await nextRun(scheduleId), undefined, status)).ok).toBe(true);
      expect(state(scheduleId)).toMatchObject({ backoff_streak: 0, backoff_effective_seconds: 120 });
      await empties(scheduleId, 2); expect(state(scheduleId).backoff_effective_seconds).toBe(120);
    }
  });
  test("legacy disabled schedules preserve exact cadence and wire shape", async () => {
    const { taskId, scheduleId } = await fire(false), before = state(scheduleId);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(state(scheduleId)).toEqual(before);
    const wire = await rest(ownerToken, "GET", `/api/scheduled-tasks/${scheduleId}`);
    expect(wire.body.schedule.no_change_backoff).toBeUndefined(); expect(wire.body.schedule.backoff).toBeUndefined();
  });
  test("a slower base interval is never accelerated", async () => {
    const { taskId, scheduleId } = await fire(true, 3600);
    await reply(taskId, { scheduled_work_outcome: "no_changes" }); await empties(scheduleId, 5);
    expect(state(scheduleId)).toMatchObject({ backoff_streak: 6, backoff_effective_seconds: 3600 });
  });
  test("duplicate callbacks and another DB process cannot increment twice", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId);
    const latest = db.get<any>("SELECT task_id FROM scheduled_task_runs WHERE run_id = ?1", before.backoff_last_run_id)!;
    expect((await reply(latest.task_id, { scheduled_work_outcome: "no_changes" })).ok).toBe(false);
    syncScheduledRunForTask(latest.task_id, network); expect(state(scheduleId)).toEqual(before);
    const child = Bun.spawn([process.execPath, "-e", `import {db} from './server/src/db.ts'; import {refreshScheduledBackoff} from './server/src/scheduled-backoff.ts'; db.transaction(()=>refreshScheduledBackoff(${JSON.stringify(scheduleId)},${JSON.stringify(network)})); console.log(JSON.stringify(db.get('SELECT backoff_streak,backoff_effective_seconds FROM scheduled_tasks WHERE schedule_id=?1',${JSON.stringify(scheduleId)})));`], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: process.env });
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ backoff_streak: 3, backoff_effective_seconds: 600 });
    expect(state(scheduleId)).toEqual(before);
  });
  test("old generation completion after edit cannot rearm", async () => {
    const { scheduleId } = await atThree(), old = await nextRun(scheduleId), revision = state(scheduleId).revision;
    const edit = await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${scheduleId}`, { revision, name: "fresh generation" }); expect(edit.status).toBe(200);
    const before = state(scheduleId); expect(before.backoff_streak).toBe(0);
    expect((await reply(old, { scheduled_work_outcome: "no_changes" })).ok).toBe(true); expect(state(scheduleId)).toEqual(before);
  });
  test("manual wake resets durable state and fences an in-flight old generation", async () => {
    const { scheduleId } = await atThree(), old = await nextRun(scheduleId), revision = state(scheduleId).revision;
    // Existing overlap skip remains effective. Wake still resets cadence.
    const wake = await rest(ownerToken, "POST", `/api/scheduled-tasks/${scheduleId}/run-now`); expect(wake.status).toBe(202);
    expect(state(scheduleId)).toMatchObject({ backoff_streak: 0, backoff_effective_seconds: null, revision: revision + 1 });
    const before = state(scheduleId); await reply(old, { scheduled_work_outcome: "no_changes" }); expect(state(scheduleId)).toEqual(before);
  });
  test("pause/cancel never resurrect cadence; resumed policy starts a new generation", async () => {
    const { scheduleId } = await atThree(), old = await nextRun(scheduleId);
    expect((await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${scheduleId}`, { revision: state(scheduleId).revision, status: "paused" })).status).toBe(200);
    await reply(old, { scheduled_work_outcome: "changed" }); expect(state(scheduleId)).toMatchObject({ status: "paused", next_run_at: null, backoff_streak: 0 });
    expect((await rest(ownerToken, "POST", `/api/scheduled-tasks/${scheduleId}/run-now`)).status).toBe(202);
    expect(state(scheduleId).next_run_at).toBeNull();
    expect((await rest(ownerToken, "DELETE", `/api/scheduled-tasks/${scheduleId}`)).status).toBe(200);
    expect((await rest(ownerToken, "POST", `/api/scheduled-tasks/${scheduleId}/run-now`)).status).toBe(409);
    expect(state(scheduleId)).toMatchObject({ status: "cancelled", next_run_at: null });
  });
  test("retry success is excluded from empty streaks and failure breaks prior successes", async () => {
    const { scheduleId } = await atThree(), task = await nextRun(scheduleId);
    await reply(task, undefined, "failed"); expect(state(scheduleId).backoff_streak).toBe(0);
    expect((await mcp(ownerToken, "retry_task", { task_id: task, network_id: network })).ok).toBe(true);
    expect((await reply(task, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(state(scheduleId).backoff_streak).toBe(0); await empties(scheduleId, 2);
    expect(state(scheduleId).backoff_streak).toBe(2);
  });
  test("overlap skip breaks the sequence and an older completion cannot bypass the skip", async () => {
    const { scheduleId } = await atThree(), active = await nextRun(scheduleId);
    const skipped = dispatchScheduledOccurrence(getScheduleRow(scheduleId)!, new Date(Date.now() + (++occurrence) * 1000).toISOString(), true);
    expect(skipped.status).toBe("skipped"); expect(state(scheduleId).backoff_streak).toBe(0);
    await reply(active, { scheduled_work_outcome: "no_changes" }); expect(state(scheduleId).backoff_streak).toBe(0);
  });
  test("current reporter target mismatch cannot count as empty", async () => {
    const { scheduleId } = await atThree(), task = await nextRun(scheduleId);
    // Fixture-only reassignment emulates an authorized assignment change.
    db.run("UPDATE tasks SET to_node_id = ?1, to_name = ?2 WHERE task_id = ?3", [nodes.b.id, nodes.b.alias, task]);
    expect((await reply(task, { scheduled_work_outcome: "no_changes" }, "replied", nodes.b.token)).ok).toBe(true);
    expect(state(scheduleId).backoff_streak).toBe(0);
  });
  test("injected cadence-write fault rolls back task, inbox, outcome, and state together", async () => {
    const { taskId, scheduleId } = await fire(), before = state(scheduleId);
    db.exec(`CREATE TRIGGER test1278_fault BEFORE UPDATE OF backoff_streak ON scheduled_tasks WHEN NEW.schedule_id='${scheduleId}' BEGIN SELECT RAISE(ABORT,'test1278_fault'); END`);
    try { expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).not.toBe(true); }
    finally { db.exec("DROP TRIGGER test1278_fault"); }
    expect(state(scheduleId)).toEqual(before); expect(readTask(taskId).status).toBe("delivered");
    expect(readRun(taskId).work_outcome).toBeNull(); expect(countReplies(taskId)).toBe(0);
    expect((await reply(taskId, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
  });
  test("REST rejects malformed and non-interval policy; MCP respects creator ownership", async () => {
    for (const policy of ["true", 1, null]) {
      const bad = await rest(ownerToken, "POST", "/api/scheduled-tasks", { network_id: network, name: "invalid1278", target_node_id: nodes.a.id, task: "fixture", schedule: { type: "interval", every_seconds: 120 }, no_change_backoff: policy }); expect(bad.status).toBe(400);
    }
    const bad = await rest(ownerToken, "POST", "/api/scheduled-tasks", { network_id: network, name: "once1278", target_node_id: nodes.a.id, task: "fixture", schedule: { type: "once", run_at: new Date(Date.now()+86400000).toISOString() }, no_change_backoff: true }); expect(bad.status).toBe(400);
    const created = await mcp(nodes.a.token, "schedule_create", { name: "agent1278", task: "fixture", schedule: { type: "interval", every_seconds: 120 }, no_change_backoff: true }); expect(created.ok).toBe(true);
    expect(created.schedule.no_change_backoff).toBe(true);
    const id = created.schedule.schedule_id;
    expect((await mcp(nodes.b.token, "schedule_update", { schedule_id: id, no_change_backoff: false })).ok).toBe(false);
    expect((await mcp(nodes.a.token, "schedule_update", { schedule_id: id, no_change_backoff: false })).ok).toBe(true);
    expect(state(id).no_change_backoff).toBe(0);
    const human = await fire(); expect((await mcp(nodes.a.token, "schedule_update", { schedule_id: human.scheduleId, no_change_backoff: false })).ok).toBe(false);
    db.run("UPDATE scheduled_tasks SET overlap_policy = 'allow' WHERE schedule_id = ?1", human.scheduleId);
    const allow = await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${human.scheduleId}`, { revision: state(human.scheduleId).revision, no_change_backoff: true });
    expect(allow.status).toBe(400); expect(allow.body.error).toBe("no_change_backoff_requires_skip_overlap");
  });
});
