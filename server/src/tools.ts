import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { db, uuidv4, logTaskEvent } from "./db.js";
import { pushEvent, pushBroadcast } from "./push.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function registerTools(server: McpServer, clientIP?: string, enforceNetworkId?: string | null) {
  // If enforceNetworkId is set, override any client-supplied network_id
  const getNetworkId = (clientNetId?: string | null) => enforceNetworkId ?? clientNetId ?? null;
  // ═══════════════════════════════════════════
  //  Child Agent Tools (4)
  // ═══════════════════════════════════════════

  server.tool(
    "report_status",
    "Report agent status. Returns inbox_count so you know if there are pending tasks.",
    {
      resume_id: z.string().min(1).max(200).describe("Claude Code session UUID (unique per session)"),
      alias: z.string().min(1).max(200).describe("Human-readable session name for dispatching (e.g. 指挥室/知识哥)"),
      status: z.enum(["working", "idle", "blocked", "error", "waiting_input", "offline"]),
      task: z.string().max(10000).optional().describe("Current task description"),
      output: z.string().max(50000).optional().describe("Recent output (max 4000 chars stored)"),
      score: z.number().min(0).max(10).optional().describe("Self-score 1-10"),
      progress: z.number().min(0).max(100).optional().describe("Progress 0-100"),
      server: z.string().max(200).optional().describe("Server identifier"),
      hostname: z.string().max(200).optional().describe("Agent hostname"),
      agent: z.string().max(100).optional().describe("Agent type (claude-code / codex / opencode)"),
      project_dir: z.string().max(1000).optional().describe("Agent working directory"),
      version: z.string().max(100).optional().describe("Agent version"),
      tmux_name: z.string().max(200).optional().describe("tmux session name"),
      // V2 fields
      node_id: z.string().max(200).optional().describe("Stable node identifier"),
      session_id: z.string().max(200).optional().describe("Runtime session/thread ID"),
      config_path: z.string().max(1000).optional().describe("Config file path"),
      channels: z.string().max(2000).optional().describe("JSON array of channels"),
      model: z.string().max(200).optional().describe("AI model name"),
      node_name: z.string().max(200).optional().describe("Stable node display name (may differ from alias)"),
      network_id: z.string().max(200).optional().describe("Network this agent belongs to"),
    },
    async ({ resume_id, alias, status, task, output, score, progress, server: srv, hostname: hn, agent: ag, project_dir: pd, version: ver, tmux_name: tmux, node_id, session_id, config_path, channels, model: mdl, node_name: nn, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      console.log(`[${ts()}] ${alias} (${resume_id.slice(0, 8)}) → report_status: ${status}${task ? " | " + task.slice(0, 60) : ""}${effectiveNetId ? " [net]" : ""}`);
      const trimmedOutput = output?.slice(0, 4000);

      try {
        db.run("BEGIN IMMEDIATE");
        // Only delete same-alias sessions within the same network (prevent cross-network alias conflict)
        if (effectiveNetId) {
          db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3", [alias, resume_id, effectiveNetId]);
        } else {
          db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2", [alias, resume_id]);
        }
        db.run(
          `INSERT INTO sessions (resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version, status, task, output, progress, score, node_id, session_id, config_path, channels, network_id, last_seen_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'), datetime('now'))
           ON CONFLICT(resume_id) DO UPDATE SET
             alias = COALESCE(?2, sessions.alias),
             tmux_name = COALESCE(?3, sessions.tmux_name),
             server = COALESCE(?4, sessions.server),
             ip = COALESCE(?5, sessions.ip),
             hostname = COALESCE(?6, sessions.hostname),
             agent = COALESCE(?7, sessions.agent),
             project_dir = COALESCE(?8, sessions.project_dir),
             version = COALESCE(?9, sessions.version),
             status = ?10,
             task = COALESCE(?11, sessions.task),
             output = COALESCE(?12, sessions.output),
             progress = COALESCE(?13, sessions.progress),
             score = COALESCE(?14, sessions.score),
             node_id = COALESCE(?15, sessions.node_id),
             session_id = COALESCE(?16, sessions.session_id),
             config_path = COALESCE(?17, sessions.config_path),
             channels = COALESCE(?18, sessions.channels),
             network_id = COALESCE(?19, sessions.network_id),
             last_seen_at = datetime('now'),
             updated_at = datetime('now')`,
          [resume_id, alias, tmux ?? null, srv ?? null, clientIP ?? null, hn ?? null, ag ?? null, pd ?? null, ver ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? null, score ?? null, node_id ?? null, session_id ?? null, config_path ?? null, channels ?? null, netId ?? null]
        );
        db.run("COMMIT");
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }

      // V2: sync tasks table — report_status(working) → tasks.running
      if (status === "working" && task) {
        try {
          const runResult = db.run(
            `UPDATE tasks SET status = 'running', started_at = datetime('now')
             WHERE to_name = ?1 AND status IN ('delivered', 'acked') AND content = ?2`,
            [alias, task]
          );
          if (runResult.changes > 0) {
            // Find task_id for logging
            const t = db.query<{ task_id: string }, [string, string]>(
              "SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2 AND status = 'running' ORDER BY started_at DESC LIMIT 1"
            ).get(alias, task);
            if (t) logTaskEvent(t.task_id, null, "running", alias);
          }
        } catch {}
      }

      // V2: upsert nodes table for persistent node identity
      if (node_id) {
        try {
          // Extract runtime from agent field (e.g., "agent-node:codex" → "codex-sdk")
          const nodeRuntime = ag?.includes(":") ? ag.split(":")[1] + "-sdk" : ag ?? null;
          db.run(
            `INSERT INTO nodes (node_id, node_name, alias, runtime, model, config_path, channels, server, hostname, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
             ON CONFLICT(node_id) DO UPDATE SET
               node_name = COALESCE(?2, nodes.node_name),
               alias = COALESCE(?3, nodes.alias),
               runtime = COALESCE(?4, nodes.runtime),
               model = COALESCE(?5, nodes.model),
               config_path = COALESCE(?6, nodes.config_path),
               channels = COALESCE(?7, nodes.channels),
               server = COALESCE(?8, nodes.server),
               hostname = COALESCE(?9, nodes.hostname),
               updated_at = datetime('now')`,
            [node_id, nn || alias, alias, nodeRuntime, mdl ?? null, config_path ?? null, channels ?? null, srv ?? null, hn ?? null]
          );
        } catch {}
      }

      // inbox uses alias for routing
      const row = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(alias);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              resume_id,
              alias,
              inbox_count: row?.cnt ?? 0,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "report_completion",
    "Report task completion with results and optional artifacts.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      task: z.string().min(1).max(10000).describe("Completed task description"),
      result: z.string().min(1).max(50000).describe("Result summary"),
      artifacts: z.array(z.string().max(2000)).max(50).optional().describe("Output URLs or file paths"),
      score: z.number().min(0).max(10).optional(),
      duration_minutes: z.number().min(0).optional(),
    },
    async ({ alias, task, result, artifacts, score, duration_minutes }) => {
      console.log(`[${ts()}] ${alias} → report_completion: ${task.slice(0, 60)}`);
      const id = uuidv4();
      try {
        db.run("BEGIN IMMEDIATE");
        db.run(
          `INSERT INTO completions (id, session_name, task, result, artifacts, score, duration_minutes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          [id, alias, task, result, artifacts ? JSON.stringify(artifacts) : null, score ?? null, duration_minutes ?? null]
        );

        db.run(
          `UPDATE sessions SET status = 'idle', task = NULL, progress = 0, updated_at = datetime('now')
           WHERE alias = ?1`,
          [alias]
        );

        // V2: sync tasks table — try by task_id first, then by content
        const taskUpdate = db.run(
          `UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now')
           WHERE task_id = ?2 AND status IN ('delivered', 'acked', 'running')`,
          [result.slice(0, 4000), task]
        );
        if (taskUpdate.changes === 0) {
          // fallback: match most recent task by to_name + content (legacy path)
          const match = db.query<{ task_id: string }, [string, string]>(
            `SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2
             AND status IN ('delivered', 'acked', 'running') ORDER BY created_at DESC LIMIT 1`
          ).get(alias, task);
          if (match) {
            db.run(
              `UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now')
               WHERE task_id = ?2`,
              [result.slice(0, 4000), match.task_id]
            );
          }
        }

        db.run("COMMIT");
        // Log event after commit
        const updatedTaskId = taskUpdate.changes > 0 ? task : (db.query<{ task_id: string }, [string]>(
          "SELECT task_id FROM tasks WHERE to_name = ?1 AND status = 'replied' ORDER BY completed_at DESC LIMIT 1"
        ).get(alias)?.task_id);
        if (updatedTaskId) logTaskEvent(updatedTaskId, null, "replied", alias, "report_completion");
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completion_id: id }) }],
      };
    }
  );

  server.tool(
    "get_inbox",
    "Get pending commands for your session.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      limit: z.number().min(1).max(100).optional().default(10),
    },
    async ({ alias, limit }) => {
      const rows0 = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(alias);
      console.log(`[${ts()}] ${alias} → get_inbox: ${rows0?.cnt ?? 0} pending messages`);
      const rows = db.query<any, [string, number]>(
        `SELECT id, type, priority, content, context, from_session, created_at
         FROM inbox WHERE session_name = ?1 AND acked = 0
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         LIMIT ?2`
      ).all(alias, limit);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, messages: rows }) }],
      };
    }
  );

  server.tool(
    "ack_inbox",
    "Acknowledge receipt of a command.",
    {
      alias: z.string().min(1).max(200).describe("Session alias"),
      message_id: z.string().min(1).max(200),
      response: z.string().max(10000).optional(),
    },
    async ({ alias, message_id, response }) => {
      console.log(`[${ts()}] ${alias} → ack_inbox: ${message_id.slice(0, 8)}`);
      const result = db.run("UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2", [message_id, alias]);
      if (result.changes === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "message not found or not yours" }) }],
        };
      }
      // V2: sync tasks table — ack_inbox means delivered→acked
      try {
        const ackResult = db.run(
          `UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status = 'delivered'`,
          [message_id]
        );
        if (ackResult.changes > 0) logTaskEvent(message_id, "delivered", "acked", alias);
      } catch {}
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  // ═══════════════════════════════════════════
  //  Hub Tools (5)
  // ═══════════════════════════════════════════

  server.tool(
    "get_all_status",
    "Get status of all sessions. Hub uses this for the patrol loop.",
    {
      filter_status: z.string().max(50).optional(),
      filter_server: z.string().max(200).optional(),
      network_id: z.string().max(200).optional().describe("Filter by network"),
    },
    async ({ filter_status, filter_server, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      console.log(`[${ts()}] hub → get_all_status${filter_status ? ": filter=" + filter_status : ""}${effectiveNetId ? " net=" + effectiveNetId.slice(0, 12) : ""}`);

      const sessions = db.transaction(() => {
        const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
        db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);

        let sql = "SELECT * FROM sessions WHERE 1=1";
        const params: any[] = [];
        if (effectiveNetId) { sql += " AND network_id = ?"; params.push(effectiveNetId); }
        if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }
        if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
        sql += " ORDER BY updated_at DESC";
        return db.query(sql).all(...params);
      })();

      const summary = db.query<any, []>(
        "SELECT status, COUNT(*) as count FROM sessions GROUP BY status"
      ).all();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, sessions, summary }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_session_status",
    "Get detailed status of a specific session by alias.",
    { alias: z.string().min(1).max(200).describe("Session alias") },
    async ({ alias }) => {
      console.log(`[${ts()}] hub → get_session_status: ${alias}`);
      const session = db.query("SELECT * FROM sessions WHERE alias = ?1").get(alias);
      const pending = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(alias);
      const recent = db.query(
        "SELECT * FROM completions WHERE session_name = ?1 ORDER BY completed_at DESC LIMIT 5"
      ).all(alias);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, session, inbox_pending: pending?.cnt ?? 0, recent_completions: recent }),
          },
        ],
      };
    }
  );

  server.tool(
    "send_task",
    "Dispatch a task to a session's inbox (by alias).",
    {
      alias: z.string().min(1).max(200).describe("Target session alias"),
      task: z.string().min(1).max(10000).describe("Task content"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      context: z.string().max(10000).optional(),
      from_session: z.string().max(200).optional().default("hub"),
      ttl_seconds: z.number().min(1).max(86400).optional().describe("Task TTL in seconds (default: 3600)"),
      network_id: z.string().max(200).optional().describe("Network scope"),
    },
    async ({ alias, task, priority, context, from_session, ttl_seconds, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);

      // License check
      const license = db.query<any, []>("SELECT type, expires_at FROM licenses ORDER BY created_at LIMIT 1").get();
      if (license?.expires_at) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (license.expires_at < now) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: false, error: "license_expired",
            message: "Trial expired. Activate a license: anet activate <key>",
          }) }] };
        }
      }

      console.log(`[${ts()}] ${from_session} → send_task → ${alias}: ${task.slice(0, 60)}${priority === "high" ? " [HIGH]" : ""}`);
      const id = uuidv4();
      // 事务：inbox + tasks 双写
      try {
        db.run("BEGIN IMMEDIATE");
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, context, from_session, requires_response, network_id)
           VALUES (?1, ?2, 'task', ?3, ?4, ?5, ?6, 'reply', ?7)`,
          [id, alias, priority, task, context ?? null, from_session, effectiveNetId]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id)
           VALUES (?1, ?2, ?3, ?4, 'delivered', ?5, 'reply', datetime('now'), datetime('now'), datetime('now', ?6), ?7)`,
          [id, from_session, alias, priority, task, `+${ttl_seconds || 3600} seconds`, effectiveNetId]
        );
        db.run("COMMIT");
        logTaskEvent(id, null, "delivered", from_session, `→ ${alias}`);
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }

      const session = db.query<any, [string]>("SELECT status FROM sessions WHERE alias = ?1").get(alias);

      // SSE push by alias
      const pending = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(alias);
      pushEvent(alias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority, from: from_session });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              session_status: session?.status ?? "unknown",
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a message to a session (no task lifecycle, just chat). Use for replies, status updates, or casual communication.",
    {
      alias: z.string().min(1).max(200).describe("Target session alias"),
      message: z.string().min(1).max(10000).describe("Message content"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ alias, message, from_session }) => {
      console.log(`[${ts()}] ${from_session} → send_message → ${alias}: ${message.slice(0, 60)}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
         VALUES (?1, ?2, 'message', 'normal', ?3, ?4)`,
        [id, alias, message, from_session]
      );

      const session = db.query<any, [string]>("SELECT status FROM sessions WHERE alias = ?1").get(alias);

      pushEvent(alias, { type: "new_message", message, from: from_session, message_id: id });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              session_status: session?.status ?? "unknown",
            }),
          },
        ],
      };
    }
  );

  // ── V2: send_reply (关联 task_id，不触发 think) ──
  server.tool(
    "send_reply",
    "Send a reply to a task. Linked to task_id via in_reply_to. Does NOT trigger agent processing.",
    {
      alias: z.string().min(1).max(200).describe("Target session alias"),
      text: z.string().min(1).max(10000).describe("Reply content"),
      in_reply_to: z.string().max(200).optional().describe("Original task/message ID"),
      status: z.enum(["replied", "failed", "cancelled"]).optional().default("replied").describe("Task outcome"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ alias, text, in_reply_to, status: replyStatus, from_session }) => {
      console.log(`[${ts()}] ${from_session} → send_reply (${replyStatus}) → ${alias}: ${text.slice(0, 60)}`);
      const id = uuidv4();
      let replyLogged = false;
      try {
        db.run("BEGIN IMMEDIATE");
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, in_reply_to, requires_response)
           VALUES (?1, ?2, 'reply', 'normal', ?3, ?4, ?5, 'none')`,
          [id, alias, text, from_session, in_reply_to ?? null]
        );

        // 更新 tasks 表
        if (in_reply_to) {
          const result = db.run(
            `UPDATE tasks SET status = ?1, result = ?2, completed_at = datetime('now')
             WHERE task_id = ?3 AND status IN ('created', 'delivered', 'acked', 'running')`,
            [replyStatus, text, in_reply_to]
          );
          if (result.changes === 0) {
            console.log(`[${ts()}] ⚠ send_reply: task ${in_reply_to?.slice(0, 8)} not found or already terminal`);
          } else {
            replyLogged = true;
          }
        }
        db.run("COMMIT");
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }

      // Log event after commit (outside transaction)
      if (replyLogged && in_reply_to) logTaskEvent(in_reply_to, null, replyStatus, from_session, text.slice(0, 200));

      const session = db.query<any, [string]>("SELECT status FROM sessions WHERE alias = ?1").get(alias);
      pushEvent(alias, { type: "new_reply", from: from_session, message_id: id, in_reply_to, status: replyStatus });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, message_id: id, session_status: session?.status ?? "unknown" }),
        }],
      };
    }
  );

  // ── V2: send_ack (不入 inbox，仅更新状态) ──
  server.tool(
    "send_ack",
    "Acknowledge receipt of a task. Does NOT enter inbox. Updates task status only.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to acknowledge"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ task_id, from_session }) => {
      console.log(`[${ts()}] ${from_session} → send_ack → task ${task_id.slice(0, 8)}`);
      const result = db.run(
        `UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status IN ('created', 'delivered')`,
        [task_id]
      );
      if (result.changes > 0) logTaskEvent(task_id, "delivered", "acked", from_session);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: result.changes > 0, task_id, updated: result.changes }),
        }],
      };
    }
  );

  // ── V2: retry_task (重新投递失败/过期任务) ──
  server.tool(
    "retry_task",
    "Retry a failed, expired, or cancelled task. Resets status to delivered and re-queues in inbox.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to retry"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ task_id, from_session }) => {
      console.log(`[${ts()}] ${from_session} → retry_task → ${task_id.slice(0, 8)}`);
      // Find the original task
      const task = db.query<any, [string]>(
        "SELECT * FROM tasks WHERE task_id = ?1"
      ).get(task_id);
      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      }
      if (!["failed", "expired", "cancelled"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task status is ${task.status}, not retryable` }) }] };
      }
      try {
        db.run("BEGIN IMMEDIATE");
        // Reset task status
        db.run(
          `UPDATE tasks SET status = 'delivered', result = NULL, completed_at = NULL, started_at = NULL, delivered_at = datetime('now'), expires_at = datetime('now', '+1 hour')
           WHERE task_id = ?1`,
          [task_id]
        );
        // Re-queue in inbox with new ID (original ID may already exist)
        const retryInboxId = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, requires_response)
           VALUES (?1, ?2, 'task', ?3, ?4, ?5, 'reply')`,
          [retryInboxId, task.to_name, task.priority, task.content, from_session]
        );
        db.run("COMMIT");
        logTaskEvent(task_id, task.status, "delivered", from_session, "retry");
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }
      // SSE push
      pushEvent(task.to_name, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task_id, retried_to: task.to_name }) }],
      };
    }
  );

  // ── V2: get_task (查询任务状态) ──
  server.tool(
    "get_task",
    "Get task details by task_id. Returns status, result, timestamps.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to query"),
    },
    async ({ task_id }) => {
      const task = db.query<any, [string]>("SELECT * FROM tasks WHERE task_id = ?1").get(task_id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(task ? { ok: true, task } : { ok: false, error: "task not found" }),
        }],
      };
    }
  );

  // ── V2: list_tasks (查询任务列表) ──
  server.tool(
    "list_tasks",
    "List tasks with filters. Agents can query their own pending/running tasks.",
    {
      alias: z.string().max(200).optional().describe("Filter by to_name (target agent)"),
      status: z.string().max(50).optional().describe("Filter by status"),
      from_name: z.string().max(200).optional().describe("Filter by sender"),
      network_id: z.string().max(200).optional().describe("Filter by network"),
      limit: z.number().min(1).max(100).optional().default(20),
    },
    async ({ alias, status, from_name, network_id: netId, limit }) => {
      const effectiveNetId = getNetworkId(netId);
      let sql = "SELECT task_id, from_name, to_name, priority, status, content, result, created_at, completed_at FROM tasks WHERE 1=1";
      const params: any[] = [];
      if (effectiveNetId) { sql += ` AND network_id = ?${params.length + 1}`; params.push(effectiveNetId); }
      if (alias) { sql += ` AND to_name = ?${params.length + 1}`; params.push(alias); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (from_name) { sql += ` AND from_name = ?${params.length + 1}`; params.push(from_name); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const tasks = db.query(sql).all(...params);

      // Stats
      const stats = db.query<any, []>(
        "SELECT status, COUNT(*) as count FROM tasks GROUP BY status"
      ).all();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, tasks, count: tasks.length, stats }),
        }],
      };
    }
  );

  // ── V2: cancel_task (取消任务) ──
  server.tool(
    "cancel_task",
    "Cancel a pending task. Works on delivered/acked/running tasks.",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to cancel"),
      reason: z.string().max(1000).optional().describe("Cancellation reason"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ task_id, reason, from_session }) => {
      console.log(`[${ts()}] ${from_session} → cancel_task → ${task_id.slice(0, 8)}`);
      const result = db.run(
        `UPDATE tasks SET status = 'cancelled', result = ?1, completed_at = datetime('now')
         WHERE task_id = ?2 AND status IN ('created', 'delivered', 'acked', 'running')`,
        [reason || "cancelled by " + from_session, task_id]
      );
      // Also ack the inbox entry to prevent agent from picking it up
      if (result.changes > 0) {
        db.run("UPDATE inbox SET acked = 1 WHERE id = ?1 AND acked = 0", [task_id]);
        logTaskEvent(task_id, null, "cancelled", from_session, reason || undefined);
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: result.changes > 0, task_id, cancelled: result.changes > 0 }) }],
      };
    }
  );

  // ── V2: reassign_task (转移任务到另一个 agent) ──
  server.tool(
    "reassign_task",
    "Reassign a task to a different agent. Works on any non-terminal task (delivered/acked/running).",
    {
      task_id: z.string().min(1).max(200).describe("Task ID to reassign"),
      new_alias: z.string().min(1).max(200).describe("Target agent alias"),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ task_id, new_alias, from_session }) => {
      console.log(`[${ts()}] ${from_session} → reassign_task → ${task_id.slice(0, 8)} → ${new_alias}`);
      const task = db.query<any, [string]>("SELECT * FROM tasks WHERE task_id = ?1").get(task_id);
      if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      if (["replied", "failed", "cancelled", "expired"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task is terminal (${task.status})` }) }] };
      }
      const oldAlias = task.to_name;
      try {
        db.run("BEGIN IMMEDIATE");
        // Ack old inbox to prevent original agent from picking it up
        db.run("UPDATE inbox SET acked = 1 WHERE id = ?1 AND acked = 0", [task_id]);
        db.run("UPDATE tasks SET to_name = ?1, status = 'delivered', started_at = NULL, delivered_at = datetime('now') WHERE task_id = ?2", [new_alias, task_id]);
        const newInboxId = uuidv4();
        db.run("INSERT INTO inbox (id, session_name, type, priority, content, from_session, requires_response) VALUES (?1, ?2, 'task', ?3, ?4, ?5, 'reply')",
          [newInboxId, new_alias, task.priority, task.content, from_session]);
        db.run("COMMIT");
        logTaskEvent(task_id, task.status, "delivered", from_session, `reassign: ${oldAlias} → ${new_alias}`);
      } catch (e) {
        try { db.run("ROLLBACK"); } catch {}
        throw e;
      }
      pushEvent(new_alias, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task_id, reassigned_from: oldAlias, reassigned_to: new_alias }) }] };
    }
  );

  server.tool(
    "broadcast",
    "Send a message to multiple sessions.",
    {
      message: z.string().min(1).max(10000),
      filter_server: z.string().max(200).optional(),
      filter_status: z.string().max(50).optional(),
      network_id: z.string().max(200).optional().describe("Broadcast within a specific network"),
    },
    async ({ message, filter_server, filter_status, network_id: netId }) => {
      console.log(`[${ts()}] hub → broadcast: ${message.slice(0, 60)}${netId ? " [net=" + netId.slice(0, 12) + "]" : ""}`);
      let sql = "SELECT alias FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      if (netId) { sql += " AND network_id = ?"; params.push(netId); }
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }

      const targets = db.query<{ alias: string }, any[]>(sql).all(...params);
      const ids: string[] = [];

      for (const t of targets) {
        const id = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
           VALUES (?1, ?2, 'broadcast', 'normal', ?3, 'hub')`,
          [id, t.alias, message]
        );
        ids.push(id);
      }

      pushBroadcast(targets.map(t => t.alias), { type: "broadcast", inbox_count: 1, message: message.slice(0, 200) });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, recipients: targets.length, message_ids: ids }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_completions",
    "Get recent task completions.",
    {
      since: z.string().optional().describe("ISO 8601 datetime, default last 24h"),
      alias: z.string().max(200).optional().describe("Filter by session alias"),
      limit: z.number().min(1).max(500).optional().default(50),
    },
    async ({ since, alias, limit }) => {
      console.log(`[${ts()}] hub → get_completions${alias ? ": " + alias : ""}`);
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];

      if (alias) {
        sql += " AND session_name = ?2";
        params.push(alias);
      }

      const paramIdx = params.length + 1;
      sql += ` ORDER BY completed_at DESC LIMIT ?${paramIdx}`;
      params.push(limit);

      const rows = db.query(sql).all(...params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completions: rows }) }],
      };
    }
  );
}
