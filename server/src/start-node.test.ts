import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { handleStartDoorbell } from "../../agent-node/src/runtime/start-daemon.js";
import { lifecycleRequestResponse } from "./node-lifecycle-read.js";
import { z } from "zod/v4";
import { createCodexForkCapabilityMonitor } from "../../agent-node/src/runtime/codex-fork-capability.js";
import { attachCodexForkCapability, buildConfigSnapshot } from "../../agent-node/src/runtime/config-apply.js";

const NET = "net_start_node"; const USER = "u_start_node";
const DAEMON = "node_start_daemon"; const DAEMON_ALIAS = "start-daemon";
const CHILD = "node_start_child"; const CHILD_ALIAS = "start-child";

function cleanup() {
  for (const table of ["node_start_requests", "node_create_requests", "audit_log", "nodes", "api_tokens", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id=?1", USER); } catch {}
}
beforeEach(() => { cleanup();
  db.run(`INSERT INTO users(user_id,username,password_hash,role,created_at) VALUES(?1,?1,'x','user',datetime('now'))`, USER);
  db.run(`INSERT INTO networks(network_id,network_name,owner_id,created_at) VALUES(?1,?1,?2,datetime('now'))`, [NET, USER]);
  db.run(`INSERT INTO network_members(user_id,network_id,role,joined_at) VALUES(?1,?2,'owner',datetime('now'))`, [USER, NET]);
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot,hostname,created_at,updated_at,lifecycle_state) VALUES(?1,?2,?2,?3,'{}','h',datetime('now'),datetime('now'),'active')`, [DAEMON, DAEMON_ALIAS, NET]);
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot,hostname,created_at,updated_at,lifecycle_state) VALUES(?1,?2,?2,?3,'{}','h',datetime('now'),datetime('now'),'stopped')`, [CHILD, CHILD_ALIAS, NET]);
  db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES('tok_start_daemon',?1,?2,'network',?3,'h')`, [USER, NET, `node:${DAEMON_ALIAS}`]);
  db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token,child_node_id) VALUES('cr_start_child',?1,?2,?3,'codex-sdk','x','{}','[]','succeeded',1,'t',?4)`, [DAEMON, CHILD_ALIAS, NET, CHILD]);
});
afterAll(cleanup);

function handlers(user: string | null, daemon = false) {
  const s = new McpServer({ name: "t", version: "0" }) as any; const out: any = { $schemas: {} };
  const orig = s.tool.bind(s); s.tool = (n: string, d: string, schema: any, h: any) => { out[n] = h; out.$schemas[n] = schema; return orig(n,d,schema,h); };
  registerTools(s, undefined, daemon ? NET : null, user, null, daemon, daemon ? "tok_start_daemon" : null); return out;
}
async function call(h: any, args: any) { return JSON.parse((await h(args)).content[0].text); }

describe("confirmed fork request/result transport (#822)", () => {
  const recovery = { kind: "fork_on_missing_ordinal", confirmed: true };
  const forked = { state: "forked", old_thread_id: "01a11846-d796-72f1-af68-8d9215a65dc8",
    new_thread_id: "01a11900-0000-7000-8000-000000000001" };
  function enable() {
    db.run(`UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2`, [JSON.stringify({ role: "host_supervisor",
      daemon_capabilities: { codex_fork_recovery: { protocol: 1, cli_supported: true } } }), DAEMON]);
  }
  function read(requestId: string, networkId = NET) {
    return lifecycleRequestResponse(new URL(`http://hub/api/node-lifecycle-requests?kind=start&request_id=${requestId}`),
      { networkId, networkIds: null });
  }
  test("real capability probe survives report schema/storage and opens only the recovery gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "fork-capability-report-"));
    try {
      const bin = join(root, "anet-fixture");
      writeFileSync(bin, `#!${process.execPath}\nconsole.log('--fork-on-resume-failure --fork-recovery-request-id <str_id> --yes');`, { mode: 0o700 });
      const monitor = createCodexForkCapabilityMonitor({ bin: () => bin, cwd: root });
      await monitor.refresh();
      const d = handlers(null, true), u = handlers(USER);
      const snapshot = attachCodexForkCapability(buildConfigSnapshot({ role: "host_supervisor" }, false, 0), monitor.current());
      const wire = z.object(d.$schemas.report_status).parse({ alias: DAEMON_ALIAS, node_id: DAEMON,
        resume_id: "fork-capability-daemon", status: "idle", config_snapshot: snapshot });
      await call(d.report_status, wire);
      const stored = JSON.parse(db.get<any>(`SELECT config_snapshot FROM nodes WHERE node_id=?1`, DAEMON).config_snapshot);
      expect(stored.daemon_capabilities.codex_fork_recovery).toEqual({ protocol: 1, cli_supported: true });
      expect((await call(u.start_node, { node_id: CHILD, fork_recovery: recovery })).ok).toBe(true);
      // Bad diagnostics are dropped, not a reason to reject the entire heartbeat.
      for (const bad of [null, { protocol: 2, cli_supported: true }, { protocol: 1, cli_supported: "yes" }]) {
        const parsed = d.$schemas.report_status.config_snapshot.parse({ ...snapshot,
          daemon_capabilities: { can_create_nodes: true, codex_fork_recovery: bad } });
        expect(parsed.daemon_capabilities.can_create_nodes).toBe(true);
        expect(parsed.daemon_capabilities.codex_fork_recovery).toBeUndefined();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("requires explicit confirmation and affirmative capability before creating any request", async () => {
    const u = handlers(USER);
    for (const value of [null, {}, { ...recovery, confirmed: false }]) {
      expect((await call(u.start_node, { node_id: CHILD, fork_recovery: value })).error).toBe("codex_fork_confirmation_invalid");
    }
    expect((await call(u.start_node, { node_id: CHILD, fork_recovery: recovery })).error).toBe("codex_fork_recovery_unsupported");
    expect(db.all(`SELECT * FROM node_start_requests WHERE network_id=?1`, NET)).toEqual([]);
    expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD).lifecycle_state).toBe("stopped");
    enable();
    expect((await call(u.start_node, { node_id: CHILD, fork_recovery: recovery })).ok).toBe(true);
  });
  test("persists one confirmation and refuses old daemon pull without marking delivered", async () => {
    enable(); const u = handlers(USER), d = handlers(null, true);
    const { request_id } = await call(u.start_node, { node_id: CHILD, fork_recovery: recovery });
    expect((await call(d.get_start_request, { request_id })).error).toBe("codex_fork_recovery_unsupported");
    const row = db.get<any>(`SELECT * FROM node_start_requests WHERE request_id=?1`, request_id);
    expect(row.status).toBe("pending"); expect(JSON.parse(row.fork_recovery_json)).toEqual(recovery);
    expect(await call(d.get_start_request, { request_id, fork_recovery_capable: true })).toMatchObject({
      ok: true, request_id, managed: "created", fork_recovery: recovery,
    });
  });
  test.each([0, 7])("Hub → daemon → real CLI fixture exit %s → persisted fork and scoped read", async exitCode => {
    enable(); const u = handlers(USER), d = handlers(null, true);
    const { request_id } = await call(u.start_node, { node_id: CHILD, fork_recovery: recovery });
    const root = mkdtempSync(join(tmpdir(), "fork-flow-"));
    try {
      const nodeDir = join(root, CHILD_ALIAS); mkdirSync(nodeDir);
      writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: CHILD, alias: CHILD_ALIAS,
        runtime: "codex-app-server", codexCopresence: true }), { mode: 0o600 });
      const bin = join(root, "anet-fixture");
      // Real executable: validates argv, writes a CLI-shaped mapping and exits.
      // It is not a real Codex/model recovery test.
      writeFileSync(bin, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
        const args=process.argv.slice(2);
        if(args.join(' ')==='node start --help') { console.log('--fork-on-resume-failure --fork-recovery-request-id <str_id> --yes'); process.exit(0); }
        if(JSON.stringify(args)!==${JSON.stringify(JSON.stringify(["node", "start", CHILD_ALIAS, "--fork-on-resume-failure", "--yes", "--fork-recovery-request-id", request_id]))}) process.exit(99);
        writeFileSync(${JSON.stringify(join(nodeDir, "codex-fork-recovery.json"))},JSON.stringify({forks:[{requestId:${JSON.stringify(request_id)},oldThreadId:${JSON.stringify(forked.old_thread_id)},newThreadId:${JSON.stringify(forked.new_thread_id)},snapshot:'/private/snapshot'}]}));
        process.exit(${exitCode});`, { mode: 0o700 });
      await handleStartDoorbell({ request_id }, { workDir: root, nodesRoot: root, anetBin: () => bin,
        callCommHub: (tool, args) => call(d[tool], args), log() {}, warn() {} });
      const row = db.get<any>(`SELECT * FROM node_start_requests WHERE request_id=?1`, request_id);
      expect(row.status).toBe(exitCode === 0 ? "started" : "start_failed");
      expect(JSON.parse(row.fork_result_json)).toEqual(forked);
      const publicResult = await read(request_id).json();
      expect(publicResult.request.fork_recovery).toEqual({ requested: true, result: forked });
      expect(JSON.stringify(publicResult)).not.toContain("/private");
      expect(JSON.stringify(publicResult)).not.toContain("fork_result_json");
      expect(read(request_id, "net_unrelated").status).toBe(404);
      // Terminal replay must not overwrite the original side effect receipt.
      expect(await call(d.ack_start_request, { request_id, status: "start_failed", fork_recovery: { state: "not_observed" } }))
        .toMatchObject({ ok: true, idempotent: true });
      expect(JSON.parse(db.get<any>(`SELECT fork_result_json FROM node_start_requests WHERE request_id=?1`, request_id).fork_result_json)).toEqual(forked);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("missing result is unknown, malformed result rejected; ordinary receipts keep old shape", async () => {
    const u = handlers(USER), d = handlers(null, true);
    const ordinary = await call(u.start_node, { node_id: CHILD });
    expect((await call(d.ack_start_request, { request_id: ordinary.request_id, status: "start_failed", fork_recovery: forked })).error).toBe("codex_fork_result_invalid");
    await call(d.ack_start_request, { request_id: ordinary.request_id, status: "start_failed" });
    expect((await read(ordinary.request_id).json()).request).not.toHaveProperty("fork_recovery");
    enable(); const { request_id } = await call(u.start_node, { node_id: CHILD, fork_recovery: recovery });
    expect((await call(d.ack_start_request, { request_id, status: "start_failed", fork_recovery: { ...forked, snapshot: "/private" } })).error).toBe("codex_fork_result_invalid");
    await call(d.ack_start_request, { request_id, status: "start_failed", error: "codex_fork_cli_unsupported" });
    expect((await read(request_id).json()).request).toMatchObject({ error: "codex_fork_cli_unsupported",
      fork_recovery: { result: { state: "unknown", reason: "result_not_reported" } } });
    db.run(`UPDATE node_start_requests SET fork_result_json=?1 WHERE request_id=?2`, [JSON.stringify({ ...forked, snapshot: "/private" }), request_id]);
    expect((await read(request_id).json()).request.fork_recovery.result).toEqual({ state: "unknown", reason: "result_invalid" });
  });
  test("stale recovery cannot be silently superseded by the ordinary start reaper", async () => {
    enable(); const u = handlers(USER);
    const { request_id } = await call(u.start_node, { node_id: CHILD, fork_recovery: recovery });
    db.run(`UPDATE node_start_requests SET created_at=?1 WHERE request_id=?2`, [Date.now() - 70_000, request_id]);
    expect(await call(u.start_node, { node_id: CHILD })).toMatchObject({ ok: false,
      error: "codex_fork_outcome_unknown", existing_request_id: request_id });
    expect(db.get<any>(`SELECT status FROM node_start_requests WHERE request_id=?1`, request_id).status).toBe("pending");
  });
});

describe("start_node Hub -> daemon lifecycle", () => {
  test("dispatch, authenticated pull, ack transitions stopped -> starting -> active", async () => {
    const u = handlers(USER); const dispatch = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    expect(dispatch.ok).toBe(true); expect(dispatch.lifecycle_state).toBe("starting");
    const d = handlers(null, true); const pulled = await call(d.get_start_request, { request_id: dispatch.request_id });
    expect(pulled).toMatchObject({ ok: true, child_node_id: CHILD, child_alias: CHILD_ALIAS, start_completion_capable: true });
    const ack = await call(d.ack_start_request, { request_id: dispatch.request_id, status: "started", child_pid: 4321 });
    expect(ack.ok).toBe(true);
    expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD)?.lifecycle_state).toBe("active");
    expect(db.all<any>(`SELECT action FROM audit_log WHERE target_id=?1 ORDER BY id`, dispatch.request_id).map((x:any)=>x.action)).toEqual(["start_node_dispatched", "start_node_completed"]);
  });
  test("active child and caller-supplied wrong daemon fail closed", async () => {
    const u = handlers(USER);
    db.run(`UPDATE nodes SET lifecycle_state='active' WHERE node_id=?1`, CHILD);
    expect((await call(u.start_node, { child_node_id: CHILD, network_id: NET })).error).toBe("node_not_stopped");
    db.run(`UPDATE nodes SET lifecycle_state='stopped' WHERE node_id=?1`, CHILD);
    expect((await call(u.start_node, { child_node_id: CHILD, daemon_node_id: "node_wrong", network_id: NET })).error).toBe("daemon_child_mismatch");
  });
  test("launcher progress refreshes stale-start clock, never marks active, and failure stays stopped", async () => {
    const u = handlers(USER), d = handlers(null, true);
    const dispatch = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    const request_id = dispatch.request_id;
    await call(d.get_start_request, { request_id });
    db.run(`UPDATE node_start_requests SET created_at=?1, delivered_at=?1 WHERE request_id=?2`, [Date.now() - 70_000, request_id]);
    expect(await call(d.ack_start_request, { request_id, status: "starting" })).toEqual({ ok: true, status: "starting" });
    expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD)?.lifecycle_state).toBe("starting");
    expect(db.get<any>(`SELECT status FROM node_start_requests WHERE request_id=?1`, request_id)?.status).toBe("delivered");
    expect((await call(u.start_node, { child_node_id: CHILD, network_id: NET })).error).toBe("node_already_starting");
    expect(await call(d.ack_start_request, { request_id, status: "start_failed", error: "codex_launcher_exit:1" })).toEqual({ ok: true, status: "start_failed" });
    expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD)?.lifecycle_state).toBe("stopped");
    expect(db.all<any>(`SELECT action FROM audit_log WHERE target_id=?1`, request_id).map(r => r.action)).toEqual(["start_node_dispatched"]);
    // A heartbeat already in flight cannot resurrect a terminal request.
    expect(await call(d.ack_start_request, { request_id, status: "starting" })).toMatchObject({ status: "start_failed", idempotent: true });
  });
  test.each([0, 7])("dispatch → daemon → real launcher exit %s → Hub lifecycle", async (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "start-flow-"));
    try {
      mkdirSync(join(root, CHILD_ALIAS));
      writeFileSync(join(root, CHILD_ALIAS, "config.json"), JSON.stringify({ node_id: CHILD, alias: CHILD_ALIAS, codexCopresence: true }), { mode: 0o600 });
      const u = handlers(USER), d = handlers(null, true);
      const dispatch = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
      await handleStartDoorbell({ request_id: dispatch.request_id }, {
        workDir: root, nodesRoot: root, anetBin: () => process.execPath,
        spawnChild: ((_bin, _args, opts) => spawn(process.execPath, ["-e", `setTimeout(() => process.exit(${exitCode}), 25)`], opts)) as typeof spawn,
        callCommHub: (tool, args) => call(d[tool], args), log: () => {}, warn: () => {},
      });
      expect(db.get<any>(`SELECT status FROM node_start_requests WHERE request_id=?1`, dispatch.request_id)?.status).toBe(exitCode === 0 ? "started" : "start_failed");
      expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD)?.lifecycle_state).toBe(exitCode === 0 ? "active" : "stopped");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// #1448 finding-2 — stale-starting reaper（对齐 update_node_config/restart_node 的 60s
// single-flight stale-supersede）。start 只受理 stopped;卡在 starting 的节点(门铃丢 /
// daemon 在 UPDATE starting 后死)改前永远 start 不了(gate 返 node_not_stopped)、也无
// reaper 拉回 → 永久卡死。改后:in-flight start 请求晾过 60s ⇒ 标 timeout 超越 + 放行
// 重派;未过阈值 ⇒ 拒 node_already_starting。
describe("start_node — stale-starting reaper (#1448 finding-2)", () => {
  function seedStartReq(reqId: string, status: string, ageMs: number) {
    db.run(
      `INSERT INTO node_start_requests(request_id,network_id,daemon_node_id,child_node_id,child_alias,created_by_token,status,created_at)
       VALUES(?1,?2,?3,?4,?5,'t',?6,?7)`,
      [reqId, NET, DAEMON, CHILD, CHILD_ALIAS, status, Date.now() - ageMs],
    );
  }

  test("starting + FRESH in-flight start (< 60s) → refused node_already_starting (not superseded)", async () => {
    db.run(`UPDATE nodes SET lifecycle_state='starting' WHERE node_id=?1`, CHILD);
    seedStartReq("str_fresh", "delivered", 5_000);   // 5s old — within threshold
    const u = handlers(USER);
    const r = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("node_already_starting");
    expect(r.existing_request_id).toBe("str_fresh");
    expect(typeof r.age_ms).toBe("number");
    // old request untouched, no new dispatch
    expect(db.get<any>(`SELECT status FROM node_start_requests WHERE request_id='str_fresh'`)?.status).toBe("delivered");
  });

  // witnessed-red：改前 gate 直接 `!== 'stopped' → node_not_stopped`，一个 stale 的
  // 'starting' 节点返回 node_not_stopped、永远卡死。改后应超越重派(ok:true)。
  test("starting + STALE in-flight start (> 60s) → supersede old + re-dispatch (converges)", async () => {
    db.run(`UPDATE nodes SET lifecycle_state='starting' WHERE node_id=?1`, CHILD);
    seedStartReq("str_stale", "delivered", 61_000);   // 61s old — past 60s threshold
    const u = handlers(USER);
    const r = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    expect(r.ok).toBe(true);
    expect(r.lifecycle_state).toBe("starting");
    expect(typeof r.request_id).toBe("string");
    expect(r.request_id).not.toBe("str_stale");                       // fresh request
    // old stale request superseded → terminal, unblocks the child-inflight unique index
    expect(db.get<any>(`SELECT status FROM node_start_requests WHERE request_id='str_stale'`)?.status).toBe("timeout");
    // exactly one non-terminal start request now (the new one)
    const live = db.all<any>(`SELECT request_id FROM node_start_requests WHERE child_node_id=?1 AND status IN ('pending','delivered')`, CHILD);
    expect(live.map((x:any)=>x.request_id)).toEqual([r.request_id]);
    // audit records the real prior state
    const aud = db.get<any>(`SELECT detail FROM audit_log WHERE target_id=?1`, r.request_id);
    expect(JSON.parse(aud.detail).lifecycle_state_before).toBe("starting");
  });

  test("starting + NO in-flight row (orphaned state) → self-heals by re-dispatching", async () => {
    db.run(`UPDATE nodes SET lifecycle_state='starting' WHERE node_id=?1`, CHILD);
    const u = handlers(USER);
    const r = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    expect(r.ok).toBe(true);
    expect(r.lifecycle_state).toBe("starting");
  });
});
