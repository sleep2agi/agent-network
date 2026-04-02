import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, uuidv4 } from "./db.js";

export function registerTools(server: McpServer) {
  // ═══════════════════════════════════════════
  //  Child Agent Tools (4)
  // ═══════════════════════════════════════════

  server.tool(
    "report_status",
    "Report agent status. Returns inbox_count so you know if there are pending tasks.",
    {
      session_name: z.string().describe("Your session identifier"),
      status: z.enum(["working", "idle", "blocked", "error", "waiting_input"]),
      task: z.string().optional().describe("Current task description"),
      output: z.string().optional().describe("Recent output (max 4000 chars)"),
      score: z.number().optional().describe("Self-score 1-10"),
      progress: z.number().optional().describe("Progress 0-100"),
      server: z.string().optional().describe("Server identifier"),
    },
    async ({ session_name, status, task, output, score, progress, server: srv }) => {
      const trimmedOutput = output?.slice(0, 4000);

      db.run(
        `INSERT INTO sessions (name, server, status, task, output, progress, score, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET
           server = COALESCE(?2, server),
           status = ?3, task = ?4, output = ?5,
           progress = ?6, score = ?7,
           updated_at = datetime('now')`,
        [session_name, srv ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? 0, score ?? null]
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
      session_name: z.string(),
      task: z.string().describe("Completed task description"),
      result: z.string().describe("Result summary"),
      artifacts: z.array(z.string()).optional().describe("Output URLs or file paths"),
      score: z.number().optional(),
      duration_minutes: z.number().optional(),
    },
    async ({ session_name, task, result, artifacts, score, duration_minutes }) => {
      const id = uuidv4();
      db.run(
        `INSERT INTO completions (id, session_name, task, result, artifacts, score, duration_minutes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [id, session_name, task, result, artifacts ? JSON.stringify(artifacts) : null, score ?? null, duration_minutes ?? null]
      );

      // Update session to idle
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
      session_name: z.string(),
      limit: z.number().optional().default(10),
    },
    async ({ session_name, limit }) => {
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
      session_name: z.string(),
      message_id: z.string(),
      response: z.string().optional(),
    },
    async ({ session_name, message_id, response }) => {
      db.run("UPDATE inbox SET acked = 1 WHERE id = ?1 AND session_name = ?2", [message_id, session_name]);
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
      filter_status: z.string().optional(),
      filter_server: z.string().optional(),
    },
    async ({ filter_status, filter_server }) => {
      let sql = "SELECT * FROM sessions WHERE 1=1";
      const params: any[] = [];

      if (filter_status) {
        sql += " AND status = ?";
        params.push(filter_status);
      }
      if (filter_server) {
        sql += " AND server = ?";
        params.push(filter_server);
      }
      sql += " ORDER BY updated_at DESC";

      const sessions = db.query(sql).all(...params);

      // Auto-offline: sessions not updated in 10+ minutes
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      db.run("UPDATE sessions SET status = 'offline' WHERE updated_at < ?1 AND status != 'offline'", [cutoff]);

      // Summary
      const summary = db.query<any, []>(
        `SELECT status, COUNT(*) as count FROM sessions GROUP BY status`
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
    { session_name: z.string() },
    async ({ session_name }) => {
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
      session_name: z.string(),
      task: z.string().describe("Task content"),
      priority: z.enum(["high", "normal", "low"]).optional().default("normal"),
      context: z.string().optional(),
      from_session: z.string().optional().default("hub"),
    },
    async ({ session_name, task, priority, context, from_session }) => {
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, type, priority, content, context, from_session)
         VALUES (?1, ?2, 'task', ?3, ?4, ?5, ?6)`,
        [id, session_name, priority, task, context ?? null, from_session]
      );

      const session = db.query<any, [string]>("SELECT status FROM sessions WHERE name = ?1").get(session_name);

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
      message: z.string(),
      filter_server: z.string().optional(),
      filter_status: z.string().optional(),
    },
    async ({ message, filter_server, filter_status }) => {
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
      session_name: z.string().optional(),
      limit: z.number().optional().default(50),
    },
    async ({ since, session_name, limit }) => {
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];

      if (session_name) {
        sql += " AND session_name = ?2";
        params.push(session_name);
      }
      sql += " ORDER BY completed_at DESC LIMIT " + limit;

      const rows = db.query(sql).all(...params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, completions: rows }) }],
      };
    }
  );
}
