import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db, syncScheduledRunForTask } from "./db.js";
import { refreshScheduledBackoff } from "./scheduled-backoff.js";
import { getScheduleRow, dispatchScheduledOccurrence, runDueScheduledTasks } from "./scheduled-tasks.js";

if (!process.env.COMMHUB_DB) throw new Error("test1284 requires an explicit disposable SQLite COMMHUB_DB");
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
    name: `test1284-${crypto.randomUUID()}`, target_node_id: nodes.a.id, task: "核对实际需求；Owner 原文包含 no_changes 字样。",
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
  const owner = register(`guidance_owner_${stamp}`, "Fixture1274Only!x"); ownerToken = owner.token!;
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

const marker = "[Agent Network / scheduled work outcome]";
const original = "核对实际需求；Owner 原文包含 no_changes 字样。";
async function received(taskId: string) {
  const out = await mcp(nodes.a.token,"get_task",{task_id:taskId});
  expect(out.ok).toBe(true); expect(out.task.task_id).toBe(taskId); return out.task;
}
async function syntheticProducer(taskId: string, verified: "changed" | "no_changes") {
  const task = await received(taskId);
  expect(task.content).toContain(marker);
  expect(task.content).toContain(`in_reply_to="${taskId}"`);
  // This fixture chooses a known synthetic observation. It is not an LLM
  // classifier and never parses reply prose to manufacture an outcome.
  return reply(taskId,{scheduled_work_outcome:verified});
}
describe("#1284 opted-in dispatch guidance and explicit synthetic producer",()=>{
  test("disabled schedules retain exact Owner task bytes in both task and inbox",async()=>{
    const {taskId,scheduleId}=await fire(false), task=await received(taskId);
    expect(task.content).toBe(original);
    expect(db.get<any>("SELECT content FROM inbox WHERE task_id=?1",taskId).content).toBe(original);
    expect(getScheduleRow(scheduleId)!.task_content).toBe(original);
  });
  test("human opt-in dispatch exposes exact task binding but does not annotate automatically",async()=>{
    const {taskId,scheduleId}=await fire(),task=await received(taskId);
    expect(task.content.startsWith(original)).toBe(true);
    expect(task.content).toContain(`in_reply_to="${taskId}"`);
    expect(task.content).toContain('"scheduled_work_outcome":"changed"');
    expect(task.content).toContain('"scheduled_work_outcome":"no_changes"');
    expect(task.content).toContain("未核实、失败、超时、过期、跳过");
    expect(task.content).toContain("保留未知");
    expect(db.get<any>("SELECT content FROM inbox WHERE task_id=?1",taskId).content).toBe(task.content);
    expect(getScheduleRow(scheduleId)!.task_content).toBe(original);
    expect(readRun(taskId).work_outcome).toBeNull(); expect(countReplies(taskId)).toBe(0);
  });
  test("three read-guidance explicit empty reports back off, a changed report restores base",async()=>{
    const {taskId,scheduleId}=await fire();expect((await syntheticProducer(taskId,"no_changes")).ok).toBe(true);
    for(let i=0;i<2;i++)expect((await syntheticProducer(await nextRun(scheduleId),"no_changes")).ok).toBe(true);
    expect(state(scheduleId)).toMatchObject({backoff_streak:3,backoff_effective_seconds:600});
    const changed=await nextRun(scheduleId);expect((await syntheticProducer(changed,"changed")).ok).toBe(true);
    expect(readRun(changed).work_outcome).toBe("changed");
    expect(state(scheduleId)).toMatchObject({backoff_streak:0,backoff_effective_seconds:120});
  });
  test("normal successful prose-only reply stays unknown despite prompt and no_changes words",async()=>{
    const {taskId,scheduleId}=await fire();await received(taskId);
    expect((await reply(taskId)).ok).toBe(true);expect(readRun(taskId).work_outcome).toBeNull();expect(state(scheduleId).backoff_streak).toBe(0);
  });
  test("guidance cannot turn a failed result into successful empty",async()=>{
    const {taskId,scheduleId}=await fire();await received(taskId);
    expect((await reply(taskId,{scheduled_work_outcome:"no_changes"},"failed")).ok).not.toBe(true);
    expect(readTask(taskId).status).toBe("delivered");expect(countReplies(taskId)).toBe(0);
    expect((await reply(taskId,undefined,"failed")).ok).toBe(true);expect(readRun(taskId).work_outcome).toBeNull();expect(state(scheduleId).backoff_streak).toBe(0);
  });
  test("revalidated persisted opt-in wins over a stale caller row",async()=>{
    const {scheduleId,taskId}=await fire();expect((await reply(taskId)).ok).toBe(true);
    const edit=await rest(ownerToken,"PATCH",`/api/scheduled-tasks/${scheduleId}`,{revision:state(scheduleId).revision,no_change_backoff:false});expect(edit.status).toBe(200);
    const row={...getScheduleRow(scheduleId)!,no_change_backoff:1};
    const out=dispatchScheduledOccurrence(row,new Date(Date.now()+(++occurrence)*1000).toISOString(),true);expect(out.taskId).toBeTruthy();
    expect((await received(out.taskId!)).content).toBe(original);
  });
  test("agent-created schedules keep creator provenance ahead of Owner content and guidance",async()=>{
    const made=await mcp(nodes.b.token,"schedule_create",{name:"agent guidance1284",task:original,target_node_id:nodes.a.id,no_change_backoff:true,schedule:{type:"interval",every_seconds:120}});expect(made.ok).toBe(true);
    const id=made.schedule.schedule_id,taskId=await nextRun(id),task=await received(taskId);
    expect(task.content).toContain(nodes.b.alias);expect(task.content.indexOf(nodes.b.alias)).toBeLessThan(task.content.indexOf(original));expect(task.content.indexOf(original)).toBeLessThan(task.content.indexOf(marker));
    expect((await syntheticProducer(taskId,"changed")).ok).toBe(true);expect(readRun(taskId).work_outcome).toBe("changed");
  });
  test("another target cannot reuse the advertised binding; duplicate normal reply never counts twice",async()=>{
    const {taskId,scheduleId}=await fire();await received(taskId);
    expect((await reply(taskId,{scheduled_work_outcome:"no_changes"},"replied",nodes.b.token)).ok).not.toBe(true);
    expect(readRun(taskId).work_outcome).toBeNull();expect((await syntheticProducer(taskId,"no_changes")).ok).toBe(true);
    const before=state(scheduleId);expect((await reply(taskId,{scheduled_work_outcome:"no_changes"})).ok).not.toBe(true);expect(state(scheduleId)).toEqual(before);expect(countReplies(taskId)).toBe(1);
  });
});
