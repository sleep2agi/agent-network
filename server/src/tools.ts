import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { db, uuidv4, logTaskEvent } from "./db.js";
import { pushEvent, pushBroadcast } from "./push.js";
import { getUserNetworkRole } from "./auth.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function registerTools(server: McpServer, clientIP?: string, enforceNetworkId?: string | null, enforceUserId?: string | null) {
  // If enforceNetworkId is set, override any client-supplied network_id
  const getNetworkId = (clientNetId?: string | null) => enforceNetworkId ?? clientNetId ?? null;

  // Check if the user has write access to the enforced network
  // utok_ (no networkId) cannot do MCP writes — only ntok_/atok_ with network binding can
  const canWrite = (): boolean => {
    if (!enforceUserId) return true; // legacy global token mode, allow
    if (!enforceNetworkId) return false; // utok_ has no network → cannot write MCP
    const role = getUserNetworkRole(enforceUserId, enforceNetworkId);
    return !!role && role !== "viewer"; // owner/admin/member can write, viewer cannot
  };

  const addScope = (sql: string, params: any[], networkId?: string | null, column = "network_id"): string => {
    if (!networkId) return sql;
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(networkId);
    return sql;
  };

  const scopedSessionStatus = (alias: string, networkId?: string | null) => {
    const params: any[] = [alias];
    let sql = "SELECT status FROM sessions WHERE alias = ?1";
    sql = addScope(sql, params, networkId);
    return db.get<any>(sql, ...params);
  };
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
      if (!canWrite()) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      }
      console.log(`[${ts()}] ${alias} (${resume_id.slice(0, 8)}) → report_status: ${status}${task ? " | " + task.slice(0, 60) : ""}${effectiveNetId ? " [net]" : ""}`);
      const trimmedOutput = output?.slice(0, 4000);

      db.transaction(() => {
        // Only delete same-alias sessions within the same network
        if (effectiveNetId) {
          db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3", [alias, resume_id, effectiveNetId]);
        } else {
          db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2", [alias, resume_id]);
        }
        db.run(
          `INSERT INTO sessions (resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version, status, task, output, progress, score, node_id, session_id, config_path, channels, network_id, last_seen_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'), datetime('now'))
           ON CONFLICT(resume_id) DO UPDATE SET
             alias = COALESCE(?2, sessions.alias), tmux_name = COALESCE(?3, sessions.tmux_name),
             server = COALESCE(?4, sessions.server), ip = COALESCE(?5, sessions.ip),
             hostname = COALESCE(?6, sessions.hostname), agent = COALESCE(?7, sessions.agent),
             project_dir = COALESCE(?8, sessions.project_dir), version = COALESCE(?9, sessions.version),
             status = ?10, task = COALESCE(?11, sessions.task),
             output = COALESCE(?12, sessions.output), progress = COALESCE(?13, sessions.progress),
             score = COALESCE(?14, sessions.score), node_id = COALESCE(?15, sessions.node_id),
             session_id = COALESCE(?16, sessions.session_id), config_path = COALESCE(?17, sessions.config_path),
             channels = COALESCE(?18, sessions.channels), network_id = COALESCE(?19, sessions.network_id),
             last_seen_at = datetime('now'), updated_at = datetime('now')`,
          [resume_id, alias, tmux ?? null, srv ?? null, clientIP ?? null, hn ?? null, ag ?? null, pd ?? null, ver ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? null, score ?? null, node_id ?? null, session_id ?? null, config_path ?? null, channels ?? null, effectiveNetId ?? null]
        );
      });

      // V2: sync tasks table — report_status(working) → tasks.running
      if (status === "working" && task) {
        try {
          const runParams: any[] = [alias, task];
          let runSql = `UPDATE tasks SET status = 'running', started_at = datetime('now')
             WHERE to_name = ?1 AND status IN ('delivered', 'acked') AND content = ?2`;
          runSql = addScope(runSql, runParams, effectiveNetId);
          const runResult = db.run(runSql, runParams);
          if (runResult.changes > 0) {
            // Find task_id for logging
            const findParams: any[] = [alias, task];
            let findSql = "SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2 AND status = 'running'";
            findSql = addScope(findSql, findParams, effectiveNetId);
            findSql += " ORDER BY started_at DESC LIMIT 1";
            const t = db.get<{ task_id: string }>(findSql, ...findParams);
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
            `INSERT INTO nodes (node_id, node_name, alias, runtime, model, config_path, channels, server, hostname, network_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
             ON CONFLICT(node_id) DO UPDATE SET
               node_name = COALESCE(?2, nodes.node_name),
               alias = COALESCE(?3, nodes.alias),
               runtime = COALESCE(?4, nodes.runtime),
               model = COALESCE(?5, nodes.model),
               config_path = COALESCE(?6, nodes.config_path),
               channels = COALESCE(?7, nodes.channels),
               server = COALESCE(?8, nodes.server),
               hostname = COALESCE(?9, nodes.hostname),
               network_id = COALESCE(?10, nodes.network_id),
               updated_at = datetime('now')`,
            [node_id, nn || alias, alias, nodeRuntime, mdl ?? null, config_path ?? null, channels ?? null, srv ?? null, hn ?? null, effectiveNetId ?? null]
          );
        } catch {}
      }

      // inbox uses alias for routing
      const inboxParams: any[] = [alias];
      let inboxSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
      const row = db.get<{ cnt: number }>(inboxSql, ...inboxParams);

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
      network_id: z.string().max(200).optional().describe("Network scope"),
    },
    async ({ alias, task, result, artifacts, score, duration_minutes, network_id: netId }) => {
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite()) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      }
      console.log(`[${ts()}] ${alias} → report_completion: ${task.slice(0, 60)}${effectiveNetId ? " [net]" : ""}`);
      const id = uuidv4();
      let updatedTaskId: string | null = null;
      db.transaction(() => {
        db.run(
          `INSERT INTO completions (id, session_name, task, result, artifacts, score, duration_minutes, network_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          [id, alias, task, result, artifacts ? JSON.stringify(artifacts) : null, score ?? null, duration_minutes ?? null, effectiveNetId ?? null]
        );
        const sessionParams: any[] = [alias];
        let sessionSql = `UPDATE sessions SET status = 'idle', task = NULL, progress = 0, updated_at = datetime('now')
           WHERE alias = ?1`;
        sessionSql = addScope(sessionSql, sessionParams, effectiveNetId);
        db.run(sessionSql, sessionParams);

        // V2: sync tasks table — try by task_id first, then by content
        const taskParams: any[] = [result.slice(0, 4000), task];
        let taskSql = `UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now')
           WHERE task_id = ?2 AND status IN ('delivered', 'acked', 'running')`;
        taskSql = addScope(taskSql, taskParams, effectiveNetId);
        const tu = db.run(taskSql, taskParams);
        if (tu.changes === 0) {
          const matchParams: any[] = [alias, task];
          let matchSql = `SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2
             AND status IN ('delivered', 'acked', 'running')`;
          matchSql = addScope(matchSql, matchParams, effectiveNetId);
          matchSql += " ORDER BY created_at DESC LIMIT 1";
          const match = db.get<{ task_id: string }>(matchSql, ...matchParams);
          if (match) {
            const matchUpdateParams: any[] = [result.slice(0, 4000), match.task_id];
            let matchUpdateSql = "UPDATE tasks SET status = 'replied', result = ?1, completed_at = datetime('now') WHERE task_id = ?2";
            matchUpdateSql = addScope(matchUpdateSql, matchUpdateParams, effectiveNetId);
            db.run(matchUpdateSql, matchUpdateParams);
            updatedTaskId = match.task_id;
          }
        } else {
          updatedTaskId = task;
        }
      });
      // Log event after transaction
      if (updatedTaskId) logTaskEvent(updatedTaskId, null, "replied", alias, "report_completion");

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
      const effectiveNetId = getNetworkId(null);
      const countParams: any[] = [alias];
      let countSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      countSql = addScope(countSql, countParams, effectiveNetId);
      const rows0 = db.get<{ cnt: number }>(countSql, ...countParams);
      console.log(`[${ts()}] ${alias} → get_inbox: ${rows0?.cnt ?? 0} pending messages`);
      const rowsParams: any[] = [alias];
      let rowsSql = `SELECT id, type, priority, content, context, from_session, created_at, network_id
         FROM inbox WHERE session_name = ?1 AND acked = 0`;
      rowsSql = addScope(rowsSql, rowsParams, effectiveNetId);
      rowsSql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         LIMIT ?${rowsParams.length + 1}`;
      rowsParams.push(limit);
      const rows = db.all(rowsSql, ...rowsParams);

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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${alias} → ack_inbox: ${message_id.slice(0, 8)}`);
      const ackParams: any[] = [message_id, alias];
      let ackSql = "UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2";
      ackSql = addScope(ackSql, ackParams, effectiveNetId);
      const result = db.run(ackSql, ackParams);
      if (result.changes === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "message not found or not yours" }) }],
        };
      }
      // V2: sync tasks table — ack_inbox means delivered→acked
      try {
        const taskParams: any[] = [message_id];
        let taskSql = "UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status = 'delivered'";
        taskSql = addScope(taskSql, taskParams, effectiveNetId);
        const ackResult = db.run(taskSql, taskParams);
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
        const staleParams: any[] = [cutoff];
        let staleSql = "UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'";
        staleSql = addScope(staleSql, staleParams, effectiveNetId);
        db.run(staleSql, staleParams);

        let sql = "SELECT * FROM sessions WHERE 1=1";
        const params: any[] = [];
        if (effectiveNetId) { sql += " AND network_id = ?"; params.push(effectiveNetId); }
        if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }
        if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
        sql += " ORDER BY updated_at DESC";
        return db.all(sql, ...params);
      });

      const summaryParams: any[] = [];
      let summarySql = "SELECT status, COUNT(*) as count FROM sessions WHERE 1=1";
      summarySql = addScope(summarySql, summaryParams, effectiveNetId);
      summarySql += " GROUP BY status";
      const summary = db.all(summarySql, ...summaryParams);

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
      const effectiveNetId = getNetworkId(null);
      console.log(`[${ts()}] hub → get_session_status: ${alias}`);
      const sessionParams: any[] = [alias];
      let sessionSql = "SELECT * FROM sessions WHERE alias = ?1";
      sessionSql = addScope(sessionSql, sessionParams, effectiveNetId);
      const session = db.get(sessionSql, ...sessionParams);

      const pendingParams: any[] = [alias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);

      const recentParams: any[] = [alias];
      let recentSql = "SELECT * FROM completions WHERE session_name = ?1";
      recentSql = addScope(recentSql, recentParams, effectiveNetId);
      recentSql += " ORDER BY completed_at DESC LIMIT 5";
      const recent = db.all(recentSql, ...recentParams);

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

      // Role check: viewer cannot send tasks
      if (!canWrite()) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied", message: "Viewer role cannot send tasks" }) }] };
      }

      // License check
      const license = db.get<any>("SELECT type, expires_at FROM licenses ORDER BY created_at LIMIT 1");
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
      db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, context, from_session, requires_response, network_id)
           VALUES (?1, ?2, 'task', ?3, ?4, ?5, ?6, 'reply', ?7)`,
          [id, alias, priority, task, context ?? null, from_session, effectiveNetId ?? null]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id)
           VALUES (?1, ?2, ?3, ?4, 'delivered', ?5, 'reply', datetime('now'), datetime('now'), datetime('now', ?6), ?7)`,
          [id, from_session, alias, priority, task, `+${ttl_seconds || 3600} seconds`, effectiveNetId ?? null]
        );
      });
      logTaskEvent(id, null, "delivered", from_session, `→ ${alias}`);

      const session = scopedSessionStatus(alias, effectiveNetId);

      // SSE push by alias
      const pendingParams: any[] = [alias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
      if (session) pushEvent(alias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority, from: from_session });

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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → send_message → ${alias}: ${message.slice(0, 60)}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id)
         VALUES (?1, ?2, 'message', 'normal', ?3, ?4, ?5)`,
        [id, alias, message, from_session, effectiveNetId ?? null]
      );

      const session = scopedSessionStatus(alias, effectiveNetId);

      if (session) pushEvent(alias, { type: "new_message", message, from: from_session, message_id: id });

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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → send_reply (${replyStatus}) → ${alias}: ${text.slice(0, 60)}`);
      const id = uuidv4();
      const replyLogged = db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, in_reply_to, requires_response, network_id)
           VALUES (?1, ?2, 'reply', 'normal', ?3, ?4, ?5, 'none', ?6)`,
          [id, alias, text, from_session, in_reply_to ?? null, effectiveNetId ?? null]
        );

        // 更新 tasks 表
        if (in_reply_to) {
          const updateParams: any[] = [replyStatus, text, in_reply_to];
          let updateSql = `UPDATE tasks SET status = ?1, result = ?2, completed_at = datetime('now')
             WHERE task_id = ?3 AND status IN ('created', 'delivered', 'acked', 'running')`;
          updateSql = addScope(updateSql, updateParams, effectiveNetId);
          const result = db.run(updateSql, updateParams);
          if (result.changes === 0) {
            console.log(`[${ts()}] ⚠ send_reply: task ${in_reply_to?.slice(0, 8)} not found or already terminal`);
            return false;
          }
          return true;
        }
        return false;
      });

      // Log event after commit (outside transaction)
      if (replyLogged && in_reply_to) logTaskEvent(in_reply_to, null, replyStatus, from_session, text.slice(0, 200));

      const session = scopedSessionStatus(alias, effectiveNetId);
      if (session) pushEvent(alias, { type: "new_reply", from: from_session, message_id: id, in_reply_to, status: replyStatus });

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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → send_ack → task ${task_id.slice(0, 8)}`);
      const updateParams: any[] = [task_id];
      let updateSql = "UPDATE tasks SET status = 'acked' WHERE task_id = ?1 AND status IN ('created', 'delivered')";
      updateSql = addScope(updateSql, updateParams, effectiveNetId);
      const result = db.run(updateSql, updateParams);
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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → retry_task → ${task_id.slice(0, 8)}`);
      // Find the original task
      const taskParams: any[] = [task_id];
      let taskSql = "SELECT * FROM tasks WHERE task_id = ?1";
      taskSql = addScope(taskSql, taskParams, effectiveNetId);
      const task = db.get<any>(taskSql, ...taskParams);
      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      }
      if (!["failed", "expired", "cancelled"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task status is ${task.status}, not retryable` }) }] };
      }
      db.transaction(() => {
        // Reset task status
        const updateParams: any[] = [task_id];
        let updateSql = `UPDATE tasks SET status = 'delivered', result = NULL, completed_at = NULL, started_at = NULL, delivered_at = datetime('now'), expires_at = datetime('now', '+1 hour')
           WHERE task_id = ?1`;
        updateSql = addScope(updateSql, updateParams, effectiveNetId);
        db.run(updateSql, updateParams);
        // Re-queue in inbox with new ID (original ID may already exist)
        const retryInboxId = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, requires_response, network_id)
           VALUES (?1, ?2, 'task', ?3, ?4, ?5, 'reply', ?6)`,
          [retryInboxId, task.to_name, task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]
        );
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, "retry");
      // SSE push
      if (scopedSessionStatus(task.to_name, effectiveNetId ?? task.network_id)) {
        pushEvent(task.to_name, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session });
      }
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
      const effectiveNetId = getNetworkId(null);
      const params: any[] = [task_id];
      let sql = "SELECT * FROM tasks WHERE task_id = ?1";
      sql = addScope(sql, params, effectiveNetId);
      const task = db.get<any>(sql, ...params);
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
      const tasks = db.all(sql, ...params);

      // Stats
      const statsParams: any[] = [];
      let statsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      statsSql = addScope(statsSql, statsParams, effectiveNetId);
      statsSql += " GROUP BY status";
      const stats = db.all(statsSql, ...statsParams);

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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → cancel_task → ${task_id.slice(0, 8)}`);
      const updateParams: any[] = [reason || "cancelled by " + from_session, task_id];
      let updateSql = `UPDATE tasks SET status = 'cancelled', result = ?1, completed_at = datetime('now')
         WHERE task_id = ?2 AND status IN ('created', 'delivered', 'acked', 'running')`;
      updateSql = addScope(updateSql, updateParams, effectiveNetId);
      const result = db.run(updateSql, updateParams);
      // Also ack the inbox entry to prevent agent from picking it up
      if (result.changes > 0) {
        const inboxParams: any[] = [task_id];
        let inboxSql = "UPDATE inbox SET acked = 1 WHERE id = ?1 AND acked = 0";
        inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
        db.run(inboxSql, inboxParams);
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
      const effectiveNetId = getNetworkId(null);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] ${from_session} → reassign_task → ${task_id.slice(0, 8)} → ${new_alias}`);
      const taskParams: any[] = [task_id];
      let taskSql = "SELECT * FROM tasks WHERE task_id = ?1";
      taskSql = addScope(taskSql, taskParams, effectiveNetId);
      const task = db.get<any>(taskSql, ...taskParams);
      if (!task) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "task not found" }) }] };
      if (["replied", "failed", "cancelled", "expired"].includes(task.status)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `task is terminal (${task.status})` }) }] };
      }
      const oldAlias = task.to_name;
      db.transaction(() => {
        // Ack old inbox to prevent original agent from picking it up
        const inboxParams: any[] = [task_id];
        let inboxSql = "UPDATE inbox SET acked = 1 WHERE id = ?1 AND acked = 0";
        inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
        db.run(inboxSql, inboxParams);

        const updateParams: any[] = [new_alias, task_id];
        let updateSql = "UPDATE tasks SET to_name = ?1, status = 'delivered', started_at = NULL, delivered_at = datetime('now') WHERE task_id = ?2";
        updateSql = addScope(updateSql, updateParams, effectiveNetId);
        db.run(updateSql, updateParams);

        const newInboxId = uuidv4();
        db.run("INSERT INTO inbox (id, session_name, type, priority, content, from_session, requires_response, network_id) VALUES (?1, ?2, 'task', ?3, ?4, ?5, 'reply', ?6)",
          [newInboxId, new_alias, task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]);
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, `reassign: ${oldAlias} → ${new_alias}`);
      if (scopedSessionStatus(new_alias, effectiveNetId ?? task.network_id)) {
        pushEvent(new_alias, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session });
      }
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
      const effectiveNetId = getNetworkId(netId);
      if (!canWrite()) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied" }) }] };
      console.log(`[${ts()}] hub → broadcast: ${message.slice(0, 60)}${effectiveNetId ? " [net=" + effectiveNetId.slice(0, 12) + "]" : ""}`);
      let sql = "SELECT alias, network_id FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      sql = addScope(sql, params, effectiveNetId);
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }

      const targets = db.all<{ alias: string; network_id: string | null }>(sql, ...params);
      const ids: string[] = [];

      for (const t of targets) {
        const id = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, 'broadcast', 'normal', ?3, 'hub', ?4)`,
          [id, t.alias, message, effectiveNetId ?? t.network_id ?? null]
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
      network_id: z.string().max(200).optional().describe("Filter by network"),
      limit: z.number().min(1).max(500).optional().default(50),
    },
    async ({ since, alias, network_id: netId, limit }) => {
      const effectiveNetId = getNetworkId(netId);
      console.log(`[${ts()}] hub → get_completions${alias ? ": " + alias : ""}`);
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];
      sql = addScope(sql, params, effectiveNetId);

      if (alias) {
        sql += ` AND session_name = ?${params.length + 1}`;
        params.push(alias);
      }

      const paramIdx = params.length + 1;
      sql += ` ORDER BY completed_at DESC LIMIT ?${paramIdx}`;
      params.push(limit);

      const rows = db.all(sql, ...params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completions: rows }) }],
      };
    }
  );
}
