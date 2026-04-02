import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { db, uuidv4 } from "./db.js";
import { pushEvent, pushBroadcast } from "./push.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function registerTools(server: McpServer) {
  // ═══════════════════════════════════════════
  //  Child Agent Tools (4)
  // ═══════════════════════════════════════════

  server.tool(
    "report_status",
    "Report agent status. Returns inbox_count so you know if there are pending tasks.",
    {
      session_name: z.string().min(1).max(200).describe("Your session identifier"),
      status: z.enum(["working", "idle", "blocked", "error", "waiting_input"]),
      task: z.string().max(10000).optional().describe("Current task description"),
      output: z.string().max(50000).optional().describe("Recent output (max 4000 chars stored)"),
      score: z.number().min(0).max(10).optional().describe("Self-score 1-10"),
      progress: z.number().min(0).max(100).optional().describe("Progress 0-100"),
      server: z.string().max(200).optional().describe("Server identifier"),
    },
    async ({ session_name, status, task, output, score, progress, server: srv }) => {
      console.log(`[${ts()}] ${session_name} → report_status: ${status}${task ? " | " + task.slice(0, 60) : ""}`);
      const trimmedOutput = output?.slice(0, 4000);

      // #10 fix: COALESCE for all optional fields so heartbeats don't erase data
      db.run(
        `INSERT INTO sessions (name, server, status, task, output, progress, score, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           server = COALESCE(?2, sessions.server),
           status = ?3,
           task = COALESCE(?4, sessions.task),
           output = COALESCE(?5, sessions.output),
           progress = COALESCE(?6, sessions.progress),
           score = COALESCE(?7, sessions.score),
           updated_at = datetime('now')`,
        [session_name, srv ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? null, score ?? null]
      );

      const row = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(session_name);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              session_name,
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
      session_name: z.string().min(1).max(200),
      task: z.string().min(1).max(10000).describe("Completed task description"),
      result: z.string().min(1).max(50000).describe("Result summary"),
      artifacts: z.array(z.string().max(2000)).max(50).optional().describe("Output URLs or file paths"),
      score: z.number().min(0).max(10).optional(),
      duration_minutes: z.number().min(0).optional(),
    },
    async ({ session_name, task, result, artifacts, score, duration_minutes }) => {
      console.log(`[${ts()}] ${session_name} → report_completion: ${task.slice(0, 60)}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO completions (id, session_name, task, result, artifacts, score, duration_minutes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [id, session_name, task, result, artifacts ? JSON.stringify(artifacts) : null, score ?? null, duration_minutes ?? null]
      );

      db.run(
        `UPDATE sessions SET status = 'idle', task = NULL, progress = 0, updated_at = datetime('now')
         WHERE name = ?1`,
        [session_name]
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completion_id: id }) }],
      };
    }
  );

  server.tool(
    "get_inbox",
    "Get pending commands for your session.",
    {
      session_name: z.string().min(1).max(200),
      limit: z.number().min(1).max(100).optional().default(10),
    },
    async ({ session_name, limit }) => {
      const rows0 = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(session_name);
      console.log(`[${ts()}] ${session_name} → get_inbox: ${rows0?.cnt ?? 0} pending messages`);
      // #1 fix: LIMIT via parameterized binding
      const rows = db.query<any, [string, number]>(
        `SELECT id, type, priority, content, context, from_session, created_at
         FROM inbox WHERE session_name = ?1 AND acked = 0
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         LIMIT ?2`
      ).all(session_name, limit);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, messages: rows }) }],
      };
    }
  );

  server.tool(
    "ack_inbox",
    "Acknowledge receipt of a command.",
    {
      session_name: z.string().min(1).max(200),
      message_id: z.string().min(1).max(200),
      response: z.string().max(10000).optional(),
    },
    async ({ session_name, message_id, response }) => {
      console.log(`[${ts()}] ${session_name} → ack_inbox: ${message_id.slice(0, 8)}`);
      // #6 fix: check if update actually affected a row
      const result = db.run("UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2", [message_id, session_name]);
      if (result.changes === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "message not found or not yours" }) }],
        };
      }
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
    },
    async ({ filter_status, filter_server }) => {
      console.log(`[${ts()}] hub → get_all_status${filter_status ? ": filter=" + filter_status : ""}${filter_server ? " server=" + filter_server : ""}`);

      // #5 fix: auto-offline first, then read — in one transaction
      const sessions = db.transaction(() => {
        const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
        db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);

        let sql = "SELECT * FROM sessions WHERE 1=1";
        const params: any[] = [];
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
    "Get detailed status of a specific session.",
    { session_name: z.string().min(1).max(200) },
    async ({ session_name }) => {
      console.log(`[${ts()}] hub → get_session_status: ${session_name}`);
      const session = db.query("SELECT * FROM sessions WHERE name = ?1").get(session_name);
      const pending = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(session_name);
      const recent = db.query(
        "SELECT * FROM completions WHERE session_name = ?1 ORDER BY completed_at DESC LIMIT 5"
      ).all(session_name);

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
    "Dispatch a task to a session's inbox.",
    {
      session_name: z.string().min(1).max(200),
      task: z.string().min(1).max(10000).describe("Task content"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      context: z.string().max(10000).optional(),
      from_session: z.string().max(200).optional().default("hub"),
    },
    async ({ session_name, task, priority, context, from_session }) => {
      console.log(`[${ts()}] ${from_session} → send_task → ${session_name}: ${task.slice(0, 60)}${priority === "high" ? " [HIGH]" : ""}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, context, from_session)
         VALUES (?1, ?2, 'task', ?3, ?4, ?5, ?6)`,
        [id, session_name, priority, task, context ?? null, from_session]
      );

      const session = db.query<any, [string]>("SELECT status FROM sessions WHERE name = ?1").get(session_name);

      // SSE push: 秒达
      const pending = db.query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0"
      ).get(session_name);
      pushEvent(session_name, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority, from: from_session });

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
    "broadcast",
    "Send a message to multiple sessions.",
    {
      message: z.string().min(1).max(10000),
      filter_server: z.string().max(200).optional(),
      filter_status: z.string().max(50).optional(),
    },
    async ({ message, filter_server, filter_status }) => {
      console.log(`[${ts()}] hub → broadcast: ${message.slice(0, 60)}${filter_server ? " [server=" + filter_server + "]" : ""}`);
      let sql = "SELECT name FROM sessions WHERE 1=1";
      const params: any[] = [];
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }

      const targets = db.query<{ name: string }, any[]>(sql).all(...params);
      const ids: string[] = [];

      for (const t of targets) {
        const id = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session)
           VALUES (?1, ?2, 'broadcast', 'normal', ?3, 'hub')`,
          [id, t.name, message]
        );
        ids.push(id);
      }

      // SSE push: 广播秒达
      pushBroadcast(targets.map(t => t.name), { type: "broadcast", inbox_count: 1, message: message.slice(0, 200) });

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
      session_name: z.string().max(200).optional(),
      limit: z.number().min(1).max(500).optional().default(50),
    },
    async ({ since, session_name, limit }) => {
      console.log(`[${ts()}] hub → get_completions${session_name ? ": " + session_name : ""}`);
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // #1 fix: LIMIT via parameterized binding (was string concat)
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];

      if (session_name) {
        sql += " AND session_name = ?2";
        params.push(session_name);
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
