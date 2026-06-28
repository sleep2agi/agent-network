import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { db, uuidv4, logTaskEvent, chainReplyToParent } from "./db.js";
import { pushEvent } from "./push.js";
import { getUserNetworkRole } from "./auth.js";
import { canonicalAliasExists, cleanupRenamedAliasSession, resolveCanonicalAlias } from "./rename.js";
import {
  ALLOWED_FLAGS,
  SECURITY_SENSITIVE_FLAGS,
  computeApplyMode,
  validatePatch,
  isAllowedToChangeFlag,
} from "./config-apply-validate.js";
import { sharedSendDedup, buildDuplicateSendPayload } from "./send_dedup.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function parseMetaJson(value: unknown): unknown | null {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeMetaJson(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  try { return JSON.stringify(meta); } catch { return null; }
}

export function registerTools(server: McpServer, clientIP?: string, enforceNetworkId?: string | null, enforceUserId?: string | null, callerAlias?: string | null, callerTokenIsNetwork = false, callerTokenId?: string | null) {
  // Default from_session for outbound tools — extracted from the calling
  // token's binding (ntok_ → node alias, utok_ → username). Without this,
  // an agent's send_task call always claimed from='hub' and peer agents
  // couldn't tell who actually asked them. Network-bound node tokens are an
  // identity boundary: they must not spoof another node via from_session.
  const defaultFrom = (clientFrom?: string) => (callerTokenIsNetwork && callerAlias) ? callerAlias : (clientFrom || callerAlias || "hub");
  const fromIdentityMismatchReply = (clientFrom?: string) => {
    const requestedFrom = clientFrom?.trim();
    if (!callerTokenIsNetwork || !callerAlias || !requestedFrom || requestedFrom === callerAlias) return null;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: "from_session_identity_mismatch",
          message: "network token from_session does not match token-bound node alias",
          token_alias: callerAlias,
          requested_from_session: requestedFrom,
        }),
      }],
    };
  };
  // If enforceNetworkId is set, override any client-supplied network_id
  const getNetworkId = (clientNetId?: string | null) => enforceNetworkId ?? clientNetId ?? null;

  // Check write access. For ntok_ the network is enforced by the token.
  // For utok_ (no enforced network) we accept the network_id supplied in the
  // request and verify the user has a write role on it.
  const canWrite = (effectiveNetworkId?: string | null): boolean => {
    if (!enforceUserId) return true; // legacy global token mode, allow
    const netId = enforceNetworkId ?? effectiveNetworkId ?? null;
    if (!netId) return false; // no network resolvable
    const role = getUserNetworkRole(enforceUserId, netId);
    return !!role && role !== "viewer"; // owner/admin/member can write
  };

  const writeDeniedReply = (effectiveNetworkId?: string | null, action = "write") => {
    const netId = enforceNetworkId ?? effectiveNetworkId ?? null;
    const message = !netId
      ? "network_id required (utok current_network is null; pass explicit network_id from /api/auth/me networks[0].network_id)"
      : action === "send_task"
        ? "Viewer role cannot send tasks"
        : "Viewer role cannot write to this network";
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "permission_denied", message }) }] };
  };

  const addScope = (sql: string, params: any[], networkId?: string | null, column = "network_id"): string => {
    if (!networkId) return sql;
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(networkId);
    return sql;
  };

  type ReadScope = { networkId?: string | null; networkIds?: string[] | null; denied?: string };

  const getReadableNetworkIds = (): string[] => {
    if (!enforceUserId) return [];
    return db.all<{ network_id: string }>(
      "SELECT network_id FROM network_members WHERE user_id = ?1",
      enforceUserId
    ).map((row) => row.network_id);
  };

  const resolveReadScope = (clientNetId?: string | null): ReadScope => {
    if (!enforceUserId) return { networkId: clientNetId ?? null, networkIds: null };
    if (enforceNetworkId) {
      const role = getUserNetworkRole(enforceUserId, enforceNetworkId);
      return role ? { networkId: enforceNetworkId, networkIds: null } : { denied: "not a member of token network" };
    }
    if (clientNetId) {
      const role = getUserNetworkRole(enforceUserId, clientNetId);
      return role ? { networkId: clientNetId, networkIds: null } : { denied: "access denied to requested network" };
    }
    return { networkId: null, networkIds: getReadableNetworkIds() };
  };

  const addReadScope = (sql: string, params: any[], scope: ReadScope, column = "network_id"): string => {
    if (scope.networkId) {
      sql += ` AND ${column} = ?${params.length + 1}`;
      params.push(scope.networkId);
      return sql;
    }
    if (scope.networkIds) {
      if (scope.networkIds.length === 0) return `${sql} AND 1=0`;
      const placeholders = scope.networkIds.map((_, i) => `?${params.length + i + 1}`).join(", ");
      sql += ` AND ${column} IN (${placeholders})`;
      params.push(...scope.networkIds);
    }
    return sql;
  };

  type DeliveryTarget =
    | { state: "online"; alias: string; session: any }
    | { state: "offline"; alias: string; session: any; message: string }
    | { state: "not_found"; alias: string; message: string };

  const scopedSessionStatus = (alias: string, networkId?: string | null) => {
    const params: any[] = [alias];
    let sql = "SELECT status, updated_at, last_seen_at, node_id FROM sessions WHERE alias = ?1";
    sql = addScope(sql, params, networkId);
    return db.get<any>(sql, ...params);
  };

  const resolveNodeIdForAlias = (alias: string, networkId?: string | null): string | null => {
    if (!alias || alias === "hub" || alias === "api") return null;
    const canonical = resolveCanonicalAlias(networkId, alias);
    const session = scopedSessionStatus(canonical.alias, networkId);
    return session?.node_id ?? null;
  };

  const resolveDeliveryTarget = (alias: string, networkId?: string | null): DeliveryTarget => {
    const session = scopedSessionStatus(alias, networkId);
    if (!session) {
      return {
        state: "not_found",
        alias,
        message: `alias not found: ${alias}`,
      };
    }
    const lastSeen = session.last_seen_at || session.updated_at;
    const lastSeenAt = lastSeen ? new Date(String(lastSeen).replace(" ", "T") + "Z").getTime() : 0;
    const stale = !lastSeenAt || Date.now() - lastSeenAt > 5 * 60 * 1000;
    if (String(session.status || "").toLowerCase() === "offline" || stale) {
      return {
        state: "offline",
        alias,
        session,
        message: `alias is offline; message queued in inbox: ${alias}`,
      };
    }
    return { state: "online", alias, session };
  };

  const deliveryTargetReply = (target: DeliveryTarget, ids: Record<string, string> = {}) => {
    if (target.state === "not_found") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "alias_not_found",
            message: target.message,
            alias: target.alias,
            queued: false,
            ...ids,
          }),
        }],
      };
    }
    if (target.state === "offline") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            error: "alias_offline",
            message: target.message,
            alias: target.alias,
            queued: true,
            session_status: target.session.status ?? "offline",
            ...ids,
          }),
        }],
      };
    }
    return null;
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
      host: z.object({
        hostname: z.string().max(200).optional(),
        ip: z.string().max(200).optional(),
        cpu_load_1min: z.number().nullable().optional(),
        cpu_cores: z.number().nullable().optional(),
        mem_total_gb: z.number().nullable().optional(),
        mem_used_gb: z.number().nullable().optional(),
        mem_avail_gb: z.number().nullable().optional(),
        disk_total_gb: z.number().nullable().optional(),
        disk_used_gb: z.number().nullable().optional(),
        disk_avail_gb: z.number().nullable().optional(),
      }).optional().describe("Host telemetry reported by agent-node"),
      process_telemetry: z.object({
        rss_bytes: z.number().nullable().optional(),
        rss_mb: z.number().nullable().optional(),
        rss: z.number().nullable().optional(),
        cpu_pct: z.number().nullable().optional(),
        uptime_seconds: z.number().nullable().optional(),
        in_flight_count: z.number().nullable().optional(),
      }).optional().describe("Per-agent process telemetry reported by agent-node"),
      // RFC-024 B6 — masked snapshot of the node's effective config
      // (model + 6 dashboard-editable flags). Secrets ARE NOT in this
      // shape (env._envRef stays on host); the dashboard reads this
      // verbatim for the snapshot path without touching node files.
      // config_update_capable signals whether the node runs under a
      // supervisor wrapper that honours the sentinel-75 restart path
      // (W1) — bare-spawned agent-nodes set this to false so dashboard
      // can grey out remote-restart for them.
      config_snapshot: z.object({
        model: z.string().max(200).optional().nullable(),
        flags: z.record(z.unknown()).optional(),
        config_revision: z.number().int().min(0).optional(),
        config_update_capable: z.boolean().optional(),
      }).optional().describe("RFC-024 — masked node config snapshot"),
    },
    async ({ resume_id, alias, status, task, output, score, progress, server: srv, hostname: hn, agent: ag, project_dir: pd, version: ver, tmux_name: tmux, node_id, session_id, config_path, channels, model: mdl, node_name: nn, network_id: netId, host, process_telemetry: proc, config_snapshot: cfgSnap }) => {
      const effectiveNetId = getNetworkId(netId);
      const sessionNetId = effectiveNetId ?? "default";
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!canWrite(effectiveNetId)) {
        return writeDeniedReply(effectiveNetId);
      }
      const canonical = resolveCanonicalAlias(sessionNetId, alias);
      let effectiveAlias = canonical.alias;
      if (canonical.renamed) {
        // A stale process may keep heartbeating with the old alias after a
        // committed rename. If the new alias is already active, ignore the
        // stale report and clean the old row instead of letting it recreate
        // a red/orphan dashboard node (#146/#172). If not active yet, rewrite
        // the incoming report to the canonical alias so startup can converge.
        if (canonicalAliasExists(sessionNetId, effectiveAlias, resume_id)) {
          cleanupRenamedAliasSession(sessionNetId, alias, effectiveAlias);
          const pendingParams: any[] = [effectiveAlias];
          let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
          pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
          const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                resume_id,
                alias: effectiveAlias,
                renamed_from: alias,
                ignored_stale_alias: true,
                inbox_count: pending?.cnt ?? 0,
              }),
            }],
          };
        }
      }
      console.log(`[${ts()}] ${effectiveAlias} (${resume_id.slice(0, 8)}) → report_status: ${status}${task ? " | " + task.slice(0, 60) : ""}${effectiveNetId ? " [net]" : ""}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      if (callerTokenIsNetwork && callerTokenId) {
        try {
          db.run("UPDATE api_tokens SET name = ?1 WHERE token_id = ?2", [`node:${effectiveAlias}`, callerTokenId]);
        } catch {}
      }
      const trimmedOutput = output?.slice(0, 4000);
      const hostHostname = host?.hostname || hn || null;
      const hostIp = host?.ip || clientIP || null;
      const cpuLoad1m = typeof host?.cpu_load_1min === "number" ? host.cpu_load_1min : null;
      const cpuCores = typeof host?.cpu_cores === "number" ? host.cpu_cores : null;
      const memTotalGb = typeof host?.mem_total_gb === "number" ? host.mem_total_gb : null;
      const memUsedGb = typeof host?.mem_used_gb === "number" ? host.mem_used_gb : null;
      const memAvailGb = typeof host?.mem_avail_gb === "number" ? host.mem_avail_gb : null;
      const diskTotalGb = typeof host?.disk_total_gb === "number" ? host.disk_total_gb : null;
      const diskUsedGb = typeof host?.disk_used_gb === "number" ? host.disk_used_gb : null;
      const diskAvailGb = typeof host?.disk_avail_gb === "number" ? host.disk_avail_gb : null;
      const processRssBytes = typeof proc?.rss_bytes === "number" ? proc.rss_bytes : (typeof proc?.rss === "number" ? proc.rss : null);
      const processRssMb = typeof proc?.rss_mb === "number"
        ? proc.rss_mb
        : (typeof processRssBytes === "number" ? Math.round((processRssBytes / 1024 / 1024) * 10) / 10 : null);
      const processCpuPct = typeof proc?.cpu_pct === "number" ? proc.cpu_pct : null;
      const processUptimeSeconds = typeof proc?.uptime_seconds === "number" ? proc.uptime_seconds : null;
      const processInFlightCount = typeof proc?.in_flight_count === "number" ? proc.in_flight_count : null;
      const statusHostTelemetry = host ? {
        hostname: hostHostname,
        ip: hostIp,
        cpu_load_1min: cpuLoad1m,
        cpu_cores: cpuCores,
        mem_total_gb: memTotalGb,
        mem_used_gb: memUsedGb,
        mem_avail_gb: memAvailGb,
        disk_total_gb: diskTotalGb,
        disk_used_gb: diskUsedGb,
        disk_avail_gb: diskAvailGb,
      } : null;
      const statusProcessTelemetry = proc ? {
        rss_bytes: processRssBytes,
        rss_mb: processRssMb,
        cpu_pct: processCpuPct,
        uptime_seconds: processUptimeSeconds,
        in_flight_count: processInFlightCount,
      } : null;

      db.transaction(() => {
        // Only delete same-alias sessions within the same network
        db.run("DELETE FROM sessions WHERE alias = ?1 AND resume_id != ?2 AND network_id = ?3", [effectiveAlias, resume_id, sessionNetId]);
        db.run(
          `INSERT INTO sessions (resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version, status, task, output, progress, score, node_id, session_id, config_path, channels, network_id, model, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, last_seen_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, datetime('now'), datetime('now'))
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
             model = COALESCE(?20, sessions.model),
             cpu_load_1min = COALESCE(?21, sessions.cpu_load_1min),
             cpu_cores = COALESCE(?22, sessions.cpu_cores),
             mem_total_gb = COALESCE(?23, sessions.mem_total_gb),
             mem_used_gb = COALESCE(?24, sessions.mem_used_gb),
             mem_avail_gb = COALESCE(?25, sessions.mem_avail_gb),
             disk_total_gb = COALESCE(?26, sessions.disk_total_gb),
             disk_used_gb = COALESCE(?27, sessions.disk_used_gb),
             disk_avail_gb = COALESCE(?28, sessions.disk_avail_gb),
             process_rss_bytes = COALESCE(?29, sessions.process_rss_bytes),
             process_rss_mb = COALESCE(?30, sessions.process_rss_mb),
             process_cpu_pct = COALESCE(?31, sessions.process_cpu_pct),
             process_uptime_seconds = COALESCE(?32, sessions.process_uptime_seconds),
             process_in_flight_count = COALESCE(?33, sessions.process_in_flight_count),
             last_seen_at = datetime('now'), updated_at = datetime('now')`,
          [resume_id, effectiveAlias, tmux ?? null, srv ?? null, hostIp, hostHostname, ag ?? null, pd ?? null, ver ?? null, status, task ?? null, trimmedOutput ?? null, progress ?? null, score ?? null, node_id ?? null, session_id ?? null, config_path ?? null, channels ?? null, sessionNetId, mdl ?? null, cpuLoad1m, cpuCores, memTotalGb, memUsedGb, memAvailGb, diskTotalGb, diskUsedGb, diskAvailGb, processRssBytes, processRssMb, processCpuPct, processUptimeSeconds, processInFlightCount]
        );
        if (host || proc) {
          db.run(
            `INSERT INTO agent_telemetry (id, network_id, resume_id, alias, hostname, ip, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb, disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'))`,
            [uuidv4(), sessionNetId, resume_id, effectiveAlias, hostHostname, hostIp, cpuLoad1m, cpuCores, memTotalGb, memUsedGb, memAvailGb, diskTotalGb, diskUsedGb, diskAvailGb, processRssBytes, processRssMb, processCpuPct, processUptimeSeconds, processInFlightCount]
          );
        }
      });
      pushEvent(effectiveAlias, {
        type: "status_update",
        alias: effectiveAlias,
        ...(canonical.renamed ? { renamed_from: alias } : {}),
        status,
        progress: progress ?? null,
        host: statusHostTelemetry,
        process_telemetry: statusProcessTelemetry,
      }, sessionNetId);

      // V2: sync tasks table — report_status(working) → tasks.running
      if (status === "working" && task) {
        try {
          const runParams: any[] = [effectiveAlias, task];
          let runSql = `UPDATE tasks SET status = 'running', started_at = datetime('now')
             WHERE to_name = ?1 AND status IN ('delivered', 'acked') AND content = ?2`;
          runSql = addScope(runSql, runParams, effectiveNetId);
          const runResult = db.run(runSql, runParams);
          if (runResult.changes > 0) {
            // Find task_id for logging
            const findParams: any[] = [effectiveAlias, task];
            let findSql = "SELECT task_id FROM tasks WHERE to_name = ?1 AND content = ?2 AND status = 'running'";
            findSql = addScope(findSql, findParams, effectiveNetId);
            findSql += " ORDER BY started_at DESC LIMIT 1";
            const t = db.get<{ task_id: string }>(findSql, ...findParams);
            if (t) logTaskEvent(t.task_id, null, "running", effectiveAlias);
          }
        } catch {}
      }

      // V2: upsert nodes table for persistent node identity. SEC-1
      // gate (PR A #287 follow-up, 通信牛 catch 2026-06-28): delegate
      // to upsertNodeWithSec1Guard so production + test exercise the
      // exact same code path. See helper below registerTools.
      if (node_id) {
        try {
          const nodeRuntime = ag?.includes(":") ? ag.split(":")[1] + "-sdk" : ag ?? null;
          upsertNodeWithSec1Guard({
            node_id,
            callerNetworkId: effectiveNetId ?? null,
            node_name: nn || effectiveAlias,
            alias: effectiveAlias,
            runtime: nodeRuntime,
            model: mdl ?? null,
            config_path: config_path ?? null,
            channels: channels ?? null,
            server: srv ?? null,
            hostname: hn ?? null,
            config_snapshot: cfgSnap ?? null,
          });
        } catch {}
      }

      // inbox uses alias for routing
      const inboxParams: any[] = [effectiveAlias];
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
              alias: effectiveAlias,
              ...(canonical.renamed ? { renamed_from: alias } : {}),
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
      if (!canWrite(effectiveNetId)) {
        return writeDeniedReply(effectiveNetId);
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

      // Auto-chain to parent lineage (mirror of send_reply path).
      // round5 F2: pass caller's effectiveNetId so the chain refuses
      // to write across tenants if some upstream parent links to a
      // foreign network.
      //
      // round5 follow-up (通信牛 SSE leak catch): gate the SSE push on
      // `result.chained` — if the chain refused (cross-network), the
      // subsequent SELECT of `parent.from_name` + `pushEvent(...,
      // parent.task_id)` would leak the foreign parent's task_id into
      // the caller's network via the SSE payload. Skip the push when
      // the chain didn't actually write.
      if (updatedTaskId) {
        try {
          const chainResult = chainReplyToParent(updatedTaskId, result, "replied", 5, effectiveNetId);
          if (chainResult.chained) {
            const parentChain = db.get<{ parent_task_id: string | null }>(
              "SELECT parent_task_id FROM tasks WHERE task_id = ?1",
              [updatedTaskId]
            );
            if (parentChain?.parent_task_id) {
              const parent = db.get<{ from_name: string; task_id: string }>(
                "SELECT from_name, task_id FROM tasks WHERE task_id = ?1",
                [parentChain.parent_task_id]
              );
              if (parent?.from_name && parent.from_name !== "hub" && parent.from_name !== "api") {
                pushEvent(parent.from_name, { type: "chained_reply", parent_task_id: parent.task_id, child_task_id: updatedTaskId, child_alias: alias }, effectiveNetId);
              }
            }
          }
        } catch (e: any) {
          console.log(`[${ts()}] ⚠ chainReplyToParent (completion) failed: ${e.message}`);
        }
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
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      const countParams: any[] = [alias];
      let countSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      countSql = addReadScope(countSql, countParams, readScope);
      const rows0 = db.get<{ cnt: number }>(countSql, ...countParams);
      console.log(`[${ts()}] ${alias} → get_inbox: ${rows0?.cnt ?? 0} pending messages`);
      const rowsParams: any[] = [alias];
      let rowsSql = `SELECT id, type, priority, content, context, from_session, created_at, network_id, meta_json
         FROM inbox WHERE session_name = ?1 AND acked = 0`;
      rowsSql = addReadScope(rowsSql, rowsParams, readScope);
      rowsSql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at
         LIMIT ?${rowsParams.length + 1}`;
      rowsParams.push(limit);
      const rows = db.all(rowsSql, ...rowsParams).map((row: any) => ({
        ...row,
        meta: parseMetaJson(row.meta_json),
      }));

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
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
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
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_all_status${filter_status ? ": filter=" + filter_status : ""}${readScope.networkId ? " net=" + readScope.networkId.slice(0, 12) : ""}`);

      // Round-2/4 review ③: stale-marking moved to startStaleSessionSweeper()
      // (background timer, ~60s cadence). Read path no longer fires UPDATE.
      let sql = "SELECT * FROM sessions WHERE 1=1";
      const params: any[] = [];
      sql = addReadScope(sql, params, readScope);
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      sql += " ORDER BY updated_at DESC";
      const sessions = db.all(sql, ...params);

      const summaryParams: any[] = [];
      let summarySql = "SELECT status, COUNT(*) as count FROM sessions WHERE 1=1";
      summarySql = addReadScope(summarySql, summaryParams, readScope);
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
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_session_status: ${alias}`);
      const sessionParams: any[] = [alias];
      let sessionSql = "SELECT * FROM sessions WHERE alias = ?1";
      sessionSql = addReadScope(sessionSql, sessionParams, readScope);
      const session = db.get(sessionSql, ...sessionParams);

      const pendingParams: any[] = [alias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addReadScope(pendingSql, pendingParams, readScope);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);

      const recentParams: any[] = [alias];
      let recentSql = "SELECT * FROM completions WHERE session_name = ?1";
      recentSql = addReadScope(recentSql, recentParams, readScope);
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
      from_session: z.string().max(200).optional(),
      ttl_seconds: z.number().min(1).max(86400).optional().describe("Task TTL in seconds (default: 3600)"),
      network_id: z.string().max(200).optional().describe("Network scope"),
      parent_task_id: z.string().max(200).optional().describe("Parent task this dispatch is on behalf of. When the child task replies the hub will auto-chain the answer to the parent task's originator, so the user sees the final result even if the intermediate session ends."),
      meta: z.any().optional().describe("Optional structured task metadata, e.g. { attachments: [{ type, path, url, mime, name, size }] }."),
    },
    async ({ alias, task, priority, context, from_session: _fromIn, ttl_seconds, network_id: netId, parent_task_id: parentIn, meta }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(netId);
      const metaJson = normalizeMetaJson(meta);

      // Role check FIRST — round5 follow-up (通信牛 oracle catch):
      // the explicit-parent verification below distinguishes
      // `cross_network_parent` from `permission_denied`. If we ran the
      // parent lookup before canWrite, a viewer role could probe parent
      // existence + ownership of foreign parents via the difference in
      // error codes. Run canWrite first so a viewer ALWAYS gets the
      // same `permission_denied` regardless of parent state.
      if (!canWrite(effectiveNetId)) {
        return writeDeniedReply(effectiveNetId, "send_task");
      }

      // Resolve parent_task_id: explicit > inferred (caller's most recent
      // delivered/started inbox task that's still open). Inference is the
      // safety net for when the LLM forgets to pass parent_task_id.
      //
      // round5 F1 fix: the inference SELECT MUST be network-scoped. Without
      // it, a caller in network B can pick up the parent_task_id of a
      // network A dispatch and chain-reply into the wrong tenant. The
      // explicit-parent path is verified below in F2.
      let parentTaskId: string | null = parentIn ?? null;
      if (!parentTaskId && from_session && from_session !== "hub" && from_session !== "api") {
        try {
          const recentParams: any[] = [from_session];
          let recentSql = "SELECT task_id FROM tasks WHERE to_name = ?1 AND status IN ('delivered','started')";
          recentSql = addScope(recentSql, recentParams, effectiveNetId);
          recentSql += " ORDER BY created_at DESC LIMIT 1";
          const recent = db.get<{ task_id: string }>(recentSql, ...recentParams);
          if (recent?.task_id) parentTaskId = recent.task_id;
        } catch {}
      }

      // round5 F2 fix: an explicit parent_task_id must belong to the
      // caller's network. Otherwise a malicious caller in network B can
      // hand us a parent id from network A and have chainReplyToParent
      // (db.ts) write back into A's task result + inbox — cross-tenant
      // write. Verify ownership, reject on mismatch.
      if (parentIn) {
        const parentRow = db.get<{ network_id: string | null }>(
          "SELECT network_id FROM tasks WHERE task_id = ?1",
          [parentIn]
        );
        if (!parentRow) {
          // Parent doesn't exist (LLM hallucination, race with retention
          // sweep, etc.). Drop the link silently so the dispatch can
          // still proceed; the LLM may have meant to dispatch fresh.
          console.log(`[${ts()}] ⚠ send_task: parent_task_id=${parentIn.slice(0, 8)} not found, dropping parent link`);
          parentTaskId = null;
        } else if ((parentRow.network_id ?? null) !== (effectiveNetId ?? null)) {
          console.log(`[${ts()}] 🚫 send_task: cross-network parent rejected, parent=${parentIn.slice(0, 8)} parent-net=${parentRow.network_id ?? "null"} caller-net=${effectiveNetId ?? "null"}`);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            ok: false, error: "cross_network_parent",
            message: "parent_task_id belongs to a different network",
          }) }] };
        }
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

      const canonical = resolveCanonicalAlias(effectiveNetId, alias);
      const targetAlias = canonical.alias;
      const target = resolveDeliveryTarget(targetAlias, effectiveNetId);
      if (target.state === "not_found") return deliveryTargetReply(target)!;

      // #212 dedup guardrail. If this exact (from, to, content) has already
      // been delivered within COMMHUB_SEND_DEDUP_WINDOW_MS (default 5 min)
      // we refuse the call and surface a structured `duplicate_send`
      // error. The LLM receives the Chinese hint inside details.message
      // and can act on it (rewrite the task or wait). See A站Grok #212
      // incident: 50+ identical dispatches across 5 LLM turns ignored
      // three STOP replies — the LLM cannot be trusted to debounce
      // itself, so the runtime layer must.
      const dedup = sharedSendDedup.check(from_session, targetAlias, task);
      if (dedup.duplicate) {
        const payload = buildDuplicateSendPayload({
          from: from_session,
          to: targetAlias,
          ageMs: dedup.ageMs,
          windowMs: sharedSendDedup.windowMs,
        });
        console.log(`[${ts()}] ${from_session} → send_task → ${targetAlias}: DROPPED duplicate (age=${dedup.ageMs}ms, window=${sharedSendDedup.windowMs}ms)`);
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      }

      console.log(`[${ts()}] ${from_session} → send_task → ${targetAlias}: ${task.slice(0, 60)}${priority === "high" ? " [HIGH]" : ""}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      const id = uuidv4();
      const fromNodeId = resolveNodeIdForAlias(from_session, effectiveNetId);
      const targetNodeId = target.session?.node_id ?? null;
      // 事务：inbox + tasks 双写 + 触碰目标 session 的 task/updated_at（让
      // dashboard 在派任务一刻就反映出"任务已下发"，不再等 agent 的
      // report_status 心跳；status 字段交给 agent，避免与 working/idle
      // 报告冲突）。
      db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, context, from_session, requires_response, network_id, meta_json)
           VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, ?7, 'reply', ?8, ?9)`,
          [id, targetAlias, targetNodeId, priority, task, context ?? null, from_session, effectiveNetId ?? null, metaJson]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_node_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, parent_task_id, meta_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7, 'reply', datetime('now'), datetime('now'), datetime('now', ?8), ?9, ?10, ?11)`,
          [id, fromNodeId, from_session, targetNodeId, targetAlias, priority, task, `+${ttl_seconds || 3600} seconds`, effectiveNetId ?? null, parentTaskId, metaJson]
        );
        const touchParams: any[] = [task.slice(0, 200), targetAlias];
        let touchSql = "UPDATE sessions SET task = ?1, updated_at = datetime('now') WHERE alias = ?2";
        touchSql = addScope(touchSql, touchParams, effectiveNetId);
        db.run(touchSql, touchParams);
      });
      logTaskEvent(id, null, "delivered", from_session, parentTaskId ? `→ ${targetAlias} (parent=${parentTaskId.slice(0,8)})` : `→ ${targetAlias}`);
      // Only stamp the dedup index after the inbox/tasks transaction
      // succeeds, so a failed insert never silently shadows a legitimate
      // retry.
      sharedSendDedup.record(from_session, targetAlias, task);

      // SSE push by alias.
      // The SSE channel is keyed by alias (subscribers connected to /events/<alias>),
      // not by network_id. Earlier we gated the push on a network-scoped session
      // lookup, which silently dropped pushes whenever an agent registered with
      // network_id=null but the sender supplied an explicit network_id (the
      // exact mismatch hit by Dashboard tasks). Push unconditionally; the
      // subscriber's own auth (ntok_) constrains who can listen.
      const pendingParams: any[] = [targetAlias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      pendingSql = addScope(pendingSql, pendingParams, effectiveNetId);
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
      if (target.state === "online") {
        pushEvent(targetAlias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority, from: from_session, ...(canonical.renamed ? { renamed_from: alias } : {}) }, effectiveNetId);
      }

      if (target.state === "offline") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "alias_offline",
              message: target.message,
              alias: targetAlias,
              queued: true,
              task_id: id,
              message_id: id,
              session_status: target.session.status ?? "offline",
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
            }),
          }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
              session_status: target.session?.status ?? "unknown",
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
      from_session: z.string().max(200).optional(),
    },
    async ({ alias, message, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      const canonical = resolveCanonicalAlias(effectiveNetId, alias);
      const targetAlias = canonical.alias;
      const target = resolveDeliveryTarget(targetAlias, effectiveNetId);
      if (target.state === "not_found") return deliveryTargetReply(target)!;
      console.log(`[${ts()}] ${from_session} → send_message → ${targetAlias}: ${message.slice(0, 60)}${canonical.renamed ? ` [renamed from ${alias}]` : ""}`);
      const id = uuidv4();
      db.run(
        `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
         VALUES (?1, ?2, ?3, 'message', 'normal', ?4, ?5, ?6)`,
        [id, targetAlias, target.session?.node_id ?? null, message, from_session, effectiveNetId ?? null]
      );

      if (target.state === "online") {
        pushEvent(targetAlias, { type: "new_message", from: from_session, message_id: id, ...(canonical.renamed ? { renamed_from: alias } : {}) }, effectiveNetId);
      }

      const offlineReply = deliveryTargetReply(target, { message_id: id });
      if (offlineReply) {
        const payload = JSON.parse(offlineReply.content[0].text);
        offlineReply.content[0].text = JSON.stringify({
          ...payload,
          ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
        });
        return offlineReply;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              message_id: id,
              ...(canonical.renamed ? { renamed_from: alias, renamed_to: targetAlias } : {}),
              session_status: target.session?.status ?? "unknown",
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
      from_session: z.string().max(200).optional(),
    },
    async ({ alias, text, in_reply_to, status: replyStatus, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] ${from_session} → send_reply (${replyStatus}) → ${alias}: ${text.slice(0, 60)}`);
      const id = uuidv4();
      let taskBefore: { status: string } | null = null;
      if (in_reply_to) {
        const taskParams: any[] = [in_reply_to];
        let taskSql = "SELECT status FROM tasks WHERE task_id = ?1";
        taskSql = addScope(taskSql, taskParams, effectiveNetId);
        taskBefore = db.get<{ status: string }>(taskSql, ...taskParams) ?? null;
        if (!taskBefore) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: "reply_task_not_found",
                message: `cannot apply reply: task not found (${in_reply_to})`,
                in_reply_to,
                reply_queued: false,
              }),
            }],
          };
        }
        if (!["created", "delivered", "acked", "running"].includes(taskBefore.status)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: "reply_task_terminal",
                message: `cannot apply reply: task is already terminal (${taskBefore.status})`,
                in_reply_to,
                task_status: taskBefore.status,
                reply_queued: false,
              }),
            }],
          };
        }
      }
      const replyTargetNodeId = resolveNodeIdForAlias(alias, effectiveNetId);
      const replyLogged = db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, in_reply_to, requires_response, network_id)
           VALUES (?1, ?2, ?3, 'reply', 'normal', ?4, ?5, ?6, 'none', ?7)`,
          [id, alias, replyTargetNodeId, text, from_session, in_reply_to ?? null, effectiveNetId ?? null]
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

      if (in_reply_to && !replyLogged) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "reply_not_applied",
              message: "reply was not applied to task",
              in_reply_to,
              reply_queued: false,
            }),
          }],
        };
      }

      // Log event after commit (outside transaction)
      if (replyLogged && in_reply_to) logTaskEvent(in_reply_to, null, replyStatus, from_session, text.slice(0, 200));

      // Auto-chain reply up to parent task lineage so admin sees the final
      // answer even if the intermediate session has died.
      // round5 F2: pass caller's effectiveNetId so the chain refuses
      // to write across tenants if some upstream parent links to a
      // foreign network.
      //
      // round5 follow-up (通信牛 SSE leak catch): gate the SSE push on
      // `result.chained`. See report_completion path above for the
      // full reasoning — same leak, same gate.
      if (replyLogged && in_reply_to) {
        try {
          const chainResult = chainReplyToParent(in_reply_to, text, replyStatus, 5, effectiveNetId);
          if (chainResult.chained) {
            const parentChain = db.get<{ parent_task_id: string | null; from_name: string }>(
              "SELECT parent_task_id, from_name FROM tasks WHERE task_id = ?1",
              [in_reply_to]
            );
            if (parentChain?.parent_task_id) {
              const parent = db.get<{ from_name: string; task_id: string }>(
                "SELECT from_name, task_id FROM tasks WHERE task_id = ?1",
                [parentChain.parent_task_id]
              );
              if (parent?.from_name && parent.from_name !== "hub" && parent.from_name !== "api") {
                pushEvent(parent.from_name, { type: "chained_reply", parent_task_id: parent.task_id, child_task_id: in_reply_to, child_alias: alias }, effectiveNetId);
              }
            }
          }
        } catch (e: any) {
          console.log(`[${ts()}] ⚠ chainReplyToParent failed: ${e.message}`);
        }
      }

      const session = scopedSessionStatus(alias, effectiveNetId);
      pushEvent(alias, { type: "new_reply", from: from_session, message_id: id, in_reply_to, status: replyStatus }, effectiveNetId);

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
      from_session: z.string().max(200).optional(),
    },
    async ({ task_id, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
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
      from_session: z.string().max(200).optional(),
    },
    async ({ task_id, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
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
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, requires_response, network_id)
           VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, 'reply', ?7)`,
          [retryInboxId, task.to_name, task.to_node_id ?? resolveNodeIdForAlias(task.to_name, effectiveNetId ?? task.network_id ?? null), task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]
        );
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, "retry");
      // SSE push (unconditional — channel is keyed by alias, not network)
      pushEvent(task.to_name, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session }, effectiveNetId ?? task.network_id ?? null);
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
      const readScope = resolveReadScope(null);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      const params: any[] = [task_id];
      let sql = "SELECT * FROM tasks WHERE task_id = ?1";
      sql = addReadScope(sql, params, readScope);
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
      from_node_id: z.string().max(200).optional().describe("Filter by immutable sender node_id"),
      network_id: z.string().max(200).optional().describe("Filter by network"),
      limit: z.number().min(1).max(100).optional().default(20),
    },
    async ({ alias, status, from_name, from_node_id, network_id: netId, limit }) => {
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      let sql = "SELECT task_id, from_node_id, from_name, to_node_id, to_name, priority, status, content, result, created_at, completed_at FROM tasks WHERE 1=1";
      const params: any[] = [];
      sql = addReadScope(sql, params, readScope);
      if (alias) { sql += ` AND to_name = ?${params.length + 1}`; params.push(alias); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (from_name) { sql += ` AND from_name = ?${params.length + 1}`; params.push(from_name); }
      if (from_node_id) { sql += ` AND from_node_id = ?${params.length + 1}`; params.push(from_node_id); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const tasks = db.all(sql, ...params);

      // Stats
      const statsParams: any[] = [];
      let statsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      statsSql = addReadScope(statsSql, statsParams, readScope);
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
      from_session: z.string().max(200).optional(),
    },
    async ({ task_id, reason, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
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
      from_session: z.string().max(200).optional(),
    },
    async ({ task_id, new_alias, from_session: _fromIn }) => { const fromMismatch = fromIdentityMismatchReply(_fromIn); if (fromMismatch) return fromMismatch; const from_session = defaultFrom(_fromIn);
      const effectiveNetId = getNetworkId(null);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
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
      const canonical = resolveCanonicalAlias(effectiveNetId ?? task.network_id ?? null, new_alias);
      const reassignedAlias = canonical.alias;
      const target = resolveDeliveryTarget(reassignedAlias, effectiveNetId ?? task.network_id ?? null);
      const newNodeId = target.state === "not_found" ? null : (target.session?.node_id ?? null);
      db.transaction(() => {
        // Ack old inbox to prevent original agent from picking it up
        const inboxParams: any[] = [task_id];
        let inboxSql = "UPDATE inbox SET acked = 1 WHERE id = ?1 AND acked = 0";
        inboxSql = addScope(inboxSql, inboxParams, effectiveNetId);
        db.run(inboxSql, inboxParams);

        const updateParams: any[] = [reassignedAlias, newNodeId, task_id];
        let updateSql = "UPDATE tasks SET to_name = ?1, to_node_id = ?2, status = 'delivered', started_at = NULL, delivered_at = datetime('now') WHERE task_id = ?3";
        updateSql = addScope(updateSql, updateParams, effectiveNetId);
        db.run(updateSql, updateParams);

        const newInboxId = uuidv4();
        db.run("INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, requires_response, network_id) VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, 'reply', ?7)",
          [newInboxId, reassignedAlias, newNodeId, task.priority, task.content, from_session, effectiveNetId ?? task.network_id ?? null]);
      });
      logTaskEvent(task_id, task.status, "delivered", from_session, `reassign: ${oldAlias} → ${reassignedAlias}`);
      pushEvent(reassignedAlias, { type: "new_task", inbox_count: 1, priority: task.priority, from: from_session, ...(canonical.renamed ? { renamed_from: new_alias } : {}) }, effectiveNetId ?? task.network_id ?? null);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, task_id, reassigned_from: oldAlias, reassigned_to: reassignedAlias, ...(canonical.renamed ? { renamed_from: new_alias, renamed_to: reassignedAlias } : {}) }) }] };
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
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId);
      console.log(`[${ts()}] hub → broadcast: ${message.slice(0, 60)}${effectiveNetId ? " [net=" + effectiveNetId.slice(0, 12) + "]" : ""}`);
      let sql = "SELECT alias, node_id, network_id FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      sql = addScope(sql, params, effectiveNetId);
      if (filter_server) { sql += " AND server = ?"; params.push(filter_server); }
      if (filter_status) { sql += " AND status = ?"; params.push(filter_status); }

      const targets = db.all<{ alias: string; node_id: string | null; network_id: string | null }>(sql, ...params);
      const ids: string[] = [];

      for (const t of targets) {
        const id = uuidv4();
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, ?3, 'broadcast', 'normal', ?4, 'hub', ?5)`,
          [id, t.alias, t.node_id ?? null, message, effectiveNetId ?? t.network_id ?? null]
        );
        ids.push(id);
      }

      for (const t of targets) {
        pushEvent(t.alias, { type: "broadcast", inbox_count: 1 }, effectiveNetId ?? t.network_id ?? null);
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
      alias: z.string().max(200).optional().describe("Filter by session alias"),
      network_id: z.string().max(200).optional().describe("Filter by network"),
      limit: z.number().min(1).max(500).optional().default(50),
    },
    async ({ since, alias, network_id: netId, limit }) => {
      const readScope = resolveReadScope(netId);
      if (readScope.denied) return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: readScope.denied }) }] };
      console.log(`[${ts()}] hub → get_completions${alias ? ": " + alias : ""}`);
      const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      const params: any[] = [cutoff];
      sql = addReadScope(sql, params, readScope);

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

  // ──────────────────────────────────────────────────────────────────
  // RFC-024 (2026-06-28) — node config-apply MCP tools.
  //
  // Three contract tools (update / get / ack) + one lifecycle tool
  // (restart_node, Vincent 2026-06-28 increment). All four enforce
  // SEC-1 (network-scoped, never trust upstream dashboard routing —
  // every tool re-checks caller→token→network. Mirrors the #275
  // cross-tenant write防护带 pattern). update_node_config additionally
  // enforces SEC-2 — security-sensitive flags (permissionMode,
  // dangerouslySkipPermissions, teammateMode) are fail-CLOSED pending
  // Vincent's policy decision (see SECURITY_SENSITIVE_FLAGS below).
  //
  // See docs/rfcs/RFC-024-dashboard-node-config-apply.md for the
  // contract + sequence diagrams + guards.
  // ──────────────────────────────────────────────────────────────────

  // Helpers — ALLOWED_FLAGS, SECURITY_SENSITIVE_FLAGS, computeApplyMode,
  // validatePatch, isAllowedToChangeFlag live in
  // ./config-apply-validate.ts so the contract is unit-testable without
  // standing up an MCP server.

  /**
   * Resolve the node row that update_node_config / restart_node targets.
   * Returns the row + the SEC-1 verdict (network match against caller).
   * Network mismatch is the cross-tenant write防护带 from #275 — every
   * tool re-checks this even if dashboard already did, because curl
   * can talk directly to /mcp.
   */
  const resolveTargetNode = (
    nodeId: string,
    callerNetworkId: string | null,
  ): { row: any | null; sec1Ok: boolean } => {
    const row = db.get<any>(
      "SELECT node_id, alias, network_id, config_revision FROM nodes WHERE node_id = ?1",
      nodeId,
    );
    if (!row) return { row: null, sec1Ok: false };
    // Use the same null/undefined → "default" normalization as the
    // report_status upsert guard (norm() helper) — `||` would also
    // coerce `""` to "default", which is unreachable in the V3 model
    // today but better aligned to avoid drift if any future migration
    // ever introduces empty-string network_ids. Single source of
    // truth: nullish-only.
    const nodeNet = row.network_id === null || row.network_id === undefined ? "default" : row.network_id;
    const callerNet = callerNetworkId === null || callerNetworkId === undefined ? "default" : callerNetworkId;
    return { row, sec1Ok: nodeNet === callerNet };
  };

  server.tool(
    "update_node_config",
    "Set the desired per-node config (model + flags) and push a doorbell to the node. The node pulls + validates + applies (hot or restart per field tier). RFC-024.",
    {
      node_id: z.string().min(1).max(200).describe("Target node ID (not alias). Must be in caller's network."),
      base_revision: z.number().int().min(0).describe("Current revision per the dashboard's last GET — 409 if hub's current revision differs."),
      patch: z.object({
        model: z.string().max(200).optional(),
        flags: z.record(z.unknown()).optional(),
      }).describe("Fields to update. Empty patch → no-op (use restart_node for that)."),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id: nodeId, base_revision: baseRev, patch, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");

      const { row: node, sec1Ok } = resolveTargetNode(nodeId, effectiveNetId);
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_found", node_id: nodeId }) }] };
      }
      if (!sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node", message: "node belongs to another network" }) }] };
      }

      const model = typeof patch.model === "string" ? patch.model : undefined;
      const flags = (patch.flags && typeof patch.flags === "object") ? patch.flags as Record<string, unknown> : {};

      // SEC-2 (final policy 2026-06-28) — security-sensitive flags
      // (permissionMode / dangerouslySkipPermissions / teammateMode)
      // require admin role on this network. Other flags fall through
      // to per-field validation. hub-side enforced (dashboard's UI
      // gate is not trusted; curl direct to /mcp is the attack
      // vector). See isAllowedToChangeFlag for the policy details.
      const callerRole = enforceUserId && effectiveNetId
        ? getUserNetworkRole(enforceUserId, effectiveNetId)
        : null;
      const secCheck = isAllowedToChangeFlag(callerRole, flags);
      if (secCheck) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "insufficient_role_for_security_flag",
              field: secCheck.field,
              required_role: "admin",  // or owner — both satisfy
              message: secCheck.reason,
            }),
          }],
        };
      }

      const validationFail = validatePatch(model, flags);
      if (validationFail) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "invalid_patch",
              field: validationFail.field,
              reason: validationFail.reason,
            }),
          }],
        };
      }

      // Revision conflict.
      if ((node.config_revision || 0) !== baseRev) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: false,
              error: "revision_conflict",
              current_revision: node.config_revision || 0,
              base_revision: baseRev,
            }),
          }],
        };
      }

      // F-B (CHANGE_REQ): single-flight with stale-update reaper.
      // Without TTL, a node that ack'd "restarting" then crashed (lost
      // power, OOM, killed) leaves a non-terminal row forever — every
      // subsequent update_node_config / restart_node returns
      // update_in_flight and the node is admin-bricked.
      //
      // Stale threshold = 60_000 ms (2× the §8-confirmed 30s apply ceiling,
      // chosen so a slow-but-alive node within its own deadline never
      // false-positives as stale). Stale rows are marked timeout +
      // superseded by the new update.
      //
      // Age anchor = COALESCE(acked_at, created_at) per 通信龙 polish:
      // a healthy-but-slow restart (drain 60s + respawn time) could
      // exceed the threshold if anchored on created_at alone (drain
      // cap and reaper threshold are both 60s — overlap). Anchoring
      // on acked_at means a node that ack'd "restarting" refreshes
      // the liveness clock, so an in-progress restart isn't falsely
      // reaped.
      const STALE_THRESHOLD_MS = 60_000;
      const inFlight = db.get<{ update_id: string; created_at: number; acked_at: number | null }>(
        "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
        nodeId,
      );
      if (inFlight) {
        const ageAnchor = inFlight.acked_at ?? inFlight.created_at;
        const age = Date.now() - ageAnchor;
        if (age <= STALE_THRESHOLD_MS) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: "update_in_flight",
                existing_update_id: inFlight.update_id,
                age_ms: age,
              }),
            }],
          };
        }
        // Stale — supersede.
        db.run(
          "UPDATE node_config_updates SET status = 'timeout', acked_at = ?1, error = ?2 WHERE update_id = ?3",
          [Date.now(), `superseded by new update after ${age}ms stale (> ${STALE_THRESHOLD_MS}ms threshold)`, inFlight.update_id],
        );
      }

      // Compute apply_mode + persist + push doorbell.
      const updateId = `cu_${uuidv4()}`;
      const applyMode = computeApplyMode(model, flags);
      const patchJson = JSON.stringify({ ...(model !== undefined ? { model } : {}), flags });
      const networkId = node.network_id || "default";
      db.run(
        `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`,
        [updateId, nodeId, networkId, patchJson, applyMode, baseRev, Date.now(), callerTokenId || "unknown"],
      );

      pushEvent(node.alias, { type: "config_update", update_id: updateId }, networkId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, update_id: updateId, apply_mode: applyMode }),
        }],
      };
    },
  );

  server.tool(
    "get_config_update",
    "Node pulls its pending config update (called from agent-node when SSE config_update doorbell arrives). RFC-024.",
    {},
    async () => {
      // F-A (CHANGE_REQ): require ntok_ + non-null enforceNetworkId.
      // Mirror report_status's guard (tools.ts:251-253) — utok_ has
      // enforceNetworkId=null and callerAlias=username, so without
      // this gate a utok_ whose username happens to match a node alias
      // could pull that node's pending update across network scope
      // (network filter would be silently dropped, since old code had
      // a conditional WHERE). Hub doesn't trust upstream gates — every
      // node-private tool must independently require a network-bound
      // token.
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      // Unconditional network_id filter (was previously conditional on
      // enforceNetworkId being set; the new ntok guard above guarantees
      // it's non-null so the filter is always applied).
      const node = db.get<any>(
        "SELECT node_id, network_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
        callerAlias,
        enforceNetworkId,
      );
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update: null }) }] };
      }
      const update = db.get<any>(
        "SELECT update_id, patch_json, apply_mode, base_revision FROM node_config_updates WHERE node_id = ?1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        node.node_id,
      );
      if (!update) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update: null }) }] };
      }
      let patch: any = {};
      try { patch = JSON.parse(update.patch_json); } catch { patch = {}; }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            update: {
              update_id: update.update_id,
              patch,
              apply_mode: update.apply_mode,
              base_revision: update.base_revision,
            },
          }),
        }],
      };
    },
  );

  server.tool(
    "ack_config_update",
    "Node acknowledges a config update — applied / rejected / restarting / timeout. RFC-024.",
    {
      update_id: z.string().min(1).max(200),
      status: z.enum(["applied", "rejected", "restarting", "timeout"]),
      new_revision: z.number().int().min(0).optional(),
      error: z.string().max(2000).optional(),
    },
    async ({ update_id: updateId, status, new_revision: newRev, error: ackError }) => {
      // F-A (CHANGE_REQ): same ntok_ guard as get_config_update. Without
      // this, a utok_ whose username matches a node alias could ack
      // arbitrary updates within the alias-collision; the new ntok guard
      // closes that.
      if (!callerTokenIsNetwork || !enforceNetworkId) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "network_token_required" }) }] };
      }
      if (!callerAlias) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "alias_required" }) }] };
      }
      // Cross-tenant guard: the ack-er must own the update being acked.
      // Resolve node by caller's alias under the enforced network.
      // Network filter is unconditional (guard above guarantees non-null).
      const node = db.get<any>(
        "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2",
        callerAlias,
        enforceNetworkId,
      );
      if (!node) {
        // Silently ignore stale ack — return ok so the node doesn't retry forever.
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "alias_unknown" }) }] };
      }
      const update = db.get<any>(
        "SELECT update_id, node_id, status FROM node_config_updates WHERE update_id = ?1",
        updateId,
      );
      if (!update || update.node_id !== node.node_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "unknown_or_foreign_update" }) }] };
      }
      // Reject ack for already-terminal updates (idempotency).
      if (update.status === "applied" || update.status === "rejected" || update.status === "timeout") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ignored: "already_terminal", current_status: update.status }) }] };
      }

      const ackedAt = Date.now();
      if (status === "applied") {
        // Promote the node's config_revision to the new revision, atomically.
        const nextRev = (typeof newRev === "number" && newRev > 0) ? newRev : ((db.get<{ config_revision: number }>("SELECT config_revision FROM nodes WHERE node_id = ?1", node.node_id)?.config_revision || 0) + 1);
        db.run(
          `UPDATE node_config_updates SET status = 'applied', acked_at = ?1, new_revision = ?2 WHERE update_id = ?3`,
          [ackedAt, nextRev, updateId],
        );
        db.run(`UPDATE nodes SET config_revision = ?1 WHERE node_id = ?2`, [nextRev, node.node_id]);
      } else {
        db.run(
          `UPDATE node_config_updates SET status = ?1, acked_at = ?2, error = ?3 WHERE update_id = ?4`,
          [status, ackedAt, ackError || null, updateId],
        );
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, status }) }] };
    },
  );

  server.tool(
    "restart_node",
    "Trigger a node restart without changing config. RFC-024 Vincent 2026-06-28 increment. Network-scoped (SEC-1); member+ role suffices (lifecycle ops are not privilege elevation).",
    {
      node_id: z.string().min(1).max(200),
      network_id: z.string().max(200).optional(),
    },
    async ({ node_id: nodeId, network_id: clientNetId }) => {
      const effectiveNetId = getNetworkId(clientNetId);
      if (!canWrite(effectiveNetId)) return writeDeniedReply(effectiveNetId, "write");

      const { row: node, sec1Ok } = resolveTargetNode(nodeId, effectiveNetId);
      if (!node) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "node_not_found", node_id: nodeId }) }] };
      }
      if (!sec1Ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "cross_network_node" }) }] };
      }
      // F-B reaper: same stale-supersede semantics as update_node_config,
      // with same acked_at-anchored liveness clock (see update_node_config
      // for the 通信龙 polish reasoning).
      const STALE_THRESHOLD_MS_R = 60_000;
      const inFlight = db.get<{ update_id: string; created_at: number; acked_at: number | null }>(
        "SELECT update_id, created_at, acked_at FROM node_config_updates WHERE node_id = ?1 AND status IN ('pending', 'restarting') ORDER BY created_at DESC LIMIT 1",
        nodeId,
      );
      if (inFlight) {
        const ageAnchor = inFlight.acked_at ?? inFlight.created_at;
        const age = Date.now() - ageAnchor;
        if (age <= STALE_THRESHOLD_MS_R) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "update_in_flight", existing_update_id: inFlight.update_id, age_ms: age }) }] };
        }
        db.run(
          "UPDATE node_config_updates SET status = 'timeout', acked_at = ?1, error = ?2 WHERE update_id = ?3",
          [Date.now(), `superseded by restart_node after ${age}ms stale`, inFlight.update_id],
        );
      }
      const updateId = `cu_${uuidv4()}`;
      const networkId = node.network_id || "default";
      db.run(
        `INSERT INTO node_config_updates (update_id, node_id, network_id, patch_json, apply_mode, base_revision, status, created_at, created_by_token) VALUES (?1, ?2, ?3, '{}', 'restart_only', ?4, 'pending', ?5, ?6)`,
        [updateId, nodeId, networkId, node.config_revision || 0, Date.now(), callerTokenId || "unknown"],
      );
      pushEvent(node.alias, { type: "restart", update_id: updateId }, networkId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, update_id: updateId, apply_mode: "restart_only" }) }],
      };
    },
  );
}

// ────────────────────────────────────────────────────────────────────
// PR A SEC follow-up (#287 cross-tenant trust-root catch, 通信牛
// 2026-06-28) — exported so the production report_status path AND
// the regression test in config-apply-sec1.test.ts exercise the SAME
// code. Per 通信龙 test-quality finding: an inline-mirror test that
// re-implements the gate inside the test body provides zero
// protection against guard drift. By forcing both code paths through
// this single helper, deleting / weakening the gate fails the test.
//
// Returns a discriminated outcome so callers can log/route the refused
// case (production: silent skip + console.warn; tests: assertion).
// ────────────────────────────────────────────────────────────────────
export interface UpsertNodeWithSec1GuardInput {
  node_id: string;
  callerNetworkId: string | null;
  node_name?: string | null;
  alias?: string | null;
  runtime?: string | null;
  model?: string | null;
  config_path?: string | null;
  channels?: string | null;
  server?: string | null;
  hostname?: string | null;
  config_snapshot?: unknown | null;
}
export type UpsertNodeOutcome =
  | { result: "inserted" | "updated"; node_id: string }
  | { result: "refused"; reason: "cross_network"; existingNet: string | null; callerNet: string | null }
  | { result: "skipped"; reason: "missing_node_id" };

const _norm = (x: string | null | undefined) => (x === null || x === undefined ? "default" : x);

export function upsertNodeWithSec1Guard(input: UpsertNodeWithSec1GuardInput): UpsertNodeOutcome {
  if (!input.node_id) return { result: "skipped", reason: "missing_node_id" };
  const existing = db.get<{ network_id: string | null }>(
    "SELECT network_id FROM nodes WHERE node_id = ?1",
    input.node_id,
  );
  const callerNet = input.callerNetworkId;

  // Legacy / first-write paths: row missing OR network_id NULL → claim.
  const isLegacy = !existing
    || existing.network_id === null
    || existing.network_id === undefined;
  const sec1Ok = isLegacy || _norm(existing.network_id) === _norm(callerNet);

  if (!sec1Ok) {
    console.warn(
      `[commhub] 🚫 report_status cross-network node upsert refused: caller-net=${callerNet ?? "default"} existing-net=${existing!.network_id} node_id=${input.node_id}`,
    );
    return {
      result: "refused",
      reason: "cross_network",
      existingNet: existing!.network_id,
      callerNet,
    };
  }

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
    [
      input.node_id,
      input.node_name ?? input.alias ?? null,
      input.alias ?? null,
      input.runtime ?? null,
      input.model ?? null,
      input.config_path ?? null,
      input.channels ?? null,
      input.server ?? null,
      input.hostname ?? null,
      callerNet ?? null,
    ],
  );
  if (input.config_snapshot) {
    db.run(
      `UPDATE nodes SET config_snapshot = ?1 WHERE node_id = ?2`,
      [JSON.stringify(input.config_snapshot), input.node_id],
    );
  }
  return { result: existing ? "updated" : "inserted", node_id: input.node_id };
}
