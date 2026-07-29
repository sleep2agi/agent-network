import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import { registerTools } from "./tools.js";
import { db, logTaskEvent, logAudit } from "./db.js";
import { createSSEStream, createNetworkObserverStream, pushEvent, pushNetworkObserverEvent, getSSEStats } from "./push.js";
import { assertNodeActive } from "./lifecycle-guard.js";
import { validateAvatarUrl } from "./avatar-validate.js";
import { register, login, resolveToken, getUserNetworks, getUserAllNetworks, createNetwork, deleteNetwork, renameNetwork, changePassword, issueUserToken, listTokens, createToken, revokeToken, getNetworkMembers, getUserNetworkRole, addNetworkMember, updateMemberRole, removeNetworkMember, createInvite, joinByInvite, createNetworkTokenForNode, type AuthUser } from "./auth.js";
import { abortRename, cleanupCommittedRenameSessions, commitRename, prepareRename, resolveCanonicalAlias } from "./rename.js";
import { sharedSendDedup, buildDuplicateSendPayload } from "./send_dedup.js";
import { getLoginClientIp, sharedLoginFailureLockout, sharedLoginIpRateLimiter } from "./auth_login_guard.js";
import {
  FILE_ID_REGEX,
  MAX_REQUEST_CONTENT_LENGTH,
  MAX_UPLOAD_BYTES,
  buildStoragePath,
  generateFileId,
  getUploadsRoot,
  indexEntryPath,
  isPathInsideUploadsRoot,
  sanitizeExt,
  sharedUploadRateLimiter,
  stripHostLocalPathsForCrossHostSafe,
  validateAttachments,
  validateIndexEntry,
} from "./uploads.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "fs";
import { dirname as pathDirname } from "path";
import { startRetentionSweeper } from "./retention.js";
import { startStaleSessionSweeper } from "./stale-sweeper.js";

const PORT = Number(process.env.PORT) || 9200;
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.COMMHUB_AUTH_TOKEN;
const DEV_OPEN = process.argv.includes("--dev-open") || process.env.COMMHUB_DEV_OPEN === "1";
const TMUX_ENABLED = process.env.COMMHUB_ENABLE_TMUX === "1";
const SECURITY_LABEL = DEV_OPEN ? "⚠️ DEV OPEN MODE" : "🔒 secured";
const TMUX_ALLOWLIST = new Set(
  (process.env.COMMHUB_TMUX_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
let masterTokenDeprecationLogged = false;

if (AUTH_TOKEN) {
  console.warn("[commhub] COMMHUB_AUTH_TOKEN is deprecated and will be removed in v1.0. See RFC-001.");
}

// Read version from package.json so banners and /health stay in sync.
const SERVER_VERSION = (() => {
  try {
    const url = new URL("../package.json", import.meta.url);
    return JSON.parse(require("fs").readFileSync(url, "utf8")).version || "?";
  } catch { return "?"; }
})();

// In-memory log ring buffer — last N lines streamed via /api/server-logs.
// Wraps console.log/info/warn/error so EVERY existing log call lands here
// without source changes. Dashboard tails this buffer for "hub server log
// view" feature.
const LOG_RING_CAP = Number(process.env.COMMHUB_LOG_RING || 500);
type LogEntry = { ts: string; level: "log" | "info" | "warn" | "error"; line: string };
const logRing: LogEntry[] = [];
const _origConsole = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
function pushLog(level: LogEntry["level"], args: any[]) {
  const line = args.map(a => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ");
  logRing.push({ ts: new Date().toISOString(), level, line: line.slice(0, 4000) });
  if (logRing.length > LOG_RING_CAP) logRing.splice(0, logRing.length - LOG_RING_CAP);
}
console.log = (...args: any[]) => { pushLog("log", args); _origConsole.log(...args); };
console.info = (...args: any[]) => { pushLog("info", args); _origConsole.info(...args); };
console.warn = (...args: any[]) => { pushLog("warn", args); _origConsole.warn(...args); };
console.error = (...args: any[]) => { pushLog("error", args); _origConsole.error(...args); };

function normalizeMetaJson(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  // #222 cross-host safety — same sanitization as tools.ts so REST
  // /api/task and MCP send_task produce identical meta_json shapes.
  // Conditional: only strips `path` when `file_id` is also present
  // (preserves single-host feishu fallback per team rule — assume-unit-before-threshold: cap is in bytes
  // discipline of not breaking other call sites).
  try { return JSON.stringify(stripHostLocalPathsForCrossHostSafe(meta)); } catch { return null; }
}

// ── Rate limiter (in-memory, per IP) ──
const rateLimits = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string, maxPerMinute = 60): boolean {
  // Skip rate limiting for localhost/internal/unknown (dev/test)
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") return true;
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= maxPerMinute) return false;
  entry.count++;
  return true;
}
// Cleanup stale entries every 5 minutes. Interval is registered in
// startHub() (#476) — module scope must stay timer-free so importing
// this module neither holds the event loop open nor does periodic work.
function sweepStaleRateLimits(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}

// ── Factory: 每个请求创建新的 McpServer（stateless 模式）──
function createServer(clientIP?: string, enforceNetworkId?: string | null, enforceUserId?: string | null, callerAlias?: string | null, callerTokenIsNetwork = false, callerTokenId?: string | null): McpServer {
  const server = new McpServer({
    name: "commhub",
    version: "0.5.0",
  });
  registerTools(server, clientIP, enforceNetworkId, enforceUserId, callerAlias, callerTokenIsNetwork, callerTokenId);
  return server;
}

// ── Auth helper ─────────────────────────────────────
function requestToken(req: Request): string {
  const header = req.headers.get("Authorization")?.replace("Bearer ", "");
  const url = new URL(req.url);
  return header || url.searchParams.get("token") || "";
}

function isLegacyAuthToken(req: Request): boolean {
  const token = requestToken(req);
  return !!AUTH_TOKEN && token === AUTH_TOKEN;
}

function requireAuth(req: Request): Response | null {
  const token = requestToken(req);

  // V3: check api_tokens first
  if (token) {
    const resolved = resolveToken(token);
    if (resolved) return null; // valid user token
  }

  // Legacy: check global COMMHUB_AUTH_TOKEN
  if (!AUTH_TOKEN && DEV_OPEN) return null; // explicit local/dev open mode
  if (token === AUTH_TOKEN) {
    const u = new URL(req.url);
    const readOnlyApi = u.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS");
    if (!readOnlyApi) return Response.json({ ok: false, error: "master-token auth is deprecated; use admin utok_" }, { status: 401 });
    if (!masterTokenDeprecationLogged) {
      console.warn("[commhub] master-token auth is deprecated and will be removed in v1.0. See RFC-001.");
      masterTokenDeprecationLogged = true;
    }
    return null;
  }

  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function getClientIP(req: Request, server?: any): string {
  const direct = server?.requestIP?.(req)?.address;
  if (direct) return direct;
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : (req.headers.get("x-real-ip") ?? "unknown");
}

function isLocalhostIP(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

// Normalize the raw `agent` field into a canonical runtime identifier for the
// dashboard's Runtime badge. Returns null for unknown/absent agents so the
// frontend can fall back to a placeholder.
function normalizeRuntime(agent: unknown): string | null {
  if (typeof agent !== "string" || agent.length === 0) return null;
  if (agent === "claude-code") return "claude-code-cli";
  if (agent.startsWith("agent-node:codex")) return "codex-sdk";
  if (agent.startsWith("agent-node:claude")) return "claude-agent-sdk";
  if (agent.startsWith("agent-node:grok")) return "grok-build-acp";
  // RFC-029 — agent-node reports `agent-node:opencode` when RUNTIME
  // bucket resolves to "opencode". Dashboard needs the canonical
  // launcher name so its Runtime badge matches wizard choices.
  if (agent.startsWith("agent-node:opencode")) return "opencode-cli";
  if (agent === "http-api" || agent === "http" || agent === "api") return "http-api";
  return null;
}

function isTmuxAllowedIP(ip: string): boolean {
  return isLocalhostIP(ip) || TMUX_ALLOWLIST.has(ip);
}

function requireAdminAuth(req: Request): Response | null {
  const token = requestToken(req);
  if (!token) return Response.json({ ok: false, error: "auth required" }, { status: 401 });
  const resolved = resolveToken(token);
  if (!resolved) return Response.json({ ok: false, error: "invalid token" }, { status: 401 });
  if (resolved.user.role !== "admin") return Response.json({ ok: false, error: "admin required" }, { status: 403 });
  return null;
}

function requireTmuxAccess(req: Request, server?: any): Response | null {
  if (!TMUX_ENABLED) return Response.json({ ok: false, error: "tmux disabled" }, { status: 404 });
  const ip = getClientIP(req, server);
  if (!isTmuxAllowedIP(ip)) return Response.json({ ok: false, error: "tmux access denied from this ip" }, { status: 403 });
  return requireAdminAuth(req);
}

// Extract user + network + token-binding identity from request token.
function resolveRequestAuth(req: Request): { userId: string; networkId: string | null; username: string; tokenName: string | null; tokenId: string | null } | null {
  const token = requestToken(req);
  if (!token) return null;
  const resolved = resolveToken(token);
  if (!resolved) return null;
  return { userId: resolved.user.user_id, networkId: resolved.networkId, username: resolved.user.username, tokenName: resolved.tokenName, tokenId: resolved.tokenId };
}

type RestNetworkScope = {
  networkId: string | null;
  networkIds: string[] | null;
  denied?: string;
};

function getUserNetworkIds(userId: string): string[] {
  return db.all<{ network_id: string }>(
    "SELECT network_id FROM network_members WHERE user_id = ?1",
    userId
  ).map((row) => row.network_id);
}

function resolveRestNetworkScope(url: URL, authCtx: { userId: string; networkId: string | null } | null, isAdmin: boolean): RestNetworkScope {
  const requested = url.searchParams.get("network_id");

  // Legacy global token or open dev mode keeps the old global behavior.
  if (!authCtx) return { networkId: requested || null, networkIds: null };

  // Network tokens are forcibly scoped to their bound network.
  if (authCtx.networkId) return { networkId: authCtx.networkId, networkIds: null };

  // System admins may intentionally inspect all networks.
  if (isAdmin) return { networkId: requested || null, networkIds: null };

  if (requested) {
    const role = getUserNetworkRole(authCtx.userId, requested);
    if (!role) return { networkId: null, networkIds: [], denied: "access denied to requested network" };
    return { networkId: requested, networkIds: null };
  }

  return { networkId: null, networkIds: getUserNetworkIds(authCtx.userId) };
}

function addNetworkScope(sql: string, params: any[], scope: RestNetworkScope, column = "network_id"): string {
  if (scope.networkId) {
    sql += ` AND ${column} = ?${params.length + 1}`;
    params.push(scope.networkId);
  } else if (scope.networkIds) {
    if (scope.networkIds.length === 0) {
      sql += " AND 1=0";
    } else {
      const placeholders = scope.networkIds.map((_, i) => `?${params.length + i + 1}`).join(", ");
      sql += ` AND ${column} IN (${placeholders})`;
      params.push(...scope.networkIds);
    }
  }
  return sql;
}

function singleNetworkId(scope: RestNetworkScope): string | null {
  if (scope.networkId) return scope.networkId;
  if (scope.networkIds?.length === 1) return scope.networkIds[0];
  return null;
}

function sqliteTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function parseSqliteTime(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
}

function cpuPct(load: number | null | undefined, cores: number | null | undefined): number | null {
  if (typeof load !== "number" || typeof cores !== "number" || cores <= 0) return null;
  return Math.round((load / cores) * 1000) / 10;
}

function serverAlertLevel(row: any): { level: "green" | "yellow" | "red"; alerts: string[] } {
  const alerts: string[] = [];
  const pct = cpuPct(row?.cpu_load_1min, row?.cpu_cores);
  if (pct !== null && pct >= 80) alerts.push(`cpu ${pct}%`);
  if (typeof row?.mem_avail_gb === "number" && row.mem_avail_gb < 0.5) alerts.push(`memory ${row.mem_avail_gb}GB available`);
  if (typeof row?.disk_avail_gb === "number" && row.disk_avail_gb < 1) alerts.push(`disk ${row.disk_avail_gb}GB available`);
  if (alerts.length > 0) return { level: "red", alerts };

  if (pct !== null && pct >= 60) alerts.push(`cpu ${pct}%`);
  if (typeof row?.mem_avail_gb === "number" && row.mem_avail_gb < 1) alerts.push(`memory ${row.mem_avail_gb}GB available`);
  if (typeof row?.disk_avail_gb === "number" && row.disk_avail_gb < 5) alerts.push(`disk ${row.disk_avail_gb}GB available`);
  return { level: alerts.length > 0 ? "yellow" : "green", alerts };
}

function agentHealthChip(status: unknown, lastSeen: string | null | undefined): "online" | "offline" | "stale" {
  if (String(status || "").toLowerCase() === "offline") return "offline";
  const ts = parseSqliteTime(lastSeen);
  if (!ts || Date.now() - ts > 5 * 60 * 1000) return "stale";
  return "online";
}

function bucketTelemetry(rows: any[], fromMs: number, bucketMs: number) {
  const buckets = new Map<number, {
    ts: number;
    count: number;
    cpu_pct_sum: number;
    cpu_pct_count: number;
    cpu_load_sum: number;
    cpu_load_count: number;
    mem_avail_min: number | null;
    mem_used_max: number | null;
    disk_avail_min: number | null;
    disk_used_max: number | null;
  }>();

  for (const row of rows) {
    const ts = parseSqliteTime(row.created_at);
    if (!ts || ts < fromMs) continue;
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketTs) ?? {
      ts: bucketTs,
      count: 0,
      cpu_pct_sum: 0,
      cpu_pct_count: 0,
      cpu_load_sum: 0,
      cpu_load_count: 0,
      mem_avail_min: null,
      mem_used_max: null,
      disk_avail_min: null,
      disk_used_max: null,
    };
    bucket.count += 1;
    const pct = cpuPct(row.cpu_load_1min, row.cpu_cores);
    if (pct !== null) {
      bucket.cpu_pct_sum += pct;
      bucket.cpu_pct_count += 1;
    }
    if (typeof row.cpu_load_1min === "number") {
      bucket.cpu_load_sum += row.cpu_load_1min;
      bucket.cpu_load_count += 1;
    }
    if (typeof row.mem_avail_gb === "number") bucket.mem_avail_min = bucket.mem_avail_min === null ? row.mem_avail_gb : Math.min(bucket.mem_avail_min, row.mem_avail_gb);
    if (typeof row.mem_used_gb === "number") bucket.mem_used_max = bucket.mem_used_max === null ? row.mem_used_gb : Math.max(bucket.mem_used_max, row.mem_used_gb);
    if (typeof row.disk_avail_gb === "number") bucket.disk_avail_min = bucket.disk_avail_min === null ? row.disk_avail_gb : Math.min(bucket.disk_avail_min, row.disk_avail_gb);
    if (typeof row.disk_used_gb === "number") bucket.disk_used_max = bucket.disk_used_max === null ? row.disk_used_gb : Math.max(bucket.disk_used_max, row.disk_used_gb);
    buckets.set(bucketTs, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: new Date(b.ts).toISOString(),
      count: b.count,
      cpu_pct: b.cpu_pct_count ? Math.round((b.cpu_pct_sum / b.cpu_pct_count) * 10) / 10 : null,
      cpu_load_1min: b.cpu_load_count ? Math.round((b.cpu_load_sum / b.cpu_load_count) * 100) / 100 : null,
      mem_avail_gb: b.mem_avail_min,
      mem_used_gb: b.mem_used_max,
      disk_avail_gb: b.disk_avail_min,
      disk_used_gb: b.disk_used_max,
    }));
}

function canRestWriteNetwork(authCtx: { userId: string; networkId: string | null } | null, networkId: string | null, isAdmin: boolean): boolean {
  if (!authCtx) return true; // legacy global token or open dev mode
  if (isAdmin) return true;
  if (!networkId) return false;
  const role = getUserNetworkRole(authCtx.userId, networkId);
  return !!role && role !== "viewer";
}

type RestDeliveryTarget =
  | { state: "online"; alias: string; session: any }
  | { state: "offline"; alias: string; session: any; message: string }
  | { state: "not_found"; alias: string; message: string };

function resolveRestDeliveryTarget(alias: string, networkId: string | null): RestDeliveryTarget {
  const params: any[] = [alias];
  let sql = "SELECT status, updated_at, last_seen_at, node_id FROM sessions WHERE alias = ?1";
  if (networkId) {
    sql += " AND network_id = ?2";
    params.push(networkId);
  }
  const session = db.get<any>(sql, ...params);
  if (!session) {
    return { state: "not_found", alias, message: `alias not found: ${alias}` };
  }
  const lastSeen = session.last_seen_at || session.updated_at;
  const lastSeenAt = lastSeen ? new Date(String(lastSeen).replace(" ", "T") + "Z").getTime() : 0;
  const stale = !lastSeenAt || Date.now() - lastSeenAt > 5 * 60 * 1000;
  if (String(session.status || "").toLowerCase() === "offline" || stale) {
    return {
      state: "offline",
      alias,
      session,
      message: `alias is offline; task queued in inbox: ${alias}`,
    };
  }
  return { state: "online", alias, session };
}

function resolveRestNodeIdForAlias(alias: string, networkId: string | null): string | null {
  if (!alias || alias === "hub" || alias === "api") return null;
  const canonical = resolveCanonicalAlias(networkId, alias);
  const target = resolveRestDeliveryTarget(canonical.alias, networkId);
  return target.state === "not_found" ? null : (target.session?.node_id ?? null);
}

// ── REST input schema ───────────────────────────────
const TaskSchema = z.object({
  alias: z.string().min(1).max(200),
  task: z.string().min(1).max(10000),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  from: z.string().max(200).optional(),
  network_id: z.string().max(200).optional(),
  parent_task_id: z.string().max(200).optional(),
  ttl_seconds: z.number().min(1).max(86400).optional(),
  // #221 — top-level attachments mirror the MCP send_task tool. They are
  // merged into `meta.attachments` for persistence so the on-disk shape
  // stays unified regardless of transport (REST or MCP).
  attachments: z.any().optional(),
  meta: z.any().optional(),
});

const BroadcastSchema = z.object({
  message: z.string().min(1).max(10000),
  filter_server: z.string().max(200).optional(),
  filter_status: z.string().max(50).optional(),
});

// ── HTTP Server (Bun native) ────────────────────────
const CORS_ORIGINS = process.env.COMMHUB_CORS_ORIGINS
  ? process.env.COMMHUB_CORS_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:3001"];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  // CORS allowlist is driven entirely by COMMHUB_CORS_ORIGINS env (comma-separated).
  // Default (env unset) allows localhost dev origins only — see CORS_ORIGINS above.
  // No author-specific domains are hardcoded; production deployments must set
  // COMMHUB_CORS_ORIGINS explicitly. See docs/concepts/security.md "CORS 配置".
  const allowed = CORS_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

/**
 * #426 — append `charset=utf-8` to text-y Content-Type headers that
 * omit it. Legacy Windows clients (PowerShell 5.1 Invoke-RestMethod /
 * Invoke-WebRequest) default to ISO-8859-1 when the charset is
 * unspecified, which double-encodes our clean UTF-8 payloads on the
 * way in.
 *
 * Applied to Responses whose Content-Type header we can't influence at
 * construction time — notably the MCP SDK transport, which builds its
 * own `text/event-stream` / `application/json` reply. Response headers
 * from `fetch` are mutable, so this rewrites in place rather than
 * reconstructing the Response (which would break streamed bodies).
 *
 * No-ops when: charset is already set, the type is binary
 * (application/octet-stream, image/*, video/*, application/pdf, etc.),
 * or the header is missing entirely.
 */
function withUtf8CharsetContentType(res: Response): Response {
  const ct = res.headers.get("content-type");
  if (!ct) return res;
  if (/;\s*charset=/i.test(ct)) return res;
  const trimmed = ct.trim();
  // Text-y types that legacy clients decode via charset. Everything
  // else (binary, opaque) is left alone.
  if (
    trimmed === "application/json" ||
    trimmed.startsWith("text/") ||
    trimmed.startsWith("application/json;") ||
    trimmed === "application/ld+json" ||
    trimmed === "application/xml"
  ) {
    res.headers.set("content-type", `${trimmed}; charset=utf-8`);
  }
  return res;
}

// ── WebSocket tmux sessions ────────────────────────
const wsTmuxIntervals = new Map<object, ReturnType<typeof setInterval>>();


// ── Task expiration patrol (every 5 minutes) ──
// Registered in startHub() (#476): this WRITES the DB, so it must never
// run as an import side effect — a tool/test importing this module with
// COMMHUB_DB unset would patrol the production database.
function patrolExpiredTasks(): void {
  try {
    const result = db.run(
      `UPDATE tasks SET status = 'expired', completed_at = datetime('now')
       WHERE expires_at IS NOT NULL AND expires_at < datetime('now')
         AND status IN ('created', 'delivered')`
    );
    if (result.changes > 0) {
      console.log(`[patrol] expired ${result.changes} stale task(s)`);
      // Log events for expired tasks
      const expired = db.all<{ task_id: string }>(
        "SELECT task_id FROM tasks WHERE status = 'expired' AND completed_at >= datetime('now', '-1 minute')");
      for (const t of expired) logTaskEvent(t.task_id, null, "expired", "patrol");
    }
  } catch {}
}

// #434 — test-safety seam, same signature as PR #438 so the two branches
// merge cleanly. Wraps the sole Bun.serve config in a factory so
// integration tests can request an OS-assigned ephemeral port
// (`bootServer({ port: 0 })`) and read the actual bound port back from
// the returned server. In an aggregate `bun test` run only the FIRST test
// file's import boots the default server (module cache) — later files'
// PORT env is ignored, so a suite that hard-codes its own port gets
// ConnectionRefused on every fetch while still "running" (审查修复 per
// 通信龙 #461 review, finding 2). Suites boot a private instance via this
// seam instead. #438 additionally moves the default boot below under
// `import.meta.main`; until that lands, import keeps booting (pre-#434
// behavior) so the not-yet-migrated suites stay green.
//
// Note: `opts.port ?? PORT` uses nullish-coalescing on purpose — `||`
// would swallow a legitimate `0`. Same for hostname.
export function bootServer(opts?: { port?: number; hostname?: string }): ReturnType<typeof Bun.serve> {
return Bun.serve({
  port: opts?.port ?? PORT,
  hostname: opts?.hostname ?? HOST,
  idleTimeout: 255, // max value: keep SSE connections alive (seconds)
  // #221 — defense-in-depth cap on the raw request body. The /api/upload
  // handler also pre-checks Content-Length and post-checks parsed size
  // against the documented 12 MiB cap (MAX_UPLOAD_BYTES); this knob
  // simply guarantees Bun's own buffer won't grow past 13 MiB on any
  // route. Default Bun ceiling is 128 MiB which is too permissive for
  // a hub now exposed to the public internet.
  maxRequestBodySize: MAX_REQUEST_CONTENT_LENGTH,

  async fetch(req, server) {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── CORS preflight ──
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    // ── WebSocket: tmux terminal ──
    const wsMatch = url.pathname.match(/^\/ws\/tmux\/([a-zA-Z0-9_-]+)$/);
    if (wsMatch) {
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
      if (server.upgrade(req, { data: { tmuxName: wsMatch[1] } } as any)) return;
    }

    // ── MCP Streamable HTTP endpoint ──
    if (url.pathname === "/mcp") {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);
      const clientIP = getClientIP(req, server);
      // V3: resolve token → enforce network_id in all MCP tools.
      // utok_ (user token, not network-bound) is allowed — the tool layer
      // scopes to the user's accessible networks. Without this Dashboard
      // (which logs in as a user) cannot call send_task.
      const token = requestToken(req);
      const authCtx = resolveRequestAuth(req);
      const enforceNetId = authCtx?.networkId || null;
      // Derive the calling alias from the token name (e.g., 'node:视频审查')
      // so peer agents see the real sender instead of 'hub' on send_task.
      const callerAlias = authCtx?.tokenName?.startsWith("node:")
        ? authCtx.tokenName.slice("node:".length)
        : (authCtx?.username || null);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = createServer(clientIP, enforceNetId, authCtx?.userId || null, callerAlias, !!token?.startsWith("ntok_"), authCtx?.tokenId || null);
      await mcpServer.connect(transport);
      const response = await transport.handleRequest(req);
      // Disconnect after response to prevent McpServer leak
      setImmediate(() => mcpServer.close().catch(() => {}));
      // #426: the MCP SDK's WebStandardStreamableHTTPServerTransport builds
      // its own Response with `Content-Type: text/event-stream` (or
      // `application/json` for JSON-mode) but WITHOUT charset. Legacy
      // Windows clients (PowerShell 5.1 Invoke-WebRequest / RestMethod)
      // default to ISO-8859-1 when the charset is unspecified and 双重-
      // 编码 our clean UTF-8 payload on the way in — the reported
      // mojibake is client-side, but the header is what tells them to
      // guess. We can't tell the SDK to add it, so wrap the response and
      // rewrite the header. Streamed bodies (SSE) pass through untouched
      // because Response takes the original ReadableStream verbatim.
      return withUtf8CharsetContentType(response);
    }

    // ── #461 SSE network observer stream ──
    // GET /events/network/:network_id → 网络级摘要事件（new_task / new_reply
    // routing metadata only, no content）。Dashboard 用它实时感知第三方流量,
    // 退役 15s 软轮询。MUST be matched before the generic /events/(.+) route
    // below, which would otherwise swallow the path as a session name.
    //
    // Auth mirrors /events/:session's three paths:
    //   1. legacy AUTH_TOKEN (master) → any network
    //   2/3. ntok_ / utok_ → must CURRENTLY be a member of the requested
    //        network. Membership is checked unconditionally — there is NO
    //        token-bound-network shortcut. removeNetworkMember deletes the
    //        membership row but does NOT revoke the user's ntok, so the
    //        network_members lookup IS the revocation mechanism: an ntok
    //        bound to this network whose owner was removed must lose the
    //        stream (审查修复 per 通信龙 #461 review, finding 1).
    const netEventsMatch = url.pathname.match(/^\/events\/network\/(.+)$/);
    if (netEventsMatch && req.method === "GET") {
      const authErr = requireAuth(req);
      if (authErr) return authErr;
      const observedNetId = decodeURIComponent(netEventsMatch[1]);
      const authCtx = resolveRequestAuth(req);
      if (!authCtx && isLegacyAuthToken(req)) {
        return createNetworkObserverStream(observedNetId);
      }
      if (!authCtx) {
        return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 403 }));
      }
      const observerRole = getUserNetworkRole(authCtx.userId, observedNetId);
      if (!observerRole) {
        return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));
      }
      return createNetworkObserverStream(observedNetId);
    }

    // ── SSE push: Agent 实时接收任务推送 ──
    // GET /events/知识哥 → 保持长连接，send_task 时秒推
    const eventsMatch = url.pathname.match(/^\/events\/(.+)$/);
    if (eventsMatch && req.method === "GET") {
      const authErr = requireAuth(req);
      if (authErr) return authErr;
      const sessionName = decodeURIComponent(eventsMatch[1]);
      const token = requestToken(req);
      const authCtx = resolveRequestAuth(req);
      const scopedNetId = authCtx?.networkId || url.searchParams.get("network_id");

      // ── Path 1: legacy AUTH_TOKEN (master token) — unchanged ──
      if (!authCtx && isLegacyAuthToken(req)) {
        if (scopedNetId) {
          const session = db.get<any>(
            "SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2",
            sessionName, scopedNetId
          );
          if (!session) return withCors(req, Response.json({ ok: false, error: "session not in requested network" }, { status: 403 }));
        }
        return createSSEStream(sessionName, scopedNetId);
      }

      // ── Path 2: ntok_ (network-bound agent token) — pre-#247 behavior preserved ──
      if (token?.startsWith("ntok_")) {
        if (!authCtx || !scopedNetId) {
          return withCors(req, Response.json({ ok: false, error: "network-scoped token required for SSE" }, { status: 403 }));
        }
        const role = getUserNetworkRole(authCtx.userId, scopedNetId);
        if (!role) return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));
        const session = db.get<any>(
          "SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2",
          sessionName, scopedNetId
        );
        if (!session && authCtx.networkId !== scopedNetId) {
          return withCors(req, Response.json({ ok: false, error: "session not in requested network" }, { status: 403 }));
        }
        return createSSEStream(sessionName, scopedNetId);
      }

      // ── Path 3 (#247): utok_ (user token, dashboard SSE path) — 4 gates ──
      //
      // Pre-#247 the only V3 path required `ntok_` and rejected `utok_` outright,
      // which locked the dashboard out of SSE (the dashboard proxy authenticates
      // with the user's `utok_`). That broke real-time chat updates — replies
      // were persisted but never live-pushed to the UI.
      //
      // Auth-scoping rules (all four must pass — see #247 design):
      //   gate 1: token resolves to a valid user context (authCtx non-null)
      //   gate 2: network scope is explicit — `utok_` has no implicit network,
      //           so the caller must pass `?network_id=<id>`
      //   gate 3: user is a member of that network (any role: owner / admin / member)
      //   gate 4: channel-ownership — one of:
      //           (a) sessionName === own username (the dashboard's default channel —
      //               `send_reply` pushes to the original sender's alias which equals
      //               the dashboard user's username; NO `sessions` row required for
      //               this branch since the dashboard user is not a registered agent)
      //           (b) sessionName is an existing agent alias in `scopedNetId`
      //               (lets members monitor agents within their network)
      //
      // Security: rule 4(a) uses strict equality, so a `utok_` user cannot subscribe
      // to another user's username channel (no cross-user eavesdrop). Rule 4(b) is
      // scoped to `scopedNetId` + gate 3 membership, so cross-network eavesdrop is
      // blocked too. There is intentionally NO org-admin bypass — even users with
      // global `admin` role must be a member of the network they want to listen on.
      if (!authCtx) {
        return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 403 }));
      }
      if (!scopedNetId) {
        return withCors(req, Response.json({
          ok: false,
          error: "network_id required (utok has no implicit network; pass ?network_id=<id>)"
        }, { status: 403 }));
      }
      const utokRole = getUserNetworkRole(authCtx.userId, scopedNetId);
      if (!utokRole) {
        return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));
      }
      if (sessionName === authCtx.username) {
        return createSSEStream(sessionName, scopedNetId);
      }
      const utokSession = db.get<any>(
        "SELECT 1 FROM sessions WHERE alias = ?1 AND network_id = ?2",
        sessionName, scopedNetId
      );
      if (!utokSession) {
        return withCors(req, Response.json({
          ok: false,
          error: "channel not allowed: must be your username or an existing agent in your network"
        }, { status: 403 }));
      }
      return createSSEStream(sessionName, scopedNetId);
    }

    // ── V3: License endpoints ──
    if (url.pathname === "/api/license" && req.method === "GET") {
      const license = db.get<any>("SELECT * FROM licenses ORDER BY created_at LIMIT 1");
      if (!license) return withCors(req, Response.json({ ok: true, status: "no_license" }));
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      const expired = license.expires_at && license.expires_at < now;
      const daysLeft = license.expires_at
        ? Math.max(0, Math.ceil((new Date(license.expires_at).getTime() - Date.now()) / 86400000))
        : null;
      return withCors(req, Response.json({
        ok: true,
        license: { type: license.type, expires_at: license.expires_at, days_left: daysLeft, expired },
        limits: { max_agents: license.max_agents, max_networks: license.max_networks, max_tasks_day: license.max_tasks_day },
      }));
    }

    if (url.pathname === "/api/license/activate" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const key = body.key;
        if (!key) return withCors(req, Response.json({ ok: false, error: "key required" }, { status: 400 }));
        // For now: accept any key starting with "anet-" as valid pro license
        if (!key.startsWith("anet-") || key.length < 16) {
          return withCors(req, Response.json({ ok: false, error: "invalid license key" }, { status: 400 }));
        }
        // Upgrade existing license or create new
        db.run("DELETE FROM licenses");
        const licId = `lic_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        db.run(
          "INSERT INTO licenses (id, license_key, type, max_agents, max_networks, max_tasks_day, activated_at, expires_at) VALUES (?1, ?2, 'pro', 50, 10, 10000, datetime('now'), datetime('now', '+365 days'))",
          [licId, key]
        );
        return withCors(req, Response.json({ ok: true, type: "pro", expires_in_days: 365 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Auth endpoints (public) ──
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
      if (!checkRateLimit(clientIP, 30)) {
        return withCors(req, Response.json({ ok: false, error: "too many requests, try again later" }, { status: 429 }));
      }
      try {
        const body = await req.json() as any;
        const result = register(body.username, body.password, body.email, body.display_name);
        if (result.ok) logAudit(result.user!.user_id, body.username, "register", "user", result.user!.user_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const clientIP = getLoginClientIp(req);
      const ipRate = sharedLoginIpRateLimiter.check(clientIP || "unknown");
      if (!ipRate.allowed) {
        logAudit(null, null, "login_rate_limited", "auth", undefined, clientIP);
        return withCors(req, Response.json(
          { ok: false, error: "rate_limited", message: "Too many login attempts. Try again later.", retry_after_ms: ipRate.retryAfterMs },
          { status: 429, headers: { "Retry-After": String(Math.ceil((ipRate.retryAfterMs ?? 1000) / 1000)) } }
        ));
      }
      try {
        const body = await req.json() as any;
        const lock = sharedLoginFailureLockout.check(body.username);
        if (lock.locked) {
          logAudit(null, body.username, "login_locked", "auth", undefined, `retry_after_ms=${lock.retryAfterMs ?? 0}`);
          return withCors(req, Response.json(
            { ok: false, error: "login_locked", message: "Too many failed login attempts. Try again later.", retry_after_ms: lock.retryAfterMs },
            { status: 429, headers: { "Retry-After": String(Math.ceil((lock.retryAfterMs ?? 1000) / 1000)) } }
          ));
        }
        const result = login(body.username, body.password);
        if (result.ok) {
          sharedLoginFailureLockout.recordSuccess(body.username);
          logAudit(result.user!.user_id, body.username, "login", "user", result.user!.user_id);
        } else {
          const failure = sharedLoginFailureLockout.recordFailure(body.username);
          if (failure.locked) {
            const safeUsername = String(body.username ?? "").replace(/[\r\n\t]/g, " ").slice(0, 80);
            console.warn(`[auth] login locked for username=${safeUsername} failures=${failure.failures} retry_after_ms=${failure.lockMs}`);
          }
          logAudit(null, body.username, "login_failed", "user", undefined, "invalid credentials");
        }
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 401 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networks = getUserAllNetworks(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, user: resolved.user, networks, current_network: resolved.networkId }));
    }

    if (url.pathname === "/api/auth/me" && req.method === "PUT") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const updates: string[] = [];
        const params: any[] = [];
        if (body.display_name) { updates.push(`display_name = ?${params.length + 1}`); params.push(body.display_name); }
        if (body.email) { updates.push(`email = ?${params.length + 1}`); params.push(body.email); }
        if (updates.length > 0) {
          updates.push(`updated_at = datetime('now')`);
          params.push(resolved.user.user_id);
          db.run(`UPDATE users SET ${updates.join(", ")} WHERE user_id = ?${params.length}`, params);
        }
        // Re-fetch
        const user = db.get<any>("SELECT user_id, username, display_name, email, role FROM users WHERE user_id = ?1", resolved.user.user_id);
        return withCors(req, Response.json({ ok: true, user }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/auth/password" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = changePassword(resolved.user.user_id, body.old_password, body.new_password, resolved.tokenId);
        if (result.ok) {
          const issued = issueUserToken(resolved.user.user_id, "password-change");
          if (resolved.tokenId) revokeToken(resolved.user.user_id, resolved.tokenId);
          logAudit(resolved.user.user_id, resolved.user.username, "password_changed", "user", resolved.user.user_id);
          return withCors(req, Response.json({ ...result, token: issued.token, token_id: issued.token_id }));
        }
        return withCors(req, Response.json(result, { status: 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3.13: Create network token for a node ──
    if (url.pathname === "/api/auth/node-token" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.network_id || !body.node_name) return withCors(req, Response.json({ ok: false, error: "network_id and node_name required" }, { status: 400 }));
        const result = createNetworkTokenForNode(resolved.user.user_id, body.network_id, body.node_name);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_token_created", "network", body.network_id, body.node_name);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── #84: node rename 2PC — Server surface (RFC-010 §4) ──
    // The CLI orchestrates the 2PC; these endpoints are the Server steps:
    // prepare = PHASE 1 P3, commit = PHASE 2 C1, abort = PHASE 1 rollback.
    if (url.pathname === "/api/node-rename/prepare" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.network_id || !body.old_alias || !body.new_alias) {
          return withCors(req, Response.json({ ok: false, error: "network_id, old_alias, new_alias required" }, { status: 400 }));
        }
        const result = prepareRename(resolved.user.user_id, body.network_id, body.old_alias, body.new_alias);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_prepared", "node", body.old_alias, body.new_alias);
        return withCors(req, Response.json(result, { status: result.ok || result.code === "node_local_only" ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/node-rename/commit" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.txn_id) return withCors(req, Response.json({ ok: false, error: "txn_id required" }, { status: 400 }));
        const result = commitRename(resolved.user.user_id, body.txn_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_committed", "node", body.txn_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    if (url.pathname === "/api/node-rename/abort" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (!body.txn_id) return withCors(req, Response.json({ ok: false, error: "txn_id required" }, { status: 400 }));
        const result = abortRename(resolved.user.user_id, body.txn_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "node_rename_aborted", "node", body.txn_id);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3: Token management ──
    if (url.pathname === "/api/auth/tokens" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const tokens = listTokens(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, tokens }));
    }

    if (url.pathname === "/api/auth/tokens" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = createToken(resolved.user.user_id, body.name || "api-token", body.network_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "token_created", "token", result.token_id);
        return withCors(req, Response.json(result));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    const tokenDeleteMatch = url.pathname.match(/^\/api\/auth\/tokens\/([^/]+)$/);
    if (tokenDeleteMatch && req.method === "DELETE") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const result = revokeToken(resolved.user.user_id, tokenDeleteMatch[1]);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "token_revoked", "token", tokenDeleteMatch[1]);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 404 }));
    }

    // ── V3: Network management ──
    if (url.pathname === "/api/networks" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      // V3.13: ntok_ can only see its bound network; utok_ sees all member networks
      if (resolved.networkId) {
        // ntok_ — only return the bound network
        const net = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", resolved.networkId);
        return withCors(req, Response.json({ ok: true, networks: net ? [net] : [] }));
      }
      const networks = getUserAllNetworks(resolved.user.user_id);
      return withCors(req, Response.json({ ok: true, networks }));
    }

    if (url.pathname === "/api/networks" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "token required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        const result = createNetwork(resolved.user.user_id, body.name, body.description);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── V3.13: Network members + invites ──
    const membersMatch = url.pathname.match(/^\/api\/networks\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (membersMatch) {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const netId = membersMatch[1];
      const targetUid = membersMatch[2];
      const callerRole = getUserNetworkRole(resolved.user.user_id, netId);
      if (!callerRole) return withCors(req, Response.json({ ok: false, error: "not a member of this network" }, { status: 403 }));

      if (req.method === "GET") {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const members = getNetworkMembers(netId);
        return withCors(req, Response.json({ ok: true, members }));
      }
      if (req.method === "POST") {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const body = await req.json() as any;
        const result = addNetworkMember(netId, body.user_id, body.role || "member", resolved.user.user_id);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_added", "network", netId, `${body.user_id} as ${body.role || "member"}`);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
      if (req.method === "PUT" && targetUid) {
        if (callerRole !== "owner") return withCors(req, Response.json({ ok: false, error: "owner required" }, { status: 403 }));
        const body = await req.json() as any;
        const result = updateMemberRole(netId, targetUid, body.role);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_role_changed", "network", netId, `${targetUid} → ${body.role}`);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
      if (req.method === "DELETE" && targetUid) {
        if (!["owner", "admin"].includes(callerRole)) return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
        const result = removeNetworkMember(netId, targetUid);
        if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "member_removed", "network", netId, targetUid);
        return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
      }
    }

    if (url.pathname.match(/^\/api\/networks\/([^/]+)\/invite$/) && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const netId = url.pathname.split("/")[3];
      const callerRole = getUserNetworkRole(resolved.user.user_id, netId);
      if (!callerRole || !["owner", "admin"].includes(callerRole)) {
        return withCors(req, Response.json({ ok: false, error: "owner/admin required" }, { status: 403 }));
      }
      const body = await req.json() as any;
      const result = createInvite(netId, resolved.user.user_id, body.role || "member", body.max_uses || 1, body.expires_days);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "invite_created", "network", netId, result.invite_code);
      return withCors(req, Response.json(result));
    }

    if (url.pathname === "/api/networks/join" && req.method === "POST") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const body = await req.json() as any;
      const result = joinByInvite(body.invite_code, resolved.user.user_id);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_joined", "network", result.network_id, `via invite, role=${result.role}`);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
    }

    // ── V3: Admin APIs (require auth) ──
    if (url.pathname === "/api/users" && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved || resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "admin required" }, { status: 403 }));
      }
      const users = db.all("SELECT user_id, username, display_name, email, role, created_at FROM users ORDER BY created_at");
      return withCors(req, Response.json({ ok: true, users }));
    }

    const netDetailMatch = url.pathname.match(/^\/api\/networks\/([^/]+)$/);
    if (netDetailMatch && req.method === "GET") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const networkId = netDetailMatch[1];
      const network = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", networkId);
      if (!network) return withCors(req, Response.json({ ok: false, error: "network not found" }, { status: 404 }));
      // Membership check: must be a member or system admin
      const viewerRole = getUserNetworkRole(resolved.user.user_id, networkId);
      if (!viewerRole && resolved.user.role !== "admin") {
        return withCors(req, Response.json({ ok: false, error: "access denied" }, { status: 403 }));
      }
      // Get network stats
      const nodeCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM nodes WHERE network_id = ?1", networkId);
      const sessionCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions WHERE network_id = ?1", networkId);
      const taskStats = db.all<any>("SELECT status, COUNT(*) as count FROM tasks WHERE network_id = ?1 GROUP BY status", networkId);
      return withCors(req, Response.json({
        ok: true, network,
        stats: { nodes: nodeCount?.cnt || 0, sessions: sessionCount?.cnt || 0, tasks: taskStats },
      }));
    }

    if (netDetailMatch && req.method === "DELETE") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const result = deleteNetwork(resolved.user.user_id, netDetailMatch[1]);
      if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_deleted", "network", netDetailMatch[1]);
      return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
    }

    if (netDetailMatch && req.method === "PUT") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      try {
        const body = await req.json() as any;
        if (body.name) {
          const result = renameNetwork(resolved.user.user_id, netDetailMatch[1], body.name);
          if (result.ok) logAudit(resolved.user.user_id, resolved.user.username, "network_renamed", "network", netDetailMatch[1], body.name);
          return withCors(req, Response.json(result, { status: result.ok ? 200 : 400 }));
        }
        return withCors(req, Response.json({ ok: false, error: "name required" }, { status: 400 }));
      } catch (e: any) {
        return withCors(req, Response.json({ ok: false, error: e.message }, { status: 400 }));
      }
    }

    // ── REST: health (public, no auth) ──
    if (url.pathname === "/health") {
      const count = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions");
      const sse = getSSEStats();
      const license = db.get<any>("SELECT type, expires_at FROM licenses LIMIT 1");
      return withCors(req, Response.json({
        ok: true,
        version: SERVER_VERSION,
        api_version: "v3",
        transport: "streamable-http",
        sessions_count: count?.cnt ?? 0,
        sse_connections: sse.total,
        sse_sessions: sse.sessions,
        auth: DEV_OPEN ? "dev-open" : "user-token",
        security: DEV_OPEN ? "dev-open" : "secured",
        tmux: TMUX_ENABLED ? "enabled" : "disabled",
        v3_auth: true,
        multi_network: true,
        license: license?.type || "none",
        uptime: Math.floor(process.uptime()),
      }));
    }

    // ── All REST /api endpoints require auth (if token configured) ──
    const authErr = requireAuth(req);
    if (authErr) return withCors(req, authErr);

    // Resolve network scope for REST queries — enforce isolation
    // Token-bound networkId takes precedence (ntok_ → forced), then query param
    const restAuth = resolveRequestAuth(req);
    const isAdmin = !!(restAuth?.username && db.get<any>("SELECT role FROM users WHERE username = ?1", restAuth.username)?.role === "admin");
    const restScope = resolveRestNetworkScope(url, restAuth, isAdmin);
    if (restScope.denied) {
      return withCors(req, Response.json({ ok: false, error: restScope.denied }, { status: 403 }));
    }

    // ── REST: all sessions status ──
    if (url.pathname === "/api/status") {
      // Round-2/4 review ③: stale-marking moved to startStaleSessionSweeper()
      // (background timer, ~60s cadence). Read paths no longer fire UPDATE.
      // Per-request UPDATE was a write-amp vector — see stale-sweeper.ts.
      cleanupCommittedRenameSessions(restScope.networkId ? [restScope.networkId] : restScope.networkIds ?? null);
      // `?light=1` returns a narrow projection (alias / status / agent / task /
      // server / updated_at + runtime + network_id) — used by the mobile APP
      // list view, where pulling 30+ fields × 150 agents was making cold open
      // take 12s+ on flaky cellular (Vincent tg, #220 PWA). Default response
      // is unchanged so the dashboard / scripts that read full telemetry are
      // unaffected.
      const isLight = url.searchParams.get("light") === "1";
      const params: any[] = [];
      let sql = isLight
        ? "SELECT alias, status, agent, task, server, updated_at, network_id FROM sessions WHERE 1=1"
        : "SELECT * FROM sessions WHERE 1=1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY updated_at DESC";
      // `model` comes straight from the sessions row (SELECT *); `runtime` is
      // derived from the raw `agent` field. Both default to null for old nodes
      // that never reported a model — the dashboard falls back to a placeholder.
      const sessions = db.all(sql, ...params).map((s: any) => {
        if (isLight) {
          return {
            alias: s.alias,
            status: s.status,
            agent: s.agent ?? null,
            task: s.task ?? null,
            server: s.server ?? null,
            updated_at: s.updated_at ?? null,
            runtime: normalizeRuntime(s.agent),
            network_id: s.network_id ?? null,
          };
        }
        return {
          ...s,
          model: s.model ?? null,
          runtime: normalizeRuntime(s.agent),
          host: {
            hostname: s.hostname ?? null,
            ip: s.ip ?? null,
            cpu_load_1min: s.cpu_load_1min ?? null,
            cpu_cores: s.cpu_cores ?? null,
            mem_total_gb: s.mem_total_gb ?? null,
            mem_used_gb: s.mem_used_gb ?? null,
            mem_avail_gb: s.mem_avail_gb ?? null,
            disk_total_gb: s.disk_total_gb ?? null,
            disk_used_gb: s.disk_used_gb ?? null,
            disk_avail_gb: s.disk_avail_gb ?? null,
          },
          process_telemetry: {
            rss_bytes: s.process_rss_bytes ?? null,
            rss_mb: s.process_rss_mb ?? null,
            cpu_pct: s.process_cpu_pct ?? null,
            uptime_seconds: s.process_uptime_seconds ?? null,
            in_flight_count: s.process_in_flight_count ?? null,
          },
        };
      });
      const summary = sessions.reduce((acc: any, session: any) => {
        const raw = String(session.status || "").toLowerCase();
        if (raw === "offline") acc.offline++;
        else if (["working", "blocked", "error", "waiting_input", "running", "busy"].includes(raw)) acc.working++;
        else acc.idle++;
        return acc;
      }, { idle: 0, working: 0, offline: 0, total: sessions.length });
      return withCors(req, Response.json({ ok: true, sessions, summary }));
    }

    // ── REST: aggregate agents by physical server ──
    if (url.pathname === "/api/servers") {
      // Round-2/4 review ③: stale-marking moved to background sweeper.
      const params: any[] = [];
      let sql = `
        SELECT hostname, ip, cpu_load_1min, cpu_cores, mem_avail_gb, mem_used_gb,
               COALESCE(last_seen_at, updated_at) AS last_seen
        FROM sessions
        WHERE 1=1
      `;
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY COALESCE(last_seen_at, updated_at) DESC";

      const grouped = new Map<string, {
        hostname: string;
        ip: string;
        agent_count: number;
        cpu_load_1min: number | null;
        cpu_cores: number | null;
        mem_avail_gb: number | null;
        mem_used_gb: number | null;
        last_seen: string | null;
      }>();

      const preferDisplayIp = (current: string, next: string) => {
        const isWeak = (ip: string) => !ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1";
        if (isWeak(current) && !isWeak(next)) return next;
        return current;
      };
      const hasHostTelemetry = (row: any) =>
        row.cpu_load_1min != null || row.cpu_cores != null || row.mem_avail_gb != null || row.mem_used_gb != null;

      for (const row of db.all<any>(sql, ...params)) {
        const hostname = row.hostname || "unknown";
        const ip = row.ip || "unknown";
        // Group primarily by hostname. A single host can report both a
        // routable/container IP and loopback (127.0.0.1); splitting those
        // into separate cards makes the dashboard show one useful load row
        // plus one "n/a" duplicate. Unknown hostnames still fall back to IP.
        const key = hostname !== "unknown" ? `host:${hostname}` : `ip:${ip}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.agent_count += 1;
          existing.ip = preferDisplayIp(existing.ip, ip);
          if (parseSqliteTime(row.last_seen) > parseSqliteTime(existing.last_seen)) existing.last_seen = row.last_seen ?? existing.last_seen;
          if (hasHostTelemetry(row) && (
            existing.cpu_load_1min == null ||
            existing.cpu_cores == null ||
            existing.mem_avail_gb == null ||
            existing.mem_used_gb == null
          )) {
            existing.cpu_load_1min = row.cpu_load_1min ?? existing.cpu_load_1min;
            existing.cpu_cores = row.cpu_cores ?? existing.cpu_cores;
            existing.mem_avail_gb = row.mem_avail_gb ?? existing.mem_avail_gb;
            existing.mem_used_gb = row.mem_used_gb ?? existing.mem_used_gb;
          }
          continue;
        }
        grouped.set(key, {
          hostname,
          ip,
          agent_count: 1,
          cpu_load_1min: row.cpu_load_1min ?? null,
          cpu_cores: row.cpu_cores ?? null,
          mem_avail_gb: row.mem_avail_gb ?? null,
          mem_used_gb: row.mem_used_gb ?? null,
          last_seen: row.last_seen ?? null,
        });
      }

      return withCors(req, Response.json(Array.from(grouped.values())));
    }

    const serverDetailMatch = url.pathname.match(/^\/api\/server\/([^/]+)\/(health|agents)$/);
    if (serverDetailMatch && req.method === "GET") {
      const host = decodeURIComponent(serverDetailMatch[1]);
      const detailKind = serverDetailMatch[2];
      if (!host) return withCors(req, Response.json({ ok: false, error: "host required" }, { status: 400 }));

      // Round-2/4 review ③: stale-marking moved to background sweeper.
      if (detailKind === "agents") {
        const params: any[] = [host, host];
        let sql = `
          SELECT alias, agent, status, task, progress, model, hostname, ip,
                 cpu_load_1min, cpu_cores, mem_avail_gb, mem_used_gb, mem_total_gb,
                 disk_avail_gb, disk_used_gb, disk_total_gb,
                 process_rss_bytes, process_rss_mb, process_cpu_pct, process_uptime_seconds, process_in_flight_count,
                 COALESCE(last_seen_at, updated_at) AS last_seen
          FROM sessions
          WHERE (hostname = ?1 OR ip = ?2)
        `;
        sql = addNetworkScope(sql, params, restScope);
        sql += " ORDER BY alias";
        const agents = db.all<any>(sql, ...params).map((s) => ({
          alias: s.alias,
          runtime: normalizeRuntime(s.agent),
          raw_agent: s.agent ?? null,
          model: s.model ?? null,
          status: s.status ?? "offline",
          task: s.task ?? null,
          progress: s.progress ?? 0,
          last_seen: s.last_seen ?? null,
          health: agentHealthChip(s.status, s.last_seen),
          hostname: s.hostname ?? null,
          ip: s.ip ?? null,
          telemetry: {
            cpu_load_1min: s.cpu_load_1min ?? null,
            cpu_cores: s.cpu_cores ?? null,
            cpu_pct: cpuPct(s.cpu_load_1min, s.cpu_cores),
            mem_total_gb: s.mem_total_gb ?? null,
            mem_used_gb: s.mem_used_gb ?? null,
            mem_avail_gb: s.mem_avail_gb ?? null,
            disk_total_gb: s.disk_total_gb ?? null,
            disk_used_gb: s.disk_used_gb ?? null,
            disk_avail_gb: s.disk_avail_gb ?? null,
            process_rss_bytes: s.process_rss_bytes ?? null,
            process_rss_mb: s.process_rss_mb ?? null,
            process_cpu_pct: s.process_cpu_pct ?? null,
            process_uptime_seconds: s.process_uptime_seconds ?? null,
            process_in_flight_count: s.process_in_flight_count ?? null,
          },
          process_telemetry: {
            rss_bytes: s.process_rss_bytes ?? null,
            rss_mb: s.process_rss_mb ?? null,
            cpu_pct: s.process_cpu_pct ?? null,
            uptime_seconds: s.process_uptime_seconds ?? null,
            in_flight_count: s.process_in_flight_count ?? null,
          },
        }));
        if (agents.length === 0) return withCors(req, Response.json({ ok: false, error: "server not found" }, { status: 404 }));
        return withCors(req, Response.json({ ok: true, host, agent_count: agents.length, agents }));
      }

      const latestParams: any[] = [host, host];
      let latestSql = `
        SELECT hostname, ip, COUNT(*) OVER () AS agent_count,
               cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb,
               disk_total_gb, disk_used_gb, disk_avail_gb,
               COALESCE(last_seen_at, updated_at) AS last_seen
        FROM sessions
        WHERE (hostname = ?1 OR ip = ?2)
      `;
      latestSql = addNetworkScope(latestSql, latestParams, restScope);
      latestSql += " ORDER BY COALESCE(last_seen_at, updated_at) DESC LIMIT 1";
      const latest = db.get<any>(latestSql, ...latestParams);
      if (!latest) return withCors(req, Response.json({ ok: false, error: "server not found" }, { status: 404 }));

      const since24h = sqliteTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const histParams: any[] = [host, host, since24h];
      let histSql = `
        SELECT created_at, cpu_load_1min, cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb,
               disk_total_gb, disk_used_gb, disk_avail_gb
        FROM agent_telemetry
        WHERE (hostname = ?1 OR ip = ?2) AND created_at >= ?3
      `;
      histSql = addNetworkScope(histSql, histParams, restScope);
      histSql += " ORDER BY created_at ASC";
      const historyRows = db.all<any>(histSql, ...histParams);
      const now = Date.now();
      const alert = serverAlertLevel(latest);

      return withCors(req, Response.json({
        ok: true,
        host,
        hostname: latest.hostname ?? null,
        ip: latest.ip ?? null,
        agent_count: latest.agent_count ?? 0,
        alert_level: alert.level,
        alerts: alert.alerts,
        latest: {
          cpu_load_1min: latest.cpu_load_1min ?? null,
          cpu_cores: latest.cpu_cores ?? null,
          cpu_pct: cpuPct(latest.cpu_load_1min, latest.cpu_cores),
          mem_total_gb: latest.mem_total_gb ?? null,
          mem_used_gb: latest.mem_used_gb ?? null,
          mem_avail_gb: latest.mem_avail_gb ?? null,
          disk_total_gb: latest.disk_total_gb ?? null,
          disk_used_gb: latest.disk_used_gb ?? null,
          disk_avail_gb: latest.disk_avail_gb ?? null,
          last_seen: latest.last_seen ?? null,
        },
        history: {
          "5m": bucketTelemetry(historyRows, now - 5 * 60 * 1000, 60 * 1000),
          "1h": bucketTelemetry(historyRows, now - 60 * 60 * 1000, 5 * 60 * 1000),
          "24h": bucketTelemetry(historyRows, now - 24 * 60 * 60 * 1000, 60 * 60 * 1000),
        },
      }));
    }

    // ── REST: file upload (#221) ──
    // POST multipart/form-data with a single `file` field. Bearer auth.
    // 12 MiB cap (two-stage: Content-Length pre-check + post-parse size
    // verify). Returns { ok, file_id, path, url, size, mime }. The
    // file_id is server-generated (crypto.randomUUID with hyphens
    // stripped) so a client-supplied filename never enters the storage
    // path. The download URL `/api/files/<file_id>` requires the same
    // Bearer auth and forces Content-Disposition: attachment +
    // X-Content-Type-Options: nosniff so uploaded files can never be
    // executed or served as HTML.
    if (url.pathname === "/api/upload" && req.method === "POST") {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);

      // Rate-limit key prefers the token id (so 60/h is per-token, not
      // per-IP); falls back to IP for legacy or anonymous-but-dev-open.
      const authCtx = resolveRequestAuth(req);
      const rateKey = authCtx?.tokenId ?? `ip:${getClientIP(req, server)}`;
      const rate = sharedUploadRateLimiter.check(rateKey);
      if (!rate.allowed) {
        const headers: Record<string, string> = {
          "X-RateLimit-Limit": String(60),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.floor(rate.resetAt / 1000)),
        };
        if (rate.retryAfterMs) headers["Retry-After"] = String(Math.ceil(rate.retryAfterMs / 1000));
        return withCors(req, new Response(
          JSON.stringify({ ok: false, error: "rate_limited", message: "Upload rate limit exceeded (60/hour). Try again later.", retry_after_ms: rate.retryAfterMs }),
          { status: 429, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } },   // #426 — legacy clients default to ISO-8859-1 without charset
        ));
      }

      // Two-stage size cap per 通信龙 dispatch c38de7a9:
      //   stage 1 — reject before reading body when Content-Length
      //             exceeds the cap (saves bandwidth, fails fast)
      //   stage 2 — re-verify the parsed File.size after Bun has parsed
      //             the multipart envelope (defends against a missing
      //             or lied Content-Length header)
      const contentLength = req.headers.get("Content-Length");
      if (!contentLength) {
        return withCors(req, Response.json(
          { ok: false, error: "length_required", message: "Content-Length header is required for /api/upload" },
          { status: 411 },
        ));
      }
      const declaredBytes = Number(contentLength);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
        return withCors(req, Response.json({ ok: false, error: "bad_content_length" }, { status: 400 }));
      }
      if (declaredBytes > MAX_REQUEST_CONTENT_LENGTH) {
        return withCors(req, Response.json(
          { ok: false, error: "payload_too_large", message: `Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`, limit_bytes: MAX_UPLOAD_BYTES },
          { status: 413 },
        ));
      }

      const contentType = req.headers.get("Content-Type") ?? "";
      if (!/^multipart\/form-data/i.test(contentType)) {
        return withCors(req, Response.json(
          { ok: false, error: "unsupported_media_type", message: "Use multipart/form-data with a 'file' field" },
          { status: 415 },
        ));
      }

      let form: FormData;
      try {
        form = await req.formData();
      } catch (e: any) {
        return withCors(req, Response.json(
          { ok: false, error: "multipart_parse_failed", message: e?.message?.slice(0, 200) ?? "multipart parse failed" },
          { status: 400 },
        ));
      }
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return withCors(req, Response.json(
          { ok: false, error: "missing_file", message: "Expected a 'file' field with binary content" },
          { status: 400 },
        ));
      }

      // Stage 2 — re-verify parsed size against the documented cap.
      if (file.size > MAX_UPLOAD_BYTES) {
        return withCors(req, Response.json(
          { ok: false, error: "payload_too_large", message: `Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`, limit_bytes: MAX_UPLOAD_BYTES, observed_bytes: file.size },
          { status: 413 },
        ));
      }

      const fileId = generateFileId();
      const ext = sanitizeExt(file.name);
      let storage;
      try {
        storage = buildStoragePath(fileId, ext);
      } catch (e: any) {
        // Should be unreachable — we generated the id ourselves — but
        // surface as 500 if our own primitives reject our own input.
        console.error("[/api/upload] buildStoragePath rejected:", e?.message);
        return withCors(req, Response.json({ ok: false, error: "internal_path_error" }, { status: 500 }));
      }

      try {
        mkdirSync(pathDirname(storage.absolutePath), { recursive: true });
        const buf = Buffer.from(await file.arrayBuffer());
        writeFileSync(storage.absolutePath, buf);
        // Defense-in-depth: after writing, confirm the path still sits
        // inside the uploads root (catches a symlink swap or root env
        // poisoning across processes).
        if (!isPathInsideUploadsRoot(storage.absolutePath)) {
          // Refuse to acknowledge a write that landed outside the root.
          // Don't try to clean up — better to keep evidence on disk than
          // chase a symlink for cleanup.
          console.error("[/api/upload] write escaped uploads root:", storage.absolutePath);
          return withCors(req, Response.json({ ok: false, error: "internal_path_escape" }, { status: 500 }));
        }

        // Persist the index entry so /api/files/<file_id> can do an
        // O(1) lookup without scanning every date bucket.
        const idxPath = indexEntryPath(fileId);
        if (idxPath) {
          mkdirSync(pathDirname(idxPath), { recursive: true });
          writeFileSync(idxPath, JSON.stringify({
            file_id: fileId,
            date_bucket: storage.dateBucket,
            ext: storage.ext,
            name: typeof file.name === "string" ? file.name.slice(0, 255) : "",
            mime: typeof file.type === "string" ? file.type.slice(0, 100) : "application/octet-stream",
            size: file.size,
            owner: authCtx?.username ?? null,
            owner_id: authCtx?.userId ?? null,
            uploaded_at: new Date().toISOString(),
          }, null, 2));
        }
      } catch (e: any) {
        console.error("[/api/upload] write failed:", e?.message);
        return withCors(req, Response.json({ ok: false, error: "write_failed", message: e?.message?.slice(0, 200) ?? "write failed" }, { status: 500 }));
      }

      return withCors(req, Response.json({
        ok: true,
        file_id: fileId,
        path: storage.absolutePath,
        url: `/api/files/${fileId}`,
        size: file.size,
        mime: typeof file.type === "string" ? file.type : "application/octet-stream",
      }));
    }

    // ── REST: file download (#221) ──
    // GET /api/files/:file_id with Bearer auth. Always forces
    // Content-Disposition: attachment + X-Content-Type-Options: nosniff
    // so the served file can never be executed or rendered as HTML.
    // The file_id is validated against the same strict regex used at
    // generation time before any filesystem access.
    const fileMatch = url.pathname.match(/^\/api\/files\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const authErr = requireAuth(req);
      if (authErr) return withCors(req, authErr);

      const fileId = decodeURIComponent(fileMatch[1]);
      if (!FILE_ID_REGEX.test(fileId)) {
        return withCors(req, Response.json({ ok: false, error: "bad_file_id" }, { status: 400 }));
      }

      const idxPath = indexEntryPath(fileId);
      if (!idxPath || !existsSync(idxPath)) {
        return withCors(req, Response.json({ ok: false, error: "not_found" }, { status: 404 }));
      }

      let entry: any;
      try { entry = JSON.parse(readFileSync(idxPath, "utf-8")); } catch {
        return withCors(req, Response.json({ ok: false, error: "index_corrupt" }, { status: 500 }));
      }
      if (!validateIndexEntry(entry)) {
        return withCors(req, Response.json({ ok: false, error: "index_invalid" }, { status: 500 }));
      }

      let storage;
      try {
        storage = buildStoragePath(entry.file_id, entry.ext);
      } catch {
        return withCors(req, Response.json({ ok: false, error: "index_invalid" }, { status: 500 }));
      }
      if (!isPathInsideUploadsRoot(storage.absolutePath)) {
        // Defence: should be unreachable since buildStoragePath rejected
        // malformed inputs, but a poisoned index could try to fool us.
        return withCors(req, Response.json({ ok: false, error: "path_escape" }, { status: 500 }));
      }
      if (!existsSync(storage.absolutePath)) {
        return withCors(req, Response.json({ ok: false, error: "blob_missing" }, { status: 404 }));
      }

      // Defence: verify the on-disk size matches what the index claims
      // before serving — a tampered index could otherwise mislead the
      // caller about file integrity.
      const st = statSync(storage.absolutePath);
      if (st.size !== entry.size) {
        console.error("[/api/files] size mismatch:", { fileId, indexed: entry.size, onDisk: st.size });
        return withCors(req, Response.json({ ok: false, error: "size_mismatch" }, { status: 500 }));
      }

      const safeFilename = (entry.name && /^[\x20-\x7e]+$/.test(entry.name))
        ? entry.name
        : `${fileId}${entry.ext}`;
      const blob = Bun.file(storage.absolutePath);
      const responseHeaders: Record<string, string> = {
        ...corsHeaders(req),
        "Content-Type": "application/octet-stream", // always opaque; nosniff prevents the client from re-deciding
        "Content-Length": String(entry.size),
        "Content-Disposition": `attachment; filename="${safeFilename.replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      };
      return new Response(blob, { status: 200, headers: responseHeaders });
    }

    // ── REST: send task ──
    if (url.pathname === "/api/task" && req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return withCors(req, Response.json({ error: "invalid input", details: parsed.error.format() }, { status: 400 }));
      }
      const body = parsed.data;
      let taskNetId: string | null = null;
      if (restAuth?.networkId) {
        taskNetId = restAuth.networkId;
      } else if (body.network_id) {
        if (restAuth && !isAdmin && !getUserNetworkRole(restAuth.userId, body.network_id)) {
          return withCors(req, Response.json({ ok: false, error: "access denied to requested network" }, { status: 403 }));
        }
        taskNetId = body.network_id;
      } else {
        taskNetId = restAuth ? singleNetworkId(restScope) : null;
      }
      if (restAuth && !taskNetId) {
        return withCors(req, Response.json({ ok: false, error: "network_id required for user token when multiple networks are available" }, { status: 400 }));
      }
      if (!canRestWriteNetwork(restAuth, taskNetId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }
      const canonical = resolveCanonicalAlias(taskNetId, body.alias);
      const targetAlias = canonical.alias;
      const target = resolveRestDeliveryTarget(targetAlias, taskNetId);
      if (target.state === "not_found") {
        return withCors(req, Response.json({
          ok: false,
          error: "alias_not_found",
          message: target.message,
          alias: targetAlias,
          queued: false,
          ...(canonical.renamed ? { renamed_from: body.alias, renamed_to: targetAlias } : {}),
        }, { status: 404 }));
      }
      const id = crypto.randomUUID();
      const fromSession = body.from || "api";
      const ttlSeconds = (body as any).ttl_seconds || 3600;
      const fromNodeId = resolveRestNodeIdForAlias(fromSession, taskNetId);
      const targetNodeId = target.session?.node_id ?? null;
      // #221 — fold top-level `attachments` into `meta.attachments` so
      // the REST and MCP send_task transports produce identical
      // tasks.meta_json shape downstream. Top-level wins over any
      // duplicate `meta.attachments` the client supplied. Validation
      // matches the MCP-side schema (max 20 entries, file_id regex,
      // size cap, etc.).
      const attachmentsResult = validateAttachments((body as any).attachments ?? (body as any).meta?.attachments);
      if (!attachmentsResult.ok) {
        return withCors(req, Response.json({ ok: false, error: "bad_attachments", message: attachmentsResult.error }, { status: 400 }));
      }
      const mergedMeta = attachmentsResult.attachments.length
        ? { ...((body as any).meta && typeof (body as any).meta === "object" ? (body as any).meta : {}), attachments: attachmentsResult.attachments }
        : (body as any).meta;
      const metaJson = normalizeMetaJson(mergedMeta);

      // #212 dedup guardrail. Mirrors the MCP `send_task` tool: same
      // (from_session, target_alias, task) within COMMHUB_SEND_DEDUP_WINDOW_MS
      // is rejected with a structured `duplicate_send` error so dashboard
      // dispatch buttons and scripted REST callers get the same guarantee
      // as agent-driven MCP traffic.
      const dedup = sharedSendDedup.check(fromSession, targetAlias, body.task);
      if (dedup.duplicate) {
        const payload = buildDuplicateSendPayload({
          from: fromSession,
          to: targetAlias,
          ageMs: dedup.ageMs,
          windowMs: sharedSendDedup.windowMs,
        });
        console.log(`[/api/task] ${fromSession} → ${targetAlias}: DROPPED duplicate (age=${dedup.ageMs}ms, window=${sharedSendDedup.windowMs}ms)`);
        return withCors(req, Response.json(payload, { status: 429 }));
      }

      // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.2a REST site
      // 1/2 — paired with the 6 MCP sites guarded in tools.ts at PR1.1).
      // Dashboard's "Dispatch" button hits this endpoint, so without
      // the guard a stopping/stopped/deleting node still got tasks
      // routed through REST. Returns 409 with the same structured
      // payload the MCP handlers use.
      {
        const lc = assertNodeActive(targetAlias, taskNetId ?? null);
        if (!lc.ok) {
          return withCors(req, Response.json(lc, { status: 409 }));
        }
      }
      // Mirror send_task MCP: write inbox + tasks rows in a single
      // transaction so the dispatch is visible to dashboard's Tasks page
      // and the parent_task_id lineage chain. Previously this endpoint
      // only wrote inbox, leaving GET /api/tasks empty for any task
      // dispatched via REST (anet demo, dashboard Dispatch button, etc.).
      db.transaction(() => {
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, requires_response, network_id, meta_json)
           VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, 'reply', ?7, ?8)`,
          [id, targetAlias, targetNodeId, body.priority, body.task, fromSession, taskNetId, metaJson]
        );
        db.run(
          `INSERT INTO tasks (task_id, from_node_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, parent_task_id, meta_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7, 'reply', datetime('now'), datetime('now'), datetime('now', ?8), ?9, ?10, ?11)`,
          [id, fromNodeId, fromSession, targetNodeId, targetAlias, body.priority, body.task, `+${ttlSeconds} seconds`, taskNetId, body.parent_task_id ?? null, metaJson]
        );
        // Touch session row so the dashboard reflects "task in flight"
        // immediately, without waiting for the agent's report_status to
        // arrive. Updating both `task` and `updated_at` is enough — we
        // leave `status` to the agent (idle → working → idle).
        const touchParams: any[] = [body.task.slice(0, 200), targetAlias];
        let touchSql = "UPDATE sessions SET task = ?1, updated_at = datetime('now') WHERE alias = ?2";
        if (taskNetId) { touchSql += " AND network_id = ?3"; touchParams.push(taskNetId); }
        db.run(touchSql, touchParams);
      });
      // SSE push: 秒达
      const pendingParams: any[] = [targetAlias];
      let pendingSql = "SELECT COUNT(*) as cnt FROM inbox WHERE session_name = ?1 AND acked = 0";
      if (taskNetId) { pendingSql += " AND network_id = ?2"; pendingParams.push(taskNetId); }
      const pending = db.get<{ cnt: number }>(pendingSql, ...pendingParams);
      if (target.state === "online") {
        pushEvent(targetAlias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority: body.priority, from: fromSession, ...(canonical.renamed ? { renamed_from: body.alias } : {}) }, taskNetId);
      }
      // #461 network observer summary — unconditional (the task row
      // exists even when the target is offline/queued), metadata only.
      pushNetworkObserverEvent(taskNetId, { type: "new_task", task_id: id, from: fromSession, to: targetAlias, status: target.state === "online" ? "delivered" : "queued", priority: body.priority });
      // #212 — stamp the dedup index only after the inbox/tasks insert
      // succeeds. Mirrors the MCP `send_task` path so a failed write
      // never shadows a legitimate retry.
      sharedSendDedup.record(fromSession, targetAlias, body.task);
      if (target.state === "offline") {
        return withCors(req, Response.json({
          ok: false,
          error: "alias_offline",
          message: target.message,
          alias: targetAlias,
          queued: true,
          task_id: id,
          message_id: id,
          session_status: target.session.status ?? "offline",
          ...(canonical.renamed ? { renamed_from: body.alias, renamed_to: targetAlias } : {}),
        }, { status: 202 }));
      }
      return withCors(req, Response.json({ ok: true, task_id: id, message_id: id, ...(canonical.renamed ? { renamed_from: body.alias, renamed_to: targetAlias } : {}) }));
    }

    // ── REST: broadcast ──
    if (url.pathname === "/api/broadcast" && req.method === "POST") {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      const parsed = BroadcastSchema.safeParse(raw);
      if (!parsed.success) {
        return withCors(req, Response.json({ error: "invalid input", details: parsed.error.format() }, { status: 400 }));
      }
      const body = parsed.data;
      if (restAuth && !restScope.networkId && !isAdmin) {
        return withCors(req, Response.json({ ok: false, error: "network_id required for user token when broadcasting" }, { status: 400 }));
      }
      if (!canRestWriteNetwork(restAuth, restScope.networkId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }
      let sql = "SELECT alias, node_id, network_id FROM sessions WHERE alias IS NOT NULL";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (body.filter_server) { sql += " AND server = ?"; params.push(body.filter_server); }
      if (body.filter_status) { sql += " AND status = ?"; params.push(body.filter_status); }
      const targets = db.all<{ alias: string; node_id: string | null; network_id: string | null }>(sql, ...params);
      const ids: string[] = [];
      for (const t of targets) {
        // RFC-027 §2.3 inbox-enqueue lifecycle guard (PR1.2a REST site
        // 2/2). Broadcast skips non-active recipients silently per its
        // best-effort semantics — mirrors the MCP broadcast handler
        // in tools.ts (PR1.1 site 6/6).
        const lc = assertNodeActive(t.alias, t.network_id ?? null);
        if (!lc.ok) continue;
        const id = crypto.randomUUID();
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, network_id)
           VALUES (?1, ?2, ?3, 'broadcast', 'normal', ?4, 'api', ?5)`,
          [id, t.alias, t.node_id ?? null, body.message, t.network_id]
        );
        ids.push(id);
      }
      for (const t of targets) {
        pushEvent(t.alias, { type: "broadcast", inbox_count: 1 }, t.network_id);
      }
      return withCors(req, Response.json({ ok: true, recipients: targets.length, message_ids: ids }));
    }

    // ── REST: tmux capture-pane ──
    const tmuxCapture = url.pathname.match(/^\/api\/tmux\/([a-zA-Z0-9_-]+)$/);
    if (tmuxCapture && req.method === "GET") {
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
      const name = tmuxCapture[1];
      const lines = Number(url.searchParams.get("lines")) || 30;
      try {
        const proc = Bun.spawn(["tmux", "capture-pane", "-t", name, "-p"], {
          stdout: "pipe", stderr: "pipe",
        });
        const text = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) {
          return withCors(req, Response.json({ ok: false, error: err.trim() || `exit ${code}` }, { status: 400 }));
        }
        const trimmed = text.split("\n").slice(-lines).join("\n");
        return withCors(req, Response.json({ ok: true, tmux_name: name, lines: lines, output: trimmed }));
      } catch (e) {
        return withCors(req, Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // ── REST: tmux send-keys ──
    const tmuxSend = url.pathname.match(/^\/api\/tmux\/([a-zA-Z0-9_-]+)\/send$/);
    if (tmuxSend && req.method === "POST") {
      const tmuxErr = requireTmuxAccess(req, server);
      if (tmuxErr) return withCors(req, tmuxErr);
      const name = tmuxSend[1];
      let body: { text?: string; enter?: boolean };
      try { body = await req.json(); } catch {
        return withCors(req, Response.json({ error: "invalid JSON" }, { status: 400 }));
      }
      if (!body.text || typeof body.text !== "string") {
        return withCors(req, Response.json({ error: "text is required" }, { status: 400 }));
      }
      const args = ["tmux", "send-keys", "-t", name, body.text];
      if (body.enter !== false) args.push("Enter");
      try {
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) {
          return withCors(req, Response.json({ ok: false, error: err.trim() || `exit ${code}` }, { status: 400 }));
        }
        return withCors(req, Response.json({ ok: true, sent: body.text }));
      } catch (e) {
        return withCors(req, Response.json({ ok: false, error: (e as Error).message }, { status: 500 }));
      }
    }

    // ── REST: recent messages (for Dashboard communication graph) ──
    if (url.pathname === "/api/messages") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 3600000).toISOString().replace("T", " ").slice(0, 19);
      const params: any[] = [since];
      let sql = "SELECT id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id FROM inbox WHERE created_at >= ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, messages: rows }));
    }

    // ── REST: stats summary ──
    if (url.pathname === "/api/stats") {
      const taskStatsParams: any[] = [];
      let taskStatsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      taskStatsSql = addNetworkScope(taskStatsSql, taskStatsParams, restScope);
      taskStatsSql += " GROUP BY status";
      const taskStats = db.all<any>(taskStatsSql, ...taskStatsParams);

      const sessionStatsParams: any[] = [];
      let sessionStatsSql = "SELECT status, COUNT(*) as count FROM sessions WHERE 1=1";
      sessionStatsSql = addNetworkScope(sessionStatsSql, sessionStatsParams, restScope);
      sessionStatsSql += " GROUP BY status";
      const sessionStats = db.all<any>(sessionStatsSql, ...sessionStatsParams);

      const totalTasksParams: any[] = [];
      let totalTasksSql = "SELECT COUNT(*) as cnt FROM tasks WHERE 1=1";
      totalTasksSql = addNetworkScope(totalTasksSql, totalTasksParams, restScope);
      const totalTasks = db.get<{ cnt: number }>(totalTasksSql, ...totalTasksParams);

      const totalNodesParams: any[] = [];
      let totalNodesSql = "SELECT COUNT(*) as cnt FROM nodes WHERE 1=1";
      totalNodesSql = addNetworkScope(totalNodesSql, totalNodesParams, restScope);
      const totalNodes = db.get<{ cnt: number }>(totalNodesSql, ...totalNodesParams);

      const recentTasksParams: any[] = [];
      let recentTasksSql = "SELECT task_id, from_name, to_name, status, created_at FROM tasks WHERE 1=1";
      recentTasksSql = addNetworkScope(recentTasksSql, recentTasksParams, restScope);
      recentTasksSql += " ORDER BY created_at DESC LIMIT 5";
      const recentTasks = db.all<any>(recentTasksSql, ...recentTasksParams);
      return withCors(req, Response.json({
        ok: true,
        network_id: restScope.networkId || null,
        tasks: { total: totalTasks?.cnt || 0, by_status: taskStats },
        sessions: { by_status: sessionStats },
        nodes: { total: totalNodes?.cnt || 0 },
        recent_tasks: recentTasks,
      }));
    }

    // ── REST: server log tail (in-memory ring buffer, last LOG_RING_CAP lines) ──
    // Admin-only because logs may include user names + task content.
    if (url.pathname === "/api/server-logs") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      if (resolved.user.role !== "admin") return withCors(req, Response.json({ ok: false, error: "admin only" }, { status: 403 }));
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, LOG_RING_CAP);
      const since = url.searchParams.get("since"); // ISO timestamp; only return logs newer
      let entries = logRing.slice(-limit);
      if (since) entries = entries.filter(e => e.ts > since);
      // Newest first
      entries = entries.slice().reverse();
      return withCors(req, Response.json({ ok: true, logs: entries, capacity: LOG_RING_CAP }));
    }

    // ── REST: audit log (V3) ──
    if (url.pathname === "/api/audit-log") {
      const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
      if (!token) return withCors(req, Response.json({ ok: false, error: "auth required" }, { status: 401 }));
      const resolved = resolveToken(token);
      if (!resolved) return withCors(req, Response.json({ ok: false, error: "invalid token" }, { status: 401 }));
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const action = url.searchParams.get("action");
      const userId = url.searchParams.get("user_id");
      let sql = "SELECT * FROM audit_log WHERE 1=1";
      const params: any[] = [];
      // Non-admin can only see own logs
      if (resolved.user.role !== "admin") { sql += ` AND user_id = ?${params.length + 1}`; params.push(resolved.user.user_id); }
      if (action) { sql += ` AND action = ?${params.length + 1}`; params.push(action); }
      if (userId && resolved.user.role === "admin") { sql += ` AND user_id = ?${params.length + 1}`; params.push(userId); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const logs = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, logs, count: logs.length }));
    }

    // ── REST: task events (V2 Sprint 2) ──
    if (url.pathname === "/api/task_events") {
      const taskId = url.searchParams.get("task_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 500);
      let sql = "SELECT * FROM task_events WHERE 1=1";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (taskId) { sql += ` AND task_id = ?${params.length + 1}`; params.push(taskId); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, events: rows, count: rows.length }));
    }

    // ── REST: delete node (Dashboard/CLI remote cleanup) ──
    const nodeDeleteMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)$/);
    if (nodeDeleteMatch && req.method === "DELETE") {
      const ref = decodeURIComponent(nodeDeleteMatch[1]);
      const params: any[] = [ref, ref, ref];
      let sql = "SELECT * FROM nodes WHERE (node_id = ?1 OR node_name = ?2 OR alias = ?3)";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY updated_at DESC LIMIT 1";
      const node = db.get<any>(sql, ...params);
      if (!node) return withCors(req, Response.json({ ok: false, error: "node not found" }, { status: 404 }));

      const nodeNetId = node.network_id ?? singleNetworkId(restScope);
      if (!canRestWriteNetwork(restAuth, nodeNetId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }

      db.transaction(() => {
        db.run("DELETE FROM nodes WHERE node_id = ?1", [node.node_id]);
        if (node.alias) {
          db.run(
            "DELETE FROM sessions WHERE alias = ?1 AND (network_id = ?2 OR (?2 IS NULL AND network_id IS NULL))",
            [node.alias, node.network_id ?? null]
          );
        }
      });

      if (node.alias) {
        pushEvent(node.alias, {
          type: "node_deleted",
          node_id: node.node_id,
          node_name: node.node_name,
          alias: node.alias,
          network_id: node.network_id ?? null,
        }, node.network_id ?? null);
      }

      return withCors(req, Response.json({
        ok: true,
        deleted: true,
        node_id: node.node_id,
        node_name: node.node_name,
        alias: node.alias,
        network_id: node.network_id ?? null,
      }));
    }

    // ── REST: single node config snapshot (RFC-024 B5) ──
    // Dashboard calls this for the snapshot path. Returns the masked
    // {model, flags, config_revision} the node last posted via
    // report_status (B6). NEVER reads per-node files. Network-scoped
    // via addNetworkScope so a netA viewer can't read a netB node.
    const nodeConfigMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/config$/);
    if (nodeConfigMatch && req.method === "GET") {
      const nodeId = decodeURIComponent(nodeConfigMatch[1] ?? "");
      const params: any[] = [nodeId];
      let sql = "SELECT node_id, alias, network_id, config_revision, config_snapshot FROM nodes WHERE node_id = ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " LIMIT 1";
      const node = db.get<any>(sql, ...params);
      if (!node) {
        return withCors(req, Response.json({ ok: false, error: "node_not_found", node_id: nodeId }, { status: 404 }));
      }
      let snapshot: any = {};
      if (node.config_snapshot) {
        try { snapshot = JSON.parse(node.config_snapshot); } catch { snapshot = {}; }
      }
      return withCors(req, Response.json({
        ok: true,
        node_id: node.node_id,
        alias: node.alias,
        network_id: node.network_id,
        config_revision: node.config_revision || 0,
        model: snapshot.model ?? null,
        flags: snapshot.flags ?? {},
        config_update_capable: snapshot.config_update_capable ?? false,
      }));
    }

    // ── #462 REST: set / clear a node's custom avatar ──
    // PUT /api/nodes/:ref/avatar  body: { "avatar_url": "https://…" | null }
    //
    // Deliberately NOT part of the RFC-024 config-apply pipeline: avatar
    // is a pure display attribute — nothing for agent-node to consume, no
    // config_revision / ack round-trip, no restart tier. Persisted on the
    // nodes row and served back via GET /api/nodes (cross-device).
    //
    // Auth: same write gate as node delete above — network-scoped lookup
    // + canRestWriteNetwork (member with role above viewer, or admin, or
    // legacy master token). Value passes validateAvatarUrl (http/https
    // only, ≤ 2048 chars, no control chars — XSS boundary, see
    // avatar-validate.ts).
    const nodeAvatarMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/avatar$/);
    if (nodeAvatarMatch && req.method === "PUT") {
      let avatarBody: any;
      try {
        avatarBody = await req.json();
      } catch {
        return withCors(req, Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }));
      }
      const validated = validateAvatarUrl(avatarBody?.avatar_url);
      if (!validated.ok) {
        return withCors(req, Response.json({ ok: false, error: "invalid_avatar_url", reason: validated.reason }, { status: 400 }));
      }
      const ref = decodeURIComponent(nodeAvatarMatch[1]);
      const params: any[] = [ref, ref, ref];
      let sql = "SELECT node_id, alias, network_id FROM nodes WHERE (node_id = ?1 OR node_name = ?2 OR alias = ?3)";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY updated_at DESC LIMIT 1";
      const node = db.get<any>(sql, ...params);
      if (!node) return withCors(req, Response.json({ ok: false, error: "node not found" }, { status: 404 }));

      const nodeNetId = node.network_id ?? singleNetworkId(restScope);
      if (!canRestWriteNetwork(restAuth, nodeNetId, isAdmin)) {
        return withCors(req, Response.json({ ok: false, error: "permission_denied" }, { status: 403 }));
      }

      db.run(
        "UPDATE nodes SET avatar_url = ?1, updated_at = datetime('now') WHERE node_id = ?2",
        [validated.value, node.node_id]
      );
      return withCors(req, Response.json({ ok: true, node_id: node.node_id, alias: node.alias, avatar_url: validated.value }));
    }

    // ── REST: nodes table (V2 Sprint 2) ──
    // Explicit column list — NOT `SELECT *`. Two reasons:
    //   1. `SELECT *` silently broadcasts any column added later to the
    //      response (RFC-024 added config_revision/config_snapshot which
    //      the dashboard's GET /api/nodes/:id/config endpoint owns;
    //      RFC-028 will add more vault-flavored columns). Tests asserting
    //      response shape break on every ALTER; integrations that key
    //      off Object.keys() can pick up internals.
    //   2. The list endpoint and the per-node config snapshot endpoint
    //      have different consumer contracts; this list should be the
    //      stable, dashboard-facing fields only.
    // Add a new column to this list explicitly when a real client needs
    // it; do NOT switch back to SELECT *.
    // ── REST: list host_supervisor daemons (RFC-026 §9.2.2 / #338 PR2) ──
    // Mirror of the `list_host_supervisors` MCP tool for non-MCP callers.
    // Same SQL + role-extract + member-脱敏 logic; SEC-1 scoped via REST
    // auth pipeline (restScope). Returns {ok, daemons:[...], count}.
    if (url.pathname === "/api/host-supervisors") {
      // #380 — utok callers with exactly one accessible network get a
      // safe fallback so the create-node wizard doesn't have to bake
      // network_id into every request (it was hard-4xxing when the
      // dashboard omitted the query param — that's what "hub 400" was).
      // `singleNetworkId` returns:
      //   - scope.networkId when it's set (ntok binding, or an
      //     explicitly-requested network the user has verified access to)
      //   - the sole member of scope.networkIds when the utok user
      //     belongs to exactly one network (safe unambiguous fallback)
      //   - null when the user belongs to 0 or 2+ networks (authz
      //     boundary — refuse to guess which one, mirrors 通信龙 spec
      //     "别 fallback 到错 network")
      // The 400 branch is retained for the ambiguous / no-access cases
      // and distinguishes them in the error message so the client can
      // recover (send network_id explicitly).
      const effectiveNetId = singleNetworkId(restScope);
      if (!effectiveNetId) {
        const memberships = restScope.networkIds?.length ?? 0;
        const error = memberships > 1
          ? "network_id_required_multi"
          : "missing_network_id";
        return withCors(req, Response.json({ ok: false, error, memberships }, { status: 400 }));
      }
      // Role for member-脱敏 (admin/owner = full host_telemetry, others = masked)
      let isPrivileged = false;
      if (restAuth?.userId) {
        const role = getUserNetworkRole(restAuth.userId, effectiveNetId);
        isPrivileged = role === "admin" || role === "owner";
      } else {
        // Network-token caller (no user) — treat as privileged within its network
        isPrivileged = true;
      }

      // EXISTS subquery handles BOTH revoked_at SET and DELETEd token
      // rows (revokeToken DELETEs the row in production — PR2 v1
      // SHOULD-FIX per 通信龙 audit). EXISTS naturally dedupes daemons
      // with rotated tokens.
      const sqlRows = db.all<Record<string, any>>(`
        SELECT
          n.node_id, n.alias, n.hostname, n.network_id,
          n.runtimes_supported, n.allowed_secret_keys,
          n.created_at, n.updated_at,
          s.last_seen_at AS session_last_seen,
          s.cpu_cores AS session_cpu_cores,
          s.mem_total_gb AS session_mem_total_gb,
          s.ip AS session_ip,
          n.config_snapshot
        FROM nodes n
        LEFT JOIN sessions s ON s.alias = n.alias AND (s.network_id = n.network_id OR s.network_id IS NULL)
        WHERE n.network_id = ?1
          AND EXISTS (
            SELECT 1 FROM api_tokens t
            WHERE t.network_id = n.network_id
              AND t.name = 'node:' || n.alias
              AND t.revoked_at IS NULL
          )
        ORDER BY n.updated_at DESC
      `, effectiveNetId);

      const nowMs = Date.now();
      const ONLINE_MS = 60_000;
      const daemons = sqlRows
        .map(r => {
          let snapRole: string | null = null;
          if (r.config_snapshot) {
            try {
              const parsed = typeof r.config_snapshot === "string" ? JSON.parse(r.config_snapshot) : r.config_snapshot;
              snapRole = typeof parsed?.role === "string" ? parsed.role : null;
            } catch { /* malformed */ }
          }
          return { row: r, role: snapRole };
        })
        .filter(({ role }) => role === "host_supervisor")
        .map(({ row: r }) => {
          let online = false;
          let lastSeenAt: string | null = null;
          if (r.session_last_seen) {
            lastSeenAt = r.session_last_seen;
            const t = Date.parse(r.session_last_seen);
            if (!isNaN(t)) online = (nowMs - t) <= ONLINE_MS;
          }
          let runtimes: string[] = [];
          let secrets: string[] = [];
          try {
            if (r.runtimes_supported) {
              const parsed = JSON.parse(r.runtimes_supported);
              runtimes = Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            }
          } catch {}
          try {
            if (r.allowed_secret_keys) {
              const parsed = JSON.parse(r.allowed_secret_keys);
              secrets = Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            }
          } catch {}
          const telemetry: Record<string, unknown> = {
            alert_level: online ? "green" : "gray",
          };
          if (isPrivileged) {
            telemetry.cpu_cores = r.session_cpu_cores ?? null;
            telemetry.mem_gb = r.session_mem_total_gb ?? null;
            telemetry.ip_internal = r.session_ip ?? null;
          }
          return {
            daemon_node_id: r.node_id,
            alias: r.alias,
            hostname: r.hostname,
            online,
            last_seen_at: lastSeenAt,
            runtimes_supported: runtimes,
            allowed_secret_keys: secrets,
            host_telemetry: telemetry,
          };
        });
      return withCors(req, Response.json({ ok: true, daemons, count: daemons.length }));
    }

    if (url.pathname === "/api/nodes") {
      const nodeId = url.searchParams.get("node_id");
      const alias = url.searchParams.get("alias");
      // `config_snapshot` SELECTed ONLY to extract the daemon `role` field
      // for dashboard discovery — full snapshot is NOT broadcast (would
      // re-introduce the #312 SELECT * fragility). Mapping step pulls
      // `role` out then drops `config_snapshot` from the response row.
      // RFC-027 PR2 dashboard prereq: lifecycle_state is needed
      // client-side to drive the ⋮ menu (active → "停止/删除";
      // stopped → "重启/删除"). Hub schema gained the column at PR1
      // (#345) but /api/nodes never SELECTed it. Following #312
      // "explicit SELECT" discipline — extend the projection here,
      // do NOT switch to SELECT *.
      // #462: avatar_url added to the projection so custom avatars are
      // cross-device (dashboard hydrates from here; localStorage was the
      // only store before). Nullable — null means "use default set".
      let sql = `SELECT node_id, node_name, alias, runtime, model,
                        config_path, channels, server, hostname,
                        network_id, created_at, updated_at,
                        config_snapshot, lifecycle_state, avatar_url
                 FROM nodes WHERE 1=1`;
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (nodeId) { sql += ` AND node_id = ?${params.length + 1}`; params.push(nodeId); }
      if (alias) { sql += ` AND alias = ?${params.length + 1}`; params.push(alias); }
      sql += " ORDER BY updated_at DESC";
      const rawRows = db.all<Record<string, any>>(sql, ...params);
      // Add a single new field `role: string | null` per row, extracted from
      // config_snapshot JSON. Daemon nodes that posted role='host_supervisor'
      // via report_status surface here; dashboard uses this for daemon
      // discovery (replacing the prior `node_daemon_` prefix heuristic).
      // RFC-026 P1 P2 §9 will supersede this REST proxy with the
      // `list_host_supervisors` MCP tool.
      const rows = rawRows.map(r => {
        let role: string | null = null;
        const snap = r.config_snapshot;
        if (snap) {
          try { role = (typeof snap === "string" ? JSON.parse(snap) : snap)?.role ?? null; }
          catch { /* malformed snapshot — leave role null */ }
        }
        const { config_snapshot, ...rest } = r;
        return { ...rest, role };
      });
      return withCors(req, Response.json({ ok: true, nodes: rows, count: rows.length }));
    }

    // ── REST: single task lookup (V2) ──
    const taskPathMatch = url.pathname.match(/^\/api\/tasks?\/([^/]+)$/);
    if (taskPathMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskPathMatch[1] ?? "");
      const params: any[] = [taskId];
      let sql = "SELECT * FROM tasks WHERE task_id = ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " LIMIT 1";
      const task = db.get(sql, ...params);
      if (!task) {
        return withCors(req, Response.json({ ok: false, error: "task_not_found", task_id: taskId }, { status: 404 }));
      }
      return withCors(req, Response.json({ ok: true, task }));
    }

    // ── REST: tasks table (V2) ──
    if (url.pathname === "/api/tasks") {
      const taskId = url.searchParams.get("task_id");
      const status = url.searchParams.get("status");
      const toName = url.searchParams.get("to_name");
      const fromName = url.searchParams.get("from_name");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      // #248 — opt-out of the stats GROUP-BY scan. The dashboard chat panel
      // never consumes `stats`; it's a global per-status table scan that
      // dominates the request time on a large DB (270 MB / many tasks).
      // Existing callers that don't pass `skip_stats=1` get the same
      // {ok, tasks, count, stats} shape — backwards-compatible.
      const skipStats = url.searchParams.get("skip_stats") === "1";

      let sql = "SELECT * FROM tasks WHERE 1=1";
      const params: any[] = [];
      sql = addNetworkScope(sql, params, restScope);
      if (taskId) { sql += ` AND task_id = ?${params.length + 1}`; params.push(taskId); }
      if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
      if (toName) { sql += ` AND to_name = ?${params.length + 1}`; params.push(toName); }
      if (fromName) { sql += ` AND from_name = ?${params.length + 1}`; params.push(fromName); }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1}`;
      params.push(limit);

      const rows = db.all(sql, ...params);
      if (skipStats) {
        return withCors(req, Response.json({ ok: true, tasks: rows, count: rows.length }));
      }
      const statsParams: any[] = [];
      let statsSql = "SELECT status, COUNT(*) as count FROM tasks WHERE 1=1";
      statsSql = addNetworkScope(statsSql, statsParams, restScope);
      statsSql += " GROUP BY status";
      const stats = db.all<any>(statsSql, ...statsParams);
      return withCors(req, Response.json({ ok: true, tasks: rows, count: rows.length, stats }));
    }

    // ── REST: recent completions ──
    if (url.pathname === "/api/completions") {
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 86400000).toISOString();
      const params: any[] = [since];
      let sql = "SELECT * FROM completions WHERE completed_at >= ?1";
      sql = addNetworkScope(sql, params, restScope);
      sql += " ORDER BY completed_at DESC LIMIT 100";
      const rows = db.all(sql, ...params);
      return withCors(req, Response.json({ ok: true, completions: rows }));
    }

    return withCors(req, new Response(
      `CommHub MCP Server v${SERVER_VERSION} (Streamable HTTP + SSE Push)

Endpoints:
  POST /mcp               - MCP Streamable HTTP (for Claude Code / Codex)
  GET  /events/:session   - SSE realtime push (Agent subscribes here)
  GET  /health            - Health check
  GET  /api/status        - All sessions (auth required)
  POST /api/task          - Send task via REST (auth required)
  GET  /api/tasks         - Tasks table (V2) (auth required)
  GET  /api/completions   - Recent completions (auth required)
  GET  /api/tmux/:name    - Capture tmux pane output (${TMUX_ENABLED ? "admin + localhost/allowlist required" : "disabled"})
  POST /api/tmux/:name/send - Send keys to tmux (${TMUX_ENABLED ? "admin + localhost/allowlist required" : "disabled"})

Security: ${SECURITY_LABEL}
`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }   // #426
    ));
  },

  // ── WebSocket handler for tmux terminal streaming ──
  websocket: {
    open(ws) {
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
      console.log(`[ws] tmux terminal opened: ${tmuxName}`);
      let lastOutput = "";

      // Poll capture-pane every 200ms and send diffs
      const interval = setInterval(async () => {
        try {
          const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxName, "-p", "-e"], {
            stdout: "pipe", stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          const code = await proc.exited;
          if (code !== 0) return;

          if (output !== lastOutput) {
            lastOutput = output;
            ws.send(JSON.stringify({ type: "output", data: output }));
          }
        } catch { /* session gone */ }
      }, 200);

      wsTmuxIntervals.set(ws, interval);

      // Send initial capture immediately
      (async () => {
        try {
          const proc = Bun.spawn(["tmux", "capture-pane", "-t", tmuxName, "-p", "-e"], {
            stdout: "pipe", stderr: "pipe",
          });
          const output = await new Response(proc.stdout).text();
          const code = await proc.exited;
          if (code === 0) {
            lastOutput = output;
            ws.send(JSON.stringify({ type: "output", data: output }));
          } else {
            const err = await new Response(proc.stderr).text();
            ws.send(JSON.stringify({ type: "error", data: err.trim() || "tmux session not found" }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", data: (e as Error).message }));
        }
      })();
    },

    async message(ws, message) {
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
      try {
        const msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));

        if (msg.type === "input" && typeof msg.data === "string") {
          // Send individual characters/sequences via send-keys
          const proc = Bun.spawn(["tmux", "send-keys", "-t", tmuxName, "-l", msg.data], {
            stdout: "pipe", stderr: "pipe",
          });
          await proc.exited;
        } else if (msg.type === "key" && typeof msg.data === "string") {
          // Send special key names (Enter, C-c, etc.)
          const proc = Bun.spawn(["tmux", "send-keys", "-t", tmuxName, msg.data], {
            stdout: "pipe", stderr: "pipe",
          });
          await proc.exited;
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          // Resize tmux pane
          Bun.spawn(["tmux", "resize-window", "-t", tmuxName, "-x", String(msg.cols), "-y", String(msg.rows)], {
            stdout: "pipe", stderr: "pipe",
          });
        }
      } catch { /* ignore malformed messages */ }
    },

    close(ws) {
      const { tmuxName } = ws.data as unknown as { tmuxName: string };
      console.log(`[ws] tmux terminal closed: ${tmuxName}`);
      const interval = wsTmuxIntervals.get(ws);
      if (interval) { clearInterval(interval); wsTmuxIntervals.delete(ws); }
    },
  },
});
} // end bootServer

// ── Explicit startup (#438 corrective / 通信龙派单) ──────────────────
//
// Importing this module NO LONGER binds a port. The two failure modes
// this design dodges, both field-verified:
//
//   1. `if (import.meta.main)` guard — the published package's process
//      entry is bin/commhub.ts which DYNAMICALLY imports this module, so
//      import.meta.main is always false there: the process comes up but
//      listens on nothing (#438 review finding; would have shipped dead).
//   2. Module-level `export const server = bootServer()` side effect —
//      fixes (1) but makes EVERY import bind a port: tooling scripts,
//      typechecks, and unrelated tests all grab the port by accident.
//
// The contract instead: bin/commhub.ts (and anything else that wants a
// running hub) calls `startHub()` explicitly. Tests that need a private
// throwaway instance keep using `bootServer({ port: 0 })`, which stays
// side-effect-free (no sweepers / signal handlers / banner).
//
// startHub is SINGLE-SHOT and observable: a second call throws with the
// first boot's coordinates rather than silently no-op'ing — "I thought I
// started it but nothing happened" is the same failure family as (1)
// (承 通信测试马 verification design requirement).

let startedHub: { server: ReturnType<typeof Bun.serve>; startedAt: string } | null = null;

/** The hub instance startHub() booted, or null before startHub() runs.
 *  Read-only introspection for diagnostics; do not boot through this. */
export function getStartedHub(): { server: ReturnType<typeof Bun.serve>; startedAt: string } | null {
  return startedHub;
}

export function startHub(opts?: { port?: number; hostname?: string }): ReturnType<typeof Bun.serve> {
  if (startedHub) {
    throw new Error(
      `startHub() already ran at ${startedHub.startedAt} (listening on ` +
      `${startedHub.server.hostname}:${startedHub.server.port}) — it is single-shot ` +
      `by design (sweepers + signal handlers must register exactly once). ` +
      `For an additional throwaway instance use bootServer({ port: 0 }).`
    );
  }
  const server = bootServer(opts);

  // Round-2/4 review ② — periodic retention sweep + incremental VACUUM.
  // Sweeps every hour by default. Operators can disable any single table
  // by setting COMMHUB_RETENTION_*_DAYS to a negative value, or shorten
  // the sweep window via COMMHUB_RETENTION_SWEEP_MINUTES.
  const sweepIntervalMinutes = Number(process.env.COMMHUB_RETENTION_SWEEP_MINUTES);
  const sweepIntervalMs = Number.isFinite(sweepIntervalMinutes) && sweepIntervalMinutes > 0
    ? sweepIntervalMinutes * 60 * 1000
    : 60 * 60 * 1000;
  const retentionSweeperTimer = startRetentionSweeper(sweepIntervalMs);

  // Round-2/4 review ③ — stale session sweeper (coexists with the
  // retention sweeper above; different concerns + different cadences).
  // Replaces the per-request UPDATE in GET /api/status (+ /api/servers,
  // /api/server-detail/*, MCP get_all_status). Each of those endpoints
  // used to run UPDATE on the sessions table just to maintain the
  // derived `offline` status; with the dashboard polling fast that was
  // 99% no-op write-amp under hot read paths. Now done globally once
  // every COMMHUB_STALE_SWEEP_SECONDS (default 60s).
  const staleSweeperTimer = startStaleSessionSweeper();

  // #476 — the two legacy module-level intervals, now owned by startHub
  // like every other periodic job: rate-limit map cleanup (memory only)
  // and task expiration patrol (writes DB — must never run on import).
  // Periods env-overridable so tests can observe a real firing without
  // waiting minutes (mirrors COMMHUB_RETENTION_SWEEP_MINUTES above).
  const rateLimitSweepMs = Number(process.env.COMMHUB_RATELIMIT_SWEEP_MS) > 0
    ? Number(process.env.COMMHUB_RATELIMIT_SWEEP_MS) : 300000;
  const taskPatrolMs = Number(process.env.COMMHUB_TASK_PATROL_MS) > 0
    ? Number(process.env.COMMHUB_TASK_PATROL_MS) : 5 * 60 * 1000;
  const rateLimitSweepTimer = setInterval(sweepStaleRateLimits, rateLimitSweepMs);
  const taskPatrolTimer = setInterval(patrolExpiredTasks, taskPatrolMs);

  // The Bun.serve socket is what keeps the process alive; the periodic
  // jobs must not — otherwise a test (or a future caller) that stops the
  // server would still hang on live intervals it cannot reach.
  (retentionSweeperTimer as any)?.unref?.();
  (staleSweeperTimer as any)?.unref?.();
  (rateLimitSweepTimer as any)?.unref?.();
  (taskPatrolTimer as any)?.unref?.();

  // ── Graceful shutdown ───────────────────────────────
  function shutdown() {
    console.log("[commhub] shutting down...");
    clearInterval(retentionSweeperTimer);
    clearInterval(staleSweeperTimer);
    clearInterval(rateLimitSweepTimer);
    clearInterval(taskPatrolTimer);
    db.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Banner reports the ACTUAL bound address (matters for port 0).
  const bHost = server.hostname ?? HOST;
  const bPort = server.port ?? PORT;
  console.log(`
╔══════════════════════════════════════════════════╗
║   CommHub MCP Server v${SERVER_VERSION}                     ║
║   Transport: Streamable HTTP (Bun native)         ║
║   Security: ${SECURITY_LABEL}${" ".repeat(Math.max(0, 33 - SECURITY_LABEL.length))}║
║   Tmux: ${TMUX_ENABLED ? "ENABLED (admin + localhost/allowlist)" : "DISABLED (set COMMHUB_ENABLE_TMUX=1)"}${" ".repeat(Math.max(0, TMUX_ENABLED ? 0 : 2))}║
║                                                   ║
║   MCP:    http://${bHost}:${bPort}/mcp                 ║
║   REST:   http://${bHost}:${bPort}/api                 ║
║   Health: http://${bHost}:${bPort}/health               ║
╚══════════════════════════════════════════════════╝
`);

  // RFC-028 P1 boot banner — vault key configuration status.
  // F2 invariant: hub MUST boot regardless of vault state. Banner-only
  // (informational), fire-and-forget so startHub stays synchronous;
  // errors are raised lazily at vault op time. needsKeyToOp=true means
  // the operator should set ANET_HUB_SECRET_VAULT_KEY before
  // vault/provider features will work.
  import("./vault.js").then(({ vaultStatusForBoot }) => {
    const s = vaultStatusForBoot();
    if (s.needsKeyToOp) {
      console.warn("[rfc-028 vault] ⚠️  network_secrets/providers have data BUT ANET_HUB_SECRET_VAULT_KEY is unset — vault ops will throw vault_master_key_missing until you set the env. Generate one: `openssl rand -hex 32` (must match the key used at write time).");
    } else if (s.configured) {
      console.log(`[rfc-028 vault] master key configured (tables_have_data=${s.tablesHaveData})`);
    } else {
      console.log("[rfc-028 vault] master key not set + no vault rows — vault gating is lazy; boot OK. Set ANET_HUB_SECRET_VAULT_KEY when enabling provider/secret features.");
    }
  }).catch((e: any) => {
    console.warn(`[rfc-028 vault] boot banner skipped (${e?.message || e})`);
  });

  startedHub = { server, startedAt: new Date().toISOString() };
  return server;
}
