import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db, syncScheduledRunForTask } from "./db.js";
import { consumeRequirementWake, pollRequirementWakes } from "./scheduled-requirement-wake.js";
import { refreshScheduledBackoff } from "./scheduled-backoff.js";
import { getScheduleRow, dispatchScheduledOccurrence, runDueScheduledTasks } from "./scheduled-tasks.js";

if (!process.env.COMMHUB_DB) throw new Error("test1279 requires an explicit disposable SQLite COMMHUB_DB");
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
    name: `test1279-${crypto.randomUUID()}`, target_node_id: nodes.a.id, task: "fixture1278 work",
    schedule: { type: "interval", every_seconds: interval, ...(enabled ? { requirement_wake: { tag: "ANet" } } : {}) }, timezone: "UTC", no_change_backoff: enabled });
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


const state = (id: string) => db.get<any>("SELECT no_change_backoff, backoff_streak, backoff_effective_seconds, backoff_last_run_id, next_run_at, revision, schedule_json, status, requirement_wake_json, requirement_wake_cursor, requirement_wake_last_event_id FROM scheduled_tasks WHERE schedule_id = ?1", id)!;
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

async function card(body: Record<string, unknown> = {}, token = ownerToken) {
  const c = await rest(token, "POST", "/api/requirements", { network_id: network, name: "domain1279", tags: ["ANet", "知识库"], ...body });
  expect(c.status).toBe(201); return c.body.requirement;
}
async function column(id: string, status: string, token = ownerToken) {
  const c = await rest(token, "PATCH", `/api/requirements/${id}`, { column: status }); expect(c.status).toBe(200);
}
function poll(id: string) { return consumeRequirementWake(id, network); }
describe("#1279 authoritative scoped requirement-event wake over HTTP/MCP", () => {
  test("new matching work restores base with a durable cursor and fences old completion", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId), old = await nextRun(scheduleId);
    const c = await card(); expect(poll(scheduleId)).toBe(true);
    const after = state(scheduleId); expect(after).toMatchObject({ backoff_streak: 0, backoff_effective_seconds: null, revision: before.revision + 1, schedule_json: before.schedule_json });
    expect(after.requirement_wake_cursor).toBeGreaterThan(before.requirement_wake_cursor);
    expect(after.requirement_wake_last_event_id).toBeTruthy();
    expect(Date.parse(after.next_run_at) - Date.now()).toBeLessThanOrEqual(120_000);
    expect((await reply(old, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(state(scheduleId).backoff_streak).toBe(0); expect(state(scheduleId).revision).toBe(after.revision);
    expect(poll(scheduleId)).toBe(false); expect(state(scheduleId)).toEqual(after);
    const wire = await rest(ownerToken, "GET", `/api/scheduled-tasks/${scheduleId}`);
    expect(wire.body.schedule.schedule.requirement_wake).toEqual({ tag: "ANet", project_id: null });
    expect(JSON.stringify(wire.body.schedule)).not.toContain(ownerId);
    expect(c.id).toBeTruthy();
  });
  test("a matching event is consumed within normal reply before the old empty signal can delay cadence", async () => {
    const { scheduleId } = await atThree(), task = await nextRun(scheduleId), revision = state(scheduleId).revision;
    await card(); expect((await reply(task, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(state(scheduleId)).toMatchObject({ backoff_streak: 0, backoff_effective_seconds: null, revision: revision + 1 });
  });
  test("existing scheduler tick scans delayed plans even before their next due", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId); await card();
    runDueScheduledTasks(); expect(state(scheduleId).revision).toBe(before.revision + 1);
    expect(state(scheduleId).backoff_streak).toBe(0);
  });
  test("old events and duplicate consumption do not replay after enable or process reopen", async () => {
    await card(); const { scheduleId } = await atThree(), before = state(scheduleId); expect(poll(scheduleId)).toBe(false);
    const child = Bun.spawn([process.execPath, "-e", `import {consumeRequirementWake} from './server/src/scheduled-requirement-wake.ts'; console.log(JSON.stringify({wake:consumeRequirementWake(${JSON.stringify(scheduleId)},${JSON.stringify(network)})}));`], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: process.env });
    const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ wake: false }); expect(state(scheduleId)).toEqual(before);
  });
  test("status transitions wake while comments/checklists/no-op edits do not", async () => {
    const c = await card({ checklist: [{ id: "one", text: "unit", done: false }] });
    const { scheduleId } = await atThree(), before = state(scheduleId);
    expect((await mcp(ownerToken, "requirements_comment", { id: c.id, network_id: network, text: "routine checkpoint" })).ok).toBe(true);
    expect((await mcp(ownerToken, "requirements_checklist_toggle", { id: c.id, network_id: network, item_id: "one", done: true })).ok).toBe(true);
    await column(c.id, "pool"); expect(poll(scheduleId)).toBe(false);
    expect(state(scheduleId).revision).toBe(before.revision); expect(state(scheduleId).backoff_streak).toBe(3);
    await column(c.id, "doing"); expect(poll(scheduleId)).toBe(true);
  });
  test("self node writes and iteration archives do not wake; knowledge-tagged real work can wake", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId);
    expect((await mcp(nodes.a.token, "requirements_create", { name: "self source", tags: ["ANet"], network_id: network })).ok).toBe(true);
    await card({ external_ref: "iteration:fixture1279" }); expect(poll(scheduleId)).toBe(false);
    expect(state(scheduleId).revision).toBe(before.revision);
    await card(); expect(poll(scheduleId)).toBe(true);
  });
  test("other-node real work wakes and unrelated tags or networks do not", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId);
    await card({ tags: ["unrelated"] }); expect(poll(scheduleId)).toBe(false);
    const foreign = register(`foreign1279_${crypto.randomUUID()}`, "Fixture1279Only!x");
    expect((await rest(foreign.token!, "POST", "/api/requirements", { network_id: foreign.network_id!, name: "foreign", tags: ["ANet"] })).status).toBe(201);
    expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision);
    expect((await mcp(nodes.b.token, "requirements_create", { name: "other real work", tags: ["ANet"], network_id: network })).ok).toBe(true);
    expect(poll(scheduleId)).toBe(true);
  });
  test("creator MCP config roundtrip retains watch through batch/metadata edits; another node cannot edit it", async () => {
    const created = await mcp(nodes.a.token, "schedule_create", { name: "agent wake1279", task: "fixture", no_change_backoff: true, schedule: { type: "interval", every_seconds: 120, requirement_wake: { tag: "ANet" } } });
    expect(created.ok).toBe(true); const id = created.schedule.schedule_id;
    expect(created.schedule.schedule.requirement_wake.tag).toBe("ANet");
    expect((await mcp(nodes.b.token, "schedule_update", { schedule_id: id, schedule: { type: "interval", every_seconds: 180, requirement_wake: null } })).ok).toBe(false);
    expect((await mcp(nodes.a.token, "schedule_batch_interval", { schedule_ids: [id], every_seconds: 180 })).ok).toBe(true);
    expect(state(id).requirement_wake_json).toBeTruthy();
    expect((await mcp(nodes.a.token, "schedule_update", { schedule_id: id, name: "metadata" })).ok).toBe(true);
    expect(state(id).requirement_wake_json).toBeTruthy();
    expect((await mcp(nodes.a.token, "schedule_update", { schedule_id: id, no_change_backoff: false })).ok).toBe(true);
    expect(state(id).requirement_wake_json).toBeNull();
  });
  test("paused/cancelled plans do not wake; resume rebases the cursor rather than replaying hidden time", async () => {
    const { scheduleId } = await atThree();
    expect((await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${scheduleId}`, { revision: state(scheduleId).revision, status: "paused" })).status).toBe(200);
    const before = state(scheduleId); await card(); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId)).toEqual(before);
    expect((await rest(ownerToken, "PATCH", `/api/scheduled-tasks/${scheduleId}`, { revision: state(scheduleId).revision, status: "active" })).status).toBe(200);
    expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).backoff_streak).toBe(0);
    expect((await rest(ownerToken, "DELETE", `/api/scheduled-tasks/${scheduleId}`)).status).toBe(200);
    const canceled = state(scheduleId); await card(); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId)).toEqual(canceled);
  });
  test("current restricted target visibility is enforced even in permission log mode, grants never replay skipped history", async () => {
    const { scheduleId } = await atThree(), before = state(scheduleId);
    db.run("UPDATE nodes SET permission_mode = 'restricted' WHERE node_id = ?1", nodes.a.id);
    try { await card(); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision); }
    finally { db.run("UPDATE nodes SET permission_mode = 'normal' WHERE node_id = ?1", nodes.a.id); }
    expect(poll(scheduleId)).toBe(false);
    await card(); expect(poll(scheduleId)).toBe(true);
  });
  test("creator membership loss, read-only target and owner replacement suppress wake and consume without replay", async () => {
    for (const change of ["membership", "readonly", "owner"]) {
      const { scheduleId } = await atThree(), before = state(scheduleId);
      if (change === "membership") db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [network, ownerId]);
      if (change === "readonly") db.run("UPDATE nodes SET permission_mode = 'readonly' WHERE node_id = ?1", nodes.a.id);
      if (change === "owner") db.run("UPDATE nodes SET owner_user_id = NULL WHERE node_id = ?1", nodes.a.id);
      // Fixture-only trusted event insertion after revocation; public mutation
      // itself may now refuse, and must not be weakened for this scenario.
      const c = db.get<any>("SELECT requirement_id,seq,title FROM requirements WHERE network_id = ?1 LIMIT 1", network)!;
      db.run("INSERT INTO requirement_events(network_id,requirement_id,seq,title,actor_json,kind,field,old_json,new_json,created_at) VALUES(?1,?2,?3,?4,?5,'changed','column','\"pool\"','\"doing\"',datetime('now'))", [network,c.requirement_id,c.seq,c.title,JSON.stringify({kind:"user",id:ownerId})]);
      try { expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision); }
      finally {
        if (change === "membership") db.run("INSERT INTO network_members(network_id,user_id,role,task_access) VALUES(?1,?2,'owner','all')", [network,ownerId]);
        if (change === "readonly") db.run("UPDATE nodes SET permission_mode = 'normal' WHERE node_id = ?1", nodes.a.id);
        if (change === "owner") db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = ?2", [ownerId,nodes.a.id]);
      }
      expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision);
    }
  });
  test("cursor write fault rolls back wake and the normal reply together; retry consumes exactly once", async () => {
    const { scheduleId } = await atThree(), task = await nextRun(scheduleId); await card(); const before = state(scheduleId);
    db.exec(`CREATE TRIGGER test1279_fault BEFORE UPDATE OF requirement_wake_cursor ON scheduled_tasks WHEN NEW.schedule_id='${scheduleId}' BEGIN SELECT RAISE(ABORT,'test1279_fault'); END`);
    try { expect((await reply(task, { scheduled_work_outcome: "no_changes" })).ok).not.toBe(true); }
    finally { db.exec("DROP TRIGGER test1279_fault"); }
    expect(state(scheduleId)).toEqual(before); expect(readTask(task).status).toBe("delivered");
    expect(readRun(task).work_outcome).toBeNull(); expect(countReplies(task)).toBe(0);
    expect((await reply(task, { scheduled_work_outcome: "no_changes" })).ok).toBe(true);
    expect(state(scheduleId).revision).toBe(before.revision + 1); expect(poll(scheduleId)).toBe(false);
  });
  test("invalid/empty/forged authority filters refuse without creating a plan; explicit null disables", async () => {
    for (const policy of [true, {}, {tag:""}, {tag:"ANet", creator_user_id:ownerId}]) {
      const out = await rest(ownerToken, "POST", "/api/scheduled-tasks", { network_id:network, name:"invalid1279",target_node_id:nodes.a.id,task:"fixture",no_change_backoff:true,schedule:{type:"interval",every_seconds:120,requirement_wake:policy} }); expect(out.status).toBe(400);
    }
    const {scheduleId}=await atThree();
    expect((await rest(ownerToken,"PATCH",`/api/scheduled-tasks/${scheduleId}`,{revision:state(scheduleId).revision,schedule:{type:"interval",every_seconds:120,requirement_wake:null}})).status).toBe(200);
    await card();expect(poll(scheduleId)).toBe(false);expect(state(scheduleId).requirement_wake_json).toBeNull();
  });
  test("project filter and current target project grants limit wake, revoked grants never replay", async () => {
    const p1 = await rest(ownerToken,"POST","/api/requirements/projects",{network_id:network,name:"project1279"}); expect(p1.status).toBe(201); const project=p1.body.project.id;
    const {scheduleId}=await atThree();
    const scoped=register(`scoped1279_${crypto.randomUUID()}`,"Fixture1279Only!x"), uid=scoped.user!.user_id;
    db.run("INSERT INTO network_members(network_id,user_id,role,task_access) VALUES(?1,?2,'member','scoped')",[network,uid]);
    db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = ?2",[uid,nodes.a.id]);
    try {
      const edit=await rest(ownerToken,"PATCH",`/api/scheduled-tasks/${scheduleId}`,{revision:state(scheduleId).revision,schedule:{type:"interval",every_seconds:120,requirement_wake:{project_id:project,tag:"ANet"}}}); expect(edit.status).toBe(200);
      const base=state(scheduleId);
      await card({project_id:project}); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(base.revision);
      expect((await rest(ownerToken,"PUT",`/api/networks/${network}/members/${uid}/task-grants`,{task_access:"scoped",project_grants:[{project_id:project}]})).status).toBe(200);
      expect(poll(scheduleId)).toBe(false); // no replay after gaining access
      await card(); expect(poll(scheduleId)).toBe(false); // tag alone is insufficient
      await card({project_id:project}); expect(poll(scheduleId)).toBe(true);
      expect((await rest(ownerToken,"PUT",`/api/networks/${network}/members/${uid}/task-grants`,{task_access:"scoped",project_grants:[]})).status).toBe(200);
      const before=state(scheduleId); await card({project_id:project}); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision);
    } finally { db.run("UPDATE nodes SET owner_user_id = ?1 WHERE node_id = ?2",[ownerId,nodes.a.id]); }
  });
  test("a scoped editor cannot borrow the original creator's event visibility", async () => {
    const {scheduleId}=await atThree();
    const scoped=register(`editor1279_${crypto.randomUUID()}`,"Fixture1279Only!x"), uid=scoped.user!.user_id;
    db.run("INSERT INTO network_members(network_id,user_id,role,task_access) VALUES(?1,?2,'member','scoped')",[network,uid]);
    const edit=await rest(scoped.token!,"PATCH",`/api/scheduled-tasks/${scheduleId}`,{revision:state(scheduleId).revision,schedule:{type:"interval",every_seconds:120,requirement_wake:{tag:"ANet"}}}); expect(edit.status).toBe(200);
    const before=state(scheduleId); await card(); expect(poll(scheduleId)).toBe(false); expect(state(scheduleId).revision).toBe(before.revision);
    await card({participants:[{kind:"user",id:uid}]}); expect(poll(scheduleId)).toBe(true);
    const project=await rest(ownerToken,"POST","/api/requirements/projects",{network_id:network,name:"hidden1279"}); expect(project.status).toBe(201);
    expect((await rest(scoped.token!,"PATCH",`/api/scheduled-tasks/${scheduleId}`,{revision:state(scheduleId).revision,schedule:{type:"interval",every_seconds:120,requirement_wake:{project_id:project.body.project.id}}})).status).toBe(400);
  });
  test("manual wake rebases pending events so a stale event cannot reset again",async()=>{
    const {scheduleId}=await atThree();await card();const before=state(scheduleId);
    const out=await rest(ownerToken,"POST",`/api/scheduled-tasks/${scheduleId}/run-now`);expect(out.status).toBe(202);
    expect(state(scheduleId).revision).toBe(before.revision+1);expect(poll(scheduleId)).toBe(false);
  });
  test("bounded cursor pages do not lose a later matching event",async()=>{
    const c=await card(),{scheduleId}=await atThree(),revision=state(scheduleId).revision;
    db.transaction(()=>{for(let i=0;i<270;i++)db.run("INSERT INTO requirement_events(network_id,requirement_id,actor_json,kind,new_json,created_at) VALUES(?1,?2,?3,'comment','{}',datetime('now'))",[network,c.id,JSON.stringify({kind:"user",id:ownerId})]);});
    await card();expect(poll(scheduleId)).toBe(false);expect(state(scheduleId).revision).toBe(revision);
    expect(poll(scheduleId)).toBe(true);expect(state(scheduleId).revision).toBe(revision+1);expect(poll(scheduleId)).toBe(false);
  });
  test("two independent SQLite processes consume the event once and persist one generation",async()=>{
    const {scheduleId}=await atThree();await card();const before=state(scheduleId), gate=`/tmp/wake1279-${crypto.randomUUID()}`;
    const code=`import {consumeRequirementWake} from './server/src/scheduled-requirement-wake.ts'; import {existsSync} from 'node:fs'; console.log('READY'); while(!existsSync(${JSON.stringify(gate)}))await Bun.sleep(10); for(let i=0;;i++){try{console.log(JSON.stringify({wake:consumeRequirementWake(${JSON.stringify(scheduleId)},${JSON.stringify(network)})})); break;}catch(e){if(i>=4||!String(e).includes('locked'))throw e;await Bun.sleep(20);}}`;
    const workers=[] as any[];
    // Initialize each adapter before releasing both against the same DB;
    // schema startup is not the race under qualification.
    for(let i=0;i<2;i++){
      const child=Bun.spawn([process.execPath,"-e",code],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe",env:process.env});
      // #1279: the child's stderr used to be piped and never read, so a worker that
      // exited non-zero below left only "Received: 1" — no reason at all. Drain it in
      // parallel and surface it when the exit code is not 0.
      const errChunks:string[]=[];
      const drain=(async()=>{const r=child.stderr.getReader();for(;;){const part=await r.read();if(part.done)break;errChunks.push(new TextDecoder().decode(part.value));}})();
      const reader=child.stdout.getReader();let start="";
      for(;;){const part=await reader.read();if(part.done)throw new Error('worker exited before ready');start+=new TextDecoder().decode(part.value);if(start.includes('READY'))break;}
      workers.push({child,reader,start,stderr:()=>errChunks.join(''),drain});
    }
    await Bun.write(gate,"go");const results=[];
    for(const w of workers){let output=w.start;for(;;){const part=await w.reader.read();if(part.done)break;output+=new TextDecoder().decode(part.value);}
      const code=await w.child.exited;await w.drain;
      // Show the worker's own words on failure instead of a bare exit code.
      expect({exit:code,stderr:w.stderr().trim().slice(0,800)}).toEqual({exit:0,stderr:""});
      results.push(JSON.parse(output.trim().split("\n").at(-1)!).wake);}
    expect(results.sort()).toEqual([false,true]);expect(state(scheduleId).revision).toBe(before.revision+1);expect(poll(scheduleId)).toBe(false);
  // #2198:显式预算。这条用例要起 2 个 Node 子进程、各自打开同一个磁盘 SQLite,
  // 再用 /tmp 上的 gate 文件对齐起跑。默认 5s 在机器繁忙时会被打满,而**超时与断言
  // 失败在报告里长得一样**(都只是一行 (fail)):实测 8 路并发 + 3× CPU 超订时,
  // 11 轮里有 2 轮红,但每次红的都是 `timed out after 5000ms`,而 trues 恒为 1、
  // revision 恒只 +1 —— 语义一直是对的,是预算不够。
  // 这里只放宽**时间**,不放宽任何断言(仍然 [false,true]、仍然 revision+1、仍然 poll false)。
  }, 30_000);

});
