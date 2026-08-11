import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { CommHubError } from "../../agent-node/src/reply-reliability.js";
import { sendPeerReplyCompatible } from "../../agent-node/src/peer-reply-send.js";
import { sendPeerReplyTaskWithTrace } from "../../agent-node/src/peer-reply-task-trace.js";
import { __resetSSEClientsForTest, createSSEStream } from "./push.js";
import { eventBus } from "./event_bus.js";

const NET = "net_peer_reply_698";
const USER = "user_peer_reply_698";
const A = "peer-a-698";
const B = "peer-b-698";
const A_ID = "node-peer-a-698";
const B_ID = "node-peer-b-698";

type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  __resetSSEClientsForTest();
  try { db.exec("DROP TRIGGER IF EXISTS test698_abort_terminal"); } catch {}
  try { db.exec("DROP TRIGGER IF EXISTS test698_abort_run"); } catch {}
  for (const table of ["scheduled_task_runs", "scheduled_tasks", "tasks", "inbox", "task_events", "sessions", "api_tokens", "nodes", "rename_txn"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
}

function seed() {
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))", [USER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))", [NET, USER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [USER, NET]);
  for (const [alias, nodeId] of [[A, A_ID], [B, B_ID]] as const) {
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, config_snapshot, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', ?4, datetime('now'), datetime('now'), 'active')",
      [nodeId, alias, NET, JSON.stringify({ peer_reply_inbox_capable: true })],
    );
    db.run(
      "INSERT INTO sessions (resume_id, alias, status, node_id, network_id, peer_reply_inbox_capable, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, 1, datetime('now'), datetime('now'))",
      [`resume-${alias}`, alias, nodeId, NET],
    );
    createSSEStream(alias, NET);
    db.run(
      "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id) VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6)",
      [`token-${alias}`, `hash-token-${alias}`, USER, NET, `node:${alias}`, nodeId],
    );
  }
}

function toolsFor(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "peer-reply-698", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const original = server.tool.bind(server);
  server.tool = (name: string, description: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return original(name, description, schema, handler);
  };
  registerTools(server, undefined, NET, USER, alias, true, `token-${alias}`);
  return tools;
}

async function call(handler: ToolHandler, args: any) {
  const result = await handler(args);
  return JSON.parse(result.content[0].text);
}

async function callOrThrow(handler: ToolHandler, args: any) {
  const payload = await call(handler, args);
  if (payload?.ok === false) {
    throw new CommHubError(`app-level rejection: ${payload.error}`, {
      code: payload.error,
      payload,
      appLevel: true,
    });
  }
  return payload;
}

async function dispatch(from: string, to: string, content: string): Promise<string> {
  const sent = await call(toolsFor(from).send_task, { alias: to, task: content, priority: "normal" });
  expect(sent.ok).toBe(true);
  return sent.task_id ?? sent.message_id;
}

function task(taskId: string) {
  return db.get<any>("SELECT * FROM tasks WHERE task_id = ?1", taskId);
}

function replies(taskId: string) {
  return db.all<any>("SELECT * FROM inbox WHERE in_reply_to = ?1 ORDER BY rowid", taskId);
}

function bindScheduledRun(taskId: string): { runId: string; scheduleId: string } {
  const suffix = crypto.randomUUID();
  const runId = `srun_${suffix}`;
  const scheduleId = `sched_${suffix}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, 'peer reply schedule', ?3, ?4, 'scheduled peer task', 'normal',
             'interval', '{"type":"interval","every_seconds":3600}', 'UTC', 'active', datetime('now', '+1 hour'))`,
    [scheduleId, NET, B_ID, B],
  );
  db.run(
    `INSERT INTO scheduled_task_runs
       (run_id, schedule_id, network_id, scheduled_for, task_id, status, completed_at)
     VALUES (?1, ?2, ?3, datetime('now'), ?4, 'delivered', NULL)`,
    [runId, scheduleId, NET, taskId],
  );
  return { runId, scheduleId };
}

beforeEach(() => { cleanup(); seed(); });
afterAll(cleanup);

describe("#698 atomic peer reply", () => {
  test("exact bound token works even when sessions.node_id is NULL", async () => {
    const taskId = await dispatch(A, B, "session row is not identity");
    db.run("UPDATE sessions SET node_id = NULL WHERE alias = ?1 AND network_id = ?2", [B, NET]);
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A, text: "bound-token wins", in_reply_to: taskId, status: "replied",
    });
    expect(result.ok).toBe(true);
    expect(task(taskId).status).toBe("replied");
  });

  test("a rollback heartbeat clears the current-session capability before any peer write", async () => {
    const tools = toolsFor(A);
    await call(tools.report_status, {
      resume_id: `resume-${A}`, alias: A, status: "idle", node_id: A_ID,
      config_snapshot: { config_update_capable: true, peer_reply_inbox_capable: true },
    });
    expect(db.get<any>(
      "SELECT peer_reply_inbox_capable FROM sessions WHERE alias = ?1 AND network_id = ?2",
      A, NET,
    ).peer_reply_inbox_capable).toBe(1);
    await call(tools.report_status, {
      resume_id: `resume-${A}`, alias: A, status: "idle", node_id: A_ID,
      config_snapshot: { config_update_capable: true },
    });
    expect(db.get<any>(
      "SELECT peer_reply_inbox_capable FROM sessions WHERE alias = ?1 AND network_id = ?2",
      A, NET,
    ).peer_reply_inbox_capable).toBe(0);

    const taskId = await dispatch(A, B, "recipient rolled back");
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A, text: "must use legacy", in_reply_to: taskId, status: "replied",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "peer_reply_unsupported" }));
    expect(task(taskId).status).toBe("delivered");
    expect(replies(taskId)).toHaveLength(0);
  });

  test("a capable but disconnected recipient fails toward legacy with zero writes", async () => {
    const taskId = await dispatch(A, B, "recipient disconnected");
    __resetSSEClientsForTest();
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A, text: "must use legacy", in_reply_to: taskId, status: "replied",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "peer_reply_unsupported" }));
    expect(task(taskId).status).toBe("delivered");
    expect(replies(taskId)).toHaveLength(0);
  });

  test("origin rename during work routes the terminal reply to the canonical alias and stable node", async () => {
    const taskId = await dispatch(A, B, "origin will rename");
    const renamed = `${A}-renamed`;
    db.run(
      `INSERT INTO rename_txn (txn_id, network_id, old_alias, new_alias, status, committed_at)
       VALUES (?1, ?2, ?3, ?4, 'committed', datetime('now'))`,
      [`rtxn-${crypto.randomUUID()}`, NET, A, renamed],
    );
    db.run("UPDATE nodes SET alias = ?1 WHERE node_id = ?2 AND network_id = ?3", [renamed, A_ID, NET]);
    db.run("UPDATE sessions SET alias = ?1 WHERE node_id = ?2 AND network_id = ?3", [renamed, A_ID, NET]);
    eventBus.emit("rename-committed", {
      networkId: NET, old_alias: A, new_alias: renamed, node_id: A_ID,
    });
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A, text: "reply after rename", in_reply_to: taskId, status: "replied",
    });
    expect(result.ok).toBe(true);
    expect(task(taskId).status).toBe("replied");
    expect(replies(taskId)).toEqual([
      expect.objectContaining({ session_name: renamed, node_id: A_ID, requires_response: "none" }),
    ]);
  });

  test("legacy caller or recipient capability downgrade returns unsupported with zero writes", async () => {
    for (const mode of ["caller-unbound", "recipient-downgraded", "legacy-task-origin"] as const) {
      cleanup(); seed();
      const taskId = await dispatch(A, B, `compat-${mode}`);
      if (mode === "caller-unbound") {
        db.run("UPDATE api_tokens SET bound_node_id = NULL WHERE token_id = ?1", `token-${B}`);
      } else if (mode === "recipient-downgraded") {
        db.run("UPDATE sessions SET peer_reply_inbox_capable = 0 WHERE node_id = ?1 AND network_id = ?2", [A_ID, NET]);
      } else {
        db.run("UPDATE tasks SET from_node_id = NULL WHERE task_id = ?1", taskId);
      }
      const result = await call(toolsFor(B).send_peer_reply, {
        alias: A, text: "must fall back", in_reply_to: taskId, status: "replied",
      });
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: mode === "legacy-task-origin" ? "peer_reply_origin_not_node" : "peer_reply_unsupported",
        reply_queued: false,
      }));
      expect(task(taskId)).toEqual(expect.objectContaining({ status: "delivered", result: null }));
      expect(replies(taskId)).toHaveLength(0);
    }
  });

  test("new sender falls back exactly once for an old Hub or legacy recipient", async () => {
    for (const mode of ["old-hub", "legacy-recipient"] as const) {
      cleanup(); seed();
      const taskId = await dispatch(A, B, `mixed-${mode}`);
      if (mode === "legacy-recipient") {
        db.run("UPDATE sessions SET peer_reply_inbox_capable = 0 WHERE node_id = ?1 AND network_id = ?2", [A_ID, NET]);
      }
      const tools = toolsFor(B);
      let atomicCalls = 0;
      let legacyCalls = 0;
      const routed = await sendPeerReplyCompatible({
        target: A, text: `fallback-${mode}`, taskId, failed: false, fromAlias: B,
      }, {
        sendAtomic: async (args) => {
          atomicCalls++;
          if (mode === "old-hub") {
            throw new CommHubError("JSON-RPC error: -32601: unknown tool send_peer_reply", { code: -32601 });
          }
          return callOrThrow(tools.send_peer_reply, {
            alias: args.target, text: args.text, in_reply_to: args.taskId, status: "replied",
          });
        },
        sendLegacy: async (args) => {
          legacyCalls++;
          return sendPeerReplyTaskWithTrace({
            alias: args.target, task: args.text, priority: "normal",
            fromAlias: B, parentTaskId: args.taskId, networkId: NET,
            meta: {
              peer_reply_legacy_fallback: true,
              peer_reply_fallback_reason: args.fallbackReason,
            },
          }, {
            log: () => {},
            send: (legacyArgs) => callOrThrow(tools.send_task, legacyArgs),
          });
        },
        sendLegacyReply: async () => {
          throw new Error("node-to-node capability fallback must not use send_reply");
        },
        isOldHubTargetAgent: async () => true,
      });
      expect(routed.route).toBe("legacy");
      expect([atomicCalls, legacyCalls]).toEqual([1, 1]);
      expect(task(taskId).status).toBe("delivered");
      expect(replies(taskId)).toHaveLength(0);
      expect(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?1 AND requires_response = 'reply'",
        taskId,
      )?.n).toBe(1);
      const legacyTask = db.get<{ meta_json: string }>(
        "SELECT meta_json FROM tasks WHERE parent_task_id = ?1",
        taskId,
      );
      expect(JSON.parse(legacyTask!.meta_json)).toEqual(expect.objectContaining({
        peer_reply_legacy_fallback: true,
        peer_reply_fallback_reason: mode === "old-hub"
          ? "old_hub_unknown_tool"
          : "recipient_unsupported",
      }));
    }
  });

  test("node-id rotation leaves atomic state untouched and creates one marked legacy fallback", async () => {
    const taskId = await dispatch(A, B, "rotate B after dispatch");
    const rotatedNodeId = `${B_ID}-rotated`;
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, config_snapshot, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host-rotated', ?4, datetime('now'), datetime('now'), 'active')",
      [rotatedNodeId, B, NET, JSON.stringify({ peer_reply_inbox_capable: true })],
    );
    db.run("UPDATE api_tokens SET bound_node_id = ?1 WHERE token_id = ?2", [rotatedNodeId, `token-${B}`]);
    db.run("UPDATE sessions SET node_id = ?1 WHERE alias = ?2 AND network_id = ?3", [rotatedNodeId, B, NET]);

    const tools = toolsFor(B);
    let atomicCalls = 0;
    let legacyCalls = 0;
    const routed = await sendPeerReplyCompatible({
      target: A, text: "result after identity rotation", taskId, failed: false, fromAlias: B,
    }, {
      sendAtomic: async (args) => {
        atomicCalls++;
        return callOrThrow(tools.send_peer_reply, {
          alias: args.target, text: args.text, in_reply_to: args.taskId, status: "replied",
        });
      },
      sendLegacy: async (args) => {
        legacyCalls++;
        return sendPeerReplyTaskWithTrace({
          alias: args.target, task: args.text, priority: "normal",
          fromAlias: B, parentTaskId: args.taskId, networkId: NET,
          meta: {
            peer_reply_legacy_fallback: true,
            peer_reply_fallback_reason: args.fallbackReason,
          },
        }, {
          log: () => {},
          send: (legacyArgs) => callOrThrow(tools.send_task, legacyArgs),
        });
      },
      sendLegacyReply: async () => {
        throw new Error("identity rotation fallback must not use send_reply");
      },
      isOldHubTargetAgent: async () => true,
    });

    expect(routed.route).toBe("legacy");
    expect([atomicCalls, legacyCalls]).toEqual([1, 1]);
    expect(task(taskId)).toEqual(expect.objectContaining({ status: "delivered", result: null }));
    expect(replies(taskId)).toHaveLength(0);
    const fallback = db.get<{ meta_json: string; requires_response: string }>(
      "SELECT meta_json, requires_response FROM tasks WHERE parent_task_id = ?1", taskId,
    );
    expect(fallback?.requires_response).toBe("reply");
    expect(JSON.parse(fallback!.meta_json)).toEqual(expect.objectContaining({
      peer_reply_legacy_fallback: true,
      peer_reply_fallback_reason: "identity_changed",
    }));
  });

  test("owner node terminalizes exact original and emits one no-response reply without a task row", async () => {
    const taskId = await dispatch(A, B, "do work");
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A,
      text: "done exactly once",
      in_reply_to: taskId,
      status: "replied",
    });
    expect(result.ok).toBe(true);
    expect(task(taskId)).toEqual(expect.objectContaining({ status: "replied", result: "done exactly once" }));
    expect(task(taskId).completed_at).toBeTruthy();
    expect(replies(taskId)).toHaveLength(1);
    expect(replies(taskId)[0]).toEqual(expect.objectContaining({
      session_name: A,
      node_id: A_ID,
      type: "reply",
      requires_response: "none",
      content: "done exactly once",
    }));
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?1", taskId)?.n).toBe(0);
  });

  test("terminal replay is rejected and cannot deliver twice", async () => {
    const taskId = await dispatch(A, B, "idempotent work");
    const handler = toolsFor(B).send_peer_reply;
    expect((await call(handler, { alias: A, text: "first", in_reply_to: taskId, status: "replied" })).ok).toBe(true);
    const replay = await call(handler, { alias: A, text: "second", in_reply_to: taskId, status: "replied" });
    expect(replay).toEqual(expect.objectContaining({ ok: false, error: "reply_task_terminal", reply_queued: false }));
    expect(task(taskId).result).toBe("first");
    expect(replies(taskId)).toHaveLength(1);
  });

  test("all declared peer reply outcomes become exact terminal task states", async () => {
    for (const status of ["replied", "failed", "cancelled"] as const) {
      const taskId = await dispatch(A, B, `terminal-${status}`);
      const result = await call(toolsFor(B).send_peer_reply, {
        alias: A,
        text: `result-${status}`,
        in_reply_to: taskId,
        status,
      });
      expect(result.ok).toBe(true);
      expect(task(taskId)).toEqual(expect.objectContaining({
        status,
        result: `result-${status}`,
      }));
      expect(task(taskId).completed_at).toBeTruthy();
      expect(replies(taskId)).toHaveLength(1);
      expect(replies(taskId)[0].requires_response).toBe("none");
    }
  });

  test("foreign node and wrong origin target are rejected with zero writes", async () => {
    const taskId = await dispatch(A, B, "owned by B");
    const foreign = await call(toolsFor(A).send_peer_reply, { alias: A, text: "forge", in_reply_to: taskId, status: "replied" });
    expect(foreign).toEqual(expect.objectContaining({ ok: false, error: "reply_task_not_owned" }));
    const wrongTarget = await call(toolsFor(B).send_peer_reply, { alias: B, text: "misroute", in_reply_to: taskId, status: "replied" });
    expect(wrongTarget).toEqual(expect.objectContaining({ ok: false, error: "reply_target_mismatch" }));
    expect(task(taskId).status).toBe("delivered");
    expect(replies(taskId)).toHaveLength(0);
  });

  test("task update failure rolls back the reply inbox insert", async () => {
    const taskId = await dispatch(A, B, "atomic failure");
    db.exec(`CREATE TRIGGER test698_abort_terminal BEFORE UPDATE OF status ON tasks
      WHEN OLD.task_id = '${taskId}' BEGIN SELECT RAISE(ABORT, 'test698 injected'); END`);
    await expect(call(toolsFor(B).send_peer_reply, {
      alias: A,
      text: "must rollback",
      in_reply_to: taskId,
      status: "replied",
    })).rejects.toThrow("test698 injected");
    expect(task(taskId).status).toBe("delivered");
    expect(task(taskId).result).toBeNull();
    expect(replies(taskId)).toHaveLength(0);
  });

  test("node-token peer reply terminalizes the exact scheduled run in the same transaction", async () => {
    const taskId = await dispatch(A, B, "scheduled work");
    const { runId } = bindScheduledRun(taskId);
    const result = await call(toolsFor(B).send_peer_reply, {
      alias: A, text: "scheduled done", in_reply_to: taskId, status: "replied",
    });
    expect(result.ok).toBe(true);
    expect(task(taskId).status).toBe("replied");
    expect(db.get<any>("SELECT status, completed_at FROM scheduled_task_runs WHERE run_id = ?1", runId))
      .toEqual(expect.objectContaining({ status: "replied" }));
  });

  test("scheduled-run write failure rolls back task and reply inbox together", async () => {
    const taskId = await dispatch(A, B, "scheduled rollback");
    const { runId } = bindScheduledRun(taskId);
    db.exec(`CREATE TRIGGER test698_abort_run BEFORE UPDATE OF status ON scheduled_task_runs
      WHEN OLD.run_id = '${runId}' BEGIN SELECT RAISE(ABORT, 'test698 injected run'); END`);
    await expect(call(toolsFor(B).send_peer_reply, {
      alias: A, text: "must all roll back", in_reply_to: taskId, status: "replied",
    })).rejects.toThrow("test698 injected run");
    expect(task(taskId).status).toBe("delivered");
    expect(db.get<any>("SELECT status FROM scheduled_task_runs WHERE run_id = ?1", runId)?.status).toBe("delivered");
    expect(replies(taskId)).toHaveLength(0);
  });

  test("three exchanges leave only dispatched work rows and no open tasks", async () => {
    for (let i = 0; i < 3; i++) {
      const taskId = await dispatch(A, B, `work-${i}`);
      expect((await call(toolsFor(B).send_peer_reply, {
        alias: A,
        text: `result-${i}`,
        in_reply_to: taskId,
        status: "replied",
      })).ok).toBe(true);
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1", NET)?.n).toBe(3);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND status IN ('created','delivered','acked','running')", NET)?.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1 AND type = 'reply' AND requires_response = 'none'", NET)?.n).toBe(3);
  });
});
