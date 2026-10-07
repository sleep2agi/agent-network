/**
 * V3 Auth module — user registration, login, token management
 */
import { db, generateId, hashPassword, verifyPassword, hashToken, generateToken, generateUserToken, generateNetworkToken, uuidv4 } from "./db.js"; import { deleteDepartmentsForNetwork, groupTx, removeMemberFromChatGroups } from "./departments.js"; // #419: also ensures network_members.department_id exists (same line on purpose: docs pin auth.ts line numbers)
import { WEAK_PASSWORDS } from "./password-dict.js";
import { checkNodeTokenClaim, legacyNodeHolder } from "./node-token-ownership.js";
import { NETWORK_REST_COLUMNS, NETWORK_REST_SELECT, sqlColumns } from "./rest-projections.js";
import { deleteAgentGrants, isAgentRestricted } from "./agent-access.js"; import { deleteTaskGrantsForMember, NEW_MEMBER_TASK_ACCESS, type TaskAccessMode } from "./task-access.js"; // 一行两个 import:文档钉着 auth.ts 的行号

// Round-6 A1 hardening — dummy hash for username-enumeration timing
// close. We compute ONE scrypt hash of a throwaway password and reuse
// it on every `!user` branch in login. The verify call against this
// dummy always fails the timingSafeEqual (the candidate password is
// unrelated), but the wall-clock cost of the scrypt() invocation is
// identical to the user-exists path — closing the ~50ms username-
// exists oracle that opened up when we moved off SHA-256 to scrypt.
//
// **Lazy** (memoized) rather than module-load constant: COMMHUB_SCRYPT_N
// may be set after this module loads (tests do this), and the dummy
// MUST match the current N so its scrypt cost matches the cost of
// verifying a real stored hash. Computing on first use captures the
// env-current N. After that it's a single fixed string for the
// process lifetime — one scrypt per process, not per request.
let _enumerationDummyHash: string | null = null;
function getEnumerationDummyHash(): string {
  if (_enumerationDummyHash === null) {
    _enumerationDummyHash = hashPassword(
      "agent-network::enumeration-oracle-close::do-not-match"
    );
  }
  return _enumerationDummyHash;
}

export interface AuthUser {
  user_id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: AuthUser;
  token?: string;           // user token (utok_)
  token_id?: string;        // api_tokens.token_id of `token` — lets a client tell which row in GET /api/auth/sessions is itself
  network_token?: string;   // network token (ntok_) for default network
  network_id?: string;
  // #261 P0-2 (2026-06-28): true when the logged-in user still has the
  // bootstrap-default password. The CLI client uses this to print a
  // prominent "must change password" warning after login succeeds. NOT
  // a login-blocker — we don't lock out anyone whose deployment ran on
  // the old `admin/anethub` default (back-compat per 通信龙 spec). The
  // field is intentionally absent (rather than `false`) on the normal
  // case so old clients don't even see it.
  must_change_password?: boolean;
}

function validatePasswordStrength(password: string, label = "password"): string | null {
  if (!password || password.length < 8) return `${label} must be at least 8 characters`;
  if (WEAK_PASSWORDS.has(password.toLowerCase())) return `${label} is too common`;
  return null;
}

export function register(username: string, password: string, email?: string, displayName?: string, opts: { issueTokens?: boolean; client?: SessionClientInfo } = {}): AuthResult {
  if (!username || username.length < 2) return { ok: false, error: "username must be at least 2 characters" };
  if (username.length > 50) return { ok: false, error: "username too long (max 50)" };
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(username)) return { ok: false, error: "username contains invalid characters" };

  const existing = db.get<any>("SELECT user_id FROM users WHERE username = ?1", username);
  if (existing) return { ok: false, error: "username already taken" };

  // First user → auto admin. Bootstrap admin may use a weak/memorable default
  // password (e.g. "anethub") for quick start; they should rotate via
  // `anet passwd` afterwards. Subsequent users must meet full strength.
  const userCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM users");
  const isFirstUser = !userCount || userCount.cnt === 0;
  if (isFirstUser) {
    if (!password || password.length < 4) return { ok: false, error: "password must be at least 4 characters" };
  } else {
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return { ok: false, error: passwordError };
  }

  const userId = generateId("u");
  const pwHash = hashPassword(password);

  db.run(
    "INSERT INTO users (user_id, username, password_hash, email, display_name, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [userId, username, pwHash, email || null, displayName || username, isFirstUser ? "admin" : "user"]
  );

  // Auto-create the user's own network + add as owner member.
  //
  // Name it after the user rather than the literal "default". Every
  // registration used to mint a network called "default", so a hub with N
  // users showed N identical "default" rows in the Dashboard sidebar with
  // no way to tell them apart (23 of them on the live hub, 22 empty).
  // Three CLI call sites (bin/cli.ts debate / demo-social / pr-review) resolve
  // a network as:
  //     me.user.default_network_id
  //       || networks.find(n => n.network_name === "default")
  //       || networks[0]
  // Checked against the live hub: GET /api/auth/me returns
  // {user_id, username, display_name, email, role} — there is no
  // default_network_id field, and nothing in server/ ever writes one. So the
  // first term is always undefined and the name lookup is the operative path,
  // not a fallback.
  //
  // After this change that lookup misses for new users and they land on
  // networks[0]. That still resolves to this network because listNetworks()
  // is `ORDER BY created_at` ascending (auth.ts:296) and this row is the
  // user's oldest. Reordering that query would silently point those three
  // commands at the wrong network.
  const networkId = generateId("net");
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, description) VALUES (?1, ?2, ?3, ?4)",
    [networkId, username, userId, `Auto-created network for ${username}`]
  );
  db.run(
    "INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')",
    [networkId, userId]
  );

  // 管理员代建账号(POST /api/admin/users)时不给管理员发这个用户的令牌:
  // 令牌只该由用户本人登录时拿到。
  if (opts.issueTokens === false) {
    return {
      ok: true,
      user: { user_id: userId, username, display_name: displayName || username, email: email || null, role: isFirstUser ? "admin" : "user" },
      network_id: networkId,
    };
  }

  // User token (utok_) — not bound to network, for CLI/Dashboard login
  const userToken = generateUserToken();
  const userTokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, client_label, user_agent, kind, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
    [userTokenId, hashToken(userToken), userId, null, "user-login", "user", cleanClientField(opts.client?.label, 64), cleanClientField(opts.client?.userAgent, 256), userTokenKindFor(opts.client)]
  );

  // Network token (ntok_) — bound to default network, for agent-node
  const networkToken = generateNetworkToken();
  const networkTokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
    [networkTokenId, hashToken(networkToken), userId, networkId, "default-network", "network"]
  );

  return {
    ok: true,
    user: { user_id: userId, username, display_name: displayName || username, email: email || null, role: isFirstUser ? "admin" : "user" },
    token: userToken,
    token_id: userTokenId,
    network_token: networkToken,
    network_id: networkId,
  };
}

export function login(username: string, password: string, client: SessionClientInfo = {}): AuthResult {
  const user = db.get<any>(
    "SELECT user_id, username, password_hash, display_name, email, role, must_change_password FROM users WHERE username = ?1",
    username);

  if (!user) {
    // Round-6 A1 hardening (timing-oracle close): pre-A1 the user-
    // exists vs user-doesn't-exist branches both ran a µs-scale
    // SHA-256, so wall-clock difference was lost in noise. Post-A1
    // the user-exists path runs ~50ms scrypt while user-doesn't
    // returns sub-ms — that ~50ms gap is web-measurable and turns
    // login into a username-enumeration oracle (rate limiter only
    // partially mitigates). Equalize by running scrypt against a
    // module-constant dummy hash on the not-found path. Dummy is
    // pre-generated at module load (not per call) so we don't burn
    // a fresh scryptSync on every miss.
    verifyPassword(password, getEnumerationDummyHash());
    return { ok: false, error: "invalid username or password" };
  }
  // Round-6 A1: verifyPassword accepts both new scrypt format and
  // legacy bare-sha256. On successful legacy verify, lazy-upgrade the
  // stored hash in place (zero downtime, no forced password change).
  const verify = verifyPassword(password, user.password_hash);
  if (!verify.ok) return { ok: false, error: "invalid username or password" };
  if (verify.needsRehash) {
    try {
      const upgraded = hashPassword(password);
      db.run(
        "UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE user_id = ?2",
        [upgraded, user.user_id]
      );
    } catch (e: any) {
      // Don't fail the login if the rehash write hits a transient
      // error — the user authenticated, we'll try again next login.
      console.log(`[commhub auth] lazy-rehash failed for user ${user.user_id}: ${e?.message ?? e}`);
    }
  }

  // #649: a successful login whose plaintext fails the same strength rule as
  // register/changePassword (too short, or in WEAK_PASSWORDS) flags the account.
  // Catches accounts created before #261 added must_change_password (they sit at
  // 0 with the bootstrap default). changePassword clears it. Never log the password.
  let mustChangePassword = user.must_change_password === 1;
  if (!mustChangePassword && validatePasswordStrength(password) !== null) {
    mustChangePassword = true;
    try {
      db.run("UPDATE users SET must_change_password = 1 WHERE user_id = ?1", [user.user_id]);
    } catch (e: any) {
      console.log(`[commhub auth] weak-password flag write failed for user ${user.user_id}: ${e?.message ?? e}`);
    }
  }

  // Issue a NEW user token — do NOT rotate/invalidate existing ones. Each
  // login (cli, dashboard, second machine) gets its own row so they don't
  // kick each other out of session. Tokens can be revoked via /api/auth/tokens.
  const userToken = generateUserToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, client_label, user_agent, kind, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
    [tokenId, hashToken(userToken), user.user_id, null, "user-login", "user", cleanClientField(client.label, 64), cleanClientField(client.userAgent, 256), userTokenKindFor(client)]
  );

  // Find default network
  const defaultNet = db.get<any>(
    "SELECT network_id FROM network_members WHERE user_id = ?1 ORDER BY role = 'owner' DESC LIMIT 1",
    user.user_id);
  const networkId = defaultNet?.network_id || null;

  // Backward compat: also try old atok_ tokens
  const token = userToken;

  return {
    ok: true,
    user: { user_id: user.user_id, username: user.username, display_name: user.display_name, email: user.email, role: user.role },
    token,
    token_id: tokenId,
    network_id: networkId,
    // #261 P0-2 — only include field when truthy (back-compat; old clients
    // don't see this field at all unless their account is flagged).
    ...(mustChangePassword ? { must_change_password: true } : {}),
  };
}

/**
 * Create a network-scoped token (ntok_) for a specific node.
 *
 * RFC-036: callers that provide nodeId atomically establish the immutable
 * node-owner binding before the plaintext token is returned. The 3-argument
 * name-only form remains available: new identities bind on first registration,
 * and a verified same-holder refresh binds to the existing unique node. This
 * does not fill NULL row owners or grant external-schedule ownership.
 */
export function createNetworkTokenForNode(userId: string, networkId: string, nodeName: string, nodeId?: string): { ok: boolean; token?: string; token_id?: string; node_id?: string; error?: string } {
  // Verify user is a member of this network with write access
  const role = getUserNetworkRole(userId, networkId);
  if (!role || role === "viewer") return { ok: false, error: "no write access to this network" };
  if (isAgentRestricted(userId, networkId)) return { ok: false, error: "restricted members cannot create network tokens" };
  if (!nodeName || nodeName.length > 200) return { ok: false, error: "invalid_node_name" };
  if (nodeId !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(nodeId))) {
    return { ok: false, error: "invalid_node_id" };
  }
  const token = generateNetworkToken();
  const tokenId = generateId("tok");
  try {
    db.transaction(() => {
      nodeId = checkNodeTokenClaim(userId, networkId, nodeName, nodeId);
      if (nodeId) {
        const existing = db.get<{ network_id: string | null; owner_user_id: string | null; alias: string | null }>(
          "SELECT network_id, owner_user_id, alias FROM nodes WHERE node_id = ?1",
          nodeId,
        );
        if (existing?.network_id && existing.network_id !== networkId) throw new Error("cross_network_node");
        if (existing?.alias && existing.alias !== nodeName) throw new Error("node_owner_mismatch");
        // Existing pre-RFC-036 rows have no trustworthy owner anchor. A token
        // refresh must not turn knowledge of a legacy node_id into ownership.
        // A same-holder refresh binds the token, without filling the row owner.
        if (existing && !existing.owner_user_id && !legacyNodeHolder(userId, networkId, nodeName, nodeId)) throw new Error("node_owner_unclaimed");
        if (existing?.owner_user_id && existing.owner_user_id !== userId) throw new Error("node_owner_mismatch");
        db.run(
          `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
           VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT(node_id) DO UPDATE SET
             node_name = COALESCE(nodes.node_name, ?2),
             alias = COALESCE(nodes.alias, ?2),
             network_id = COALESCE(nodes.network_id, ?3),
             owner_user_id = nodes.owner_user_id,
             updated_at = datetime('now')`,
          [nodeId, nodeName, networkId, userId],
        );
        if (!existing) {
          db.run(
            `INSERT INTO audit_log (user_id, action, target_type, target_id, detail, network_id)
             VALUES (?1, 'external_schedule.owner_claimed', 'node', ?2, ?3, ?4)`,
            [userId, nodeId, JSON.stringify({ node_id: nodeId, network_id: networkId }), networkId],
          );
        }
      }
      db.run(
        "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6, 2)",
        [tokenId, hashToken(token), userId, networkId, `node:${nodeName}`, nodeId ?? null],
      );
    });
  } catch (error: any) {
    const code = String(error?.message || "node_token_create_failed");
    if (code === "cross_network_node" || code === "node_owner_unclaimed" || code === "node_owner_mismatch") return { ok: false, error: code };
    throw error;
  }
  return { ok: true, token, token_id: tokenId, ...(nodeId ? { node_id: nodeId } : {}) };
}

// ── 登录会话(login session)令牌 ──
// 「会话令牌」= scope='user' 且不绑网络的 utok_:登录 / 注册签发的 user-login、改密码后换发的
// password-change、管理员重置签发的 admin-reset。它们代表「某台设备上的一次登录」,
// 由 GET /api/auth/sessions 列出、可被「退出其他设备」撤销,并且**闲置 N 天自动过期**(滑动窗口,
// 以 last_used_at 计,从没用过的以 created_at 计)。
// 不受影响:POST /api/auth/tokens 显式创建的 API 令牌(scope='full')、节点 / 网络令牌(network_id 非空)。
// 它们是给脚本和节点长期用的凭据,由各自的管理入口撤销,不该因为一段时间没被用就失效。
const SESSION_TOKEN_SQL = "scope = 'user' AND network_id IS NULL";
// last_used_at 最多每小时写一次:每个请求都会解析令牌,原来每次都 UPDATE。
// 以小时为粒度对一个以天计的闲置窗口没有影响。
const LAST_USED_WRITE_INTERVAL_SECONDS = 3600;

export type SessionClientInfo = { label?: unknown; userAgent?: unknown; kind?: unknown };

// #711 不绑网络的用户令牌的种类(api_tokens.kind):
//   'login' — 浏览器 / app 的登录会话;
//   'cli'   — anet 命令行登录、POST /api/auth/tokens 建的具名脚本令牌。
// 种类由客户端自报(client_kind / client_label),**只用于展示和「显式保留」那条路**:
// 改密码默认仍撤销全部不绑网络的令牌(当前这条除外),调用方显式 keep_cli_tokens=true 才保留 'cli'。
// 所以一个自称 cli 的令牌永远不能靠自报在默认改密码里活下来。
// 节点 / 网络令牌(network_id 非空)不分类,改密码永远不碰。
export type UserTokenKind = "login" | "cli";

/** 登录 / 注册请求签发的令牌算哪一类:客户端显式报 kind='cli',或 client_label 是 anet 自报的「anet <版本> · …」。 */
/** anet 自报的 client_label:去掉首尾空白后,区分大小写地以「anet 」开头(启动回填用同一条规则,见 db.ts)。 */
export function isAnetClientLabel(label: string): boolean {
  return label.trim().startsWith("anet ");
}

export function userTokenKindFor(client: SessionClientInfo = {}): UserTokenKind {
  if (client.kind === "cli") return "cli";
  if (typeof client.label === "string" && isAnetClientLabel(client.label)) return "cli";
  return "login";
}

function cleanClientField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return cleaned || null;
}

/** 会话令牌闲置多少天后过期;COMMHUB_SESSION_IDLE_DAYS,默认 30,0 = 关闭闲置过期。每次读,测试可以改。 */
export function sessionIdleDays(): number {
  const raw = process.env.COMMHUB_SESSION_IDLE_DAYS;
  if (raw === undefined || raw.trim() === "") return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

// datetime('now', ?N) 的偏移参数;PgAdapter 把它译成 NOW() + $N::INTERVAL。
function idleCutoffOffset(): string | null {
  const days = sessionIdleDays();
  return days > 0 ? `-${Math.round(days * 86400)} seconds` : null;
}

// 已按闲置过期的会话令牌:只有 resolveToken 拒绝之后才查,用来把 401 说清楚是「过期」而不是「无效」。
export function isExpiredSessionToken(token: string): boolean {
  const cutoff = idleCutoffOffset();
  if (!token || !cutoff) return false;
  const row = db.get<any>(
    `SELECT token_id FROM api_tokens
     WHERE token_hash = ?1 AND ${SESSION_TOKEN_SQL} AND revoked_at IS NULL
       AND COALESCE(last_used_at, created_at) < datetime('now', ?2)`,
    hashToken(token), cutoff);
  return !!row;
}

export type TokenRejection = "node_owner_restricted" | "not_network_member";

/** 查令牌行并判它能不能用:没有这一行 → null;有但被拒 → { rejected };能用 → { row }。 */
function lookupToken(token: string): { row: any; rejected?: undefined } | { row?: undefined; rejected: TokenRejection } | null {
  const tHash = hashToken(token);
  const cutoff = idleCutoffOffset();
  const row = db.get<any>(
    `SELECT t.token_id, t.user_id, t.network_id, t.scope, t.name AS token_name,
            u.username, u.display_name, u.email, u.role,
            CASE WHEN t.network_id IS NULL THEN 1
                 WHEN EXISTS (SELECT 1 FROM network_members nm WHERE nm.network_id = t.network_id AND nm.user_id = t.user_id) THEN 1
                 ELSE 0 END AS is_member
     FROM api_tokens t JOIN users u ON t.user_id = u.user_id
     WHERE t.token_hash = ?1
       AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
       AND t.revoked_at IS NULL${cutoff ? `
       AND NOT (t.scope = 'user' AND t.network_id IS NULL AND COALESCE(t.last_used_at, t.created_at) < datetime('now', ?2))` : ""}`,
    ...(cutoff ? [tHash, cutoff] : [tHash]));

  if (!row) return null;

  // #488 —— 网络令牌只在它的用户还是这个网络的成员时有效。被移出网络的人留下的令牌(移出前签发的、
  // 或移出时还没自动吊销的老数据)以前照样解析:MCP 每个工具都拒,REST 读却能拿到整个网络的名册。
  if (row.network_id && !Number(row.is_member)) return { rejected: "not_network_member" };

  // 多用户 Agent 权限:网络令牌(ntok_ / 邀请码令牌)的权限是「这个网络里的一切」,
  // 受限成员在受限网络里不能持有它 —— 否则拿它就绕过了授权过滤。这里是唯一的解析入口,
  // 在这里拒绝,所有 REST / MCP / SSE 路径一起生效(含升级前就签发、后来才被设为受限的令牌)。
  if (row.network_id && isAgentRestricted(row.user_id, row.network_id)) return { rejected: "node_owner_restricted" };
  return { row };
}

/**
 * 令牌存在、但因为主人的网络成员身份被拒时,说清楚为什么(给 401 带上 reason / hint)。
 * 只在调用者真的持有这枚令牌时才有输出 —— 不认识的令牌一律 null,不泄露任何东西。
 */
export function tokenRejection(token: string | null | undefined): { reason: TokenRejection; hint: string } | null {
  if (!token) return null;
  const r = lookupToken(token);
  if (!r?.rejected) return null;
  return r.rejected === "not_network_member"
    ? { reason: r.rejected, hint: "this token's owner is no longer a member of its network; ask a network admin to re-invite them, then create a new token" }
    : { reason: r.rejected, hint: "this token's owner only has access to granted Agents in this network, and network tokens need full Agent access; ask a network admin to set the owner's Agent access to all" };
}

export function resolveToken(token: string): { user: AuthUser; networkId: string | null; tokenName: string | null; tokenId: string | null } | null {
  const found = lookupToken(token);
  if (!found?.row) return null;
  const row = found.row;

  // Update last_used(节流:见 LAST_USED_WRITE_INTERVAL_SECONDS)
  db.run(
    "UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_id = ?1 AND (last_used_at IS NULL OR last_used_at < datetime('now', ?2))",
    [row.token_id, `-${LAST_USED_WRITE_INTERVAL_SECONDS} seconds`]
  );

  return {
    user: { user_id: row.user_id, username: row.username, display_name: row.display_name, email: row.email, role: row.role },
    networkId: row.network_id,
    tokenId: row.token_id || null,
    // tokenName carries the binding identity. For node-scoped ntok_, it's
    // 'node:<alias>'; we strip the prefix and use it as the default
    // from_session for any MCP send_task / send_message / etc, so peer
    // agents see who actually called them (not 'hub').
    tokenName: row.token_name || null,
  };
}

export function getUserNetworks(userId: string) {
  return db.all<any>(
    `SELECT ${NETWORK_REST_SELECT} FROM networks WHERE owner_id = ?1 ORDER BY created_at`,
    userId);
}

// Quota limits by plan
const QUOTAS: Record<string, { max_networks_owned: number; max_networks_joined: number }> = {
  free:  { max_networks_owned: 2, max_networks_joined: 3 },
  pro:   { max_networks_owned: 10, max_networks_joined: 20 },
  admin: { max_networks_owned: Infinity, max_networks_joined: Infinity },
};

export function createNetwork(userId: string, name: string, description?: string) {
  // Quota check
  const user = db.get<any>("SELECT plan, role FROM users WHERE user_id = ?1", userId);
  const plan = user?.role === "admin" ? "admin" : (user?.plan || "free");
  const quota = QUOTAS[plan] || QUOTAS.free;
  const ownedCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM networks WHERE owner_id = ?1", userId);
  if ((ownedCount?.cnt || 0) >= quota.max_networks_owned) {
    return { ok: false, error: `quota exceeded: max ${quota.max_networks_owned} networks for ${plan} plan` };
  }

  const existing = db.get<any>(
    "SELECT network_id FROM networks WHERE owner_id = ?1 AND network_name = ?2",
    userId, name);
  if (existing) return { ok: false, error: "network name already exists" };

  const networkId = generateId("net");
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, description) VALUES (?1, ?2, ?3, ?4)",
    [networkId, name, userId, description || null]
  );
  db.run(
    "INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')",
    [networkId, userId]
  );
  return { ok: true, network_id: networkId, network_name: name };
}

export function listTokens(userId: string) {
  return db.all<any>(
    "SELECT token_id, name, scope, network_id, last_used_at, created_at FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC",
    userId);
}

export function renameNetwork(userId: string, networkId: string, newName: string): { ok: boolean; error?: string } {
  const net = db.get<any>("SELECT owner_id FROM networks WHERE network_id = ?1", networkId);
  if (!net) return { ok: false, error: "network not found" };
  if (net.owner_id !== userId) return { ok: false, error: "not your network" };
  const dup = db.get<any>("SELECT network_id FROM networks WHERE owner_id = ?1 AND network_name = ?2", userId, newName);
  if (dup) return { ok: false, error: "name already taken" };
  db.run("UPDATE networks SET network_name = ?1, updated_at = datetime('now') WHERE network_id = ?2", [newName, networkId]);
  return { ok: true };
}

export function deleteNetwork(userId: string, networkId: string): { ok: boolean; error?: string } {
  const net = db.get<any>("SELECT owner_id FROM networks WHERE network_id = ?1", networkId);
  if (!net) return { ok: false, error: "network not found" };
  if (net.owner_id !== userId) return { ok: false, error: "not your network" };
  // Check if any sessions/tasks still reference this network
  const sessions = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions WHERE network_id = ?1", networkId);
  if (sessions && sessions.cnt > 0) return { ok: false, error: `network has ${sessions.cnt} active session(s) — stop them first` };
  db.transaction(() => {
    db.run("DELETE FROM networks WHERE network_id = ?1 AND owner_id = ?2", [networkId, userId]);
    // PR #519 codex catch: leaving membership rows behind made deleted
    // networks count toward getUserNetworkIds — a stale row could flip a
    // single-network user to "ambiguous" or auto-resolve writes INTO the
    // deleted network. Remove memberships with the network.
    db.run("DELETE FROM network_members WHERE network_id = ?1", [networkId]);
    deleteNetworkAgentGroups(networkId); deleteDepartmentsForNetwork(networkId); // #2144, #419 (one line: docs pin auth.ts line numbers)
  });
  return { ok: true };
}

export function createToken(userId: string, name: string, networkId?: string): { ok: boolean; token?: string; token_id?: string; error?: string } {
  // Security: verify user is a member of the target network
  if (networkId) {
    const role = getUserNetworkRole(userId, networkId);
    if (!role) return { ok: false, error: "not a member of this network" };
    if (role === "viewer") return { ok: false, error: "viewer cannot create full-access network tokens" };
    if (isAgentRestricted(userId, networkId)) return { ok: false, error: "restricted members cannot create network tokens" };
  }
  const token = generateToken();
  const tokenId = generateId("tok");
  // #711 不绑网络的具名令牌是给脚本 / 命令行长期用的:kind='cli'(改密码时可显式 keep_cli_tokens 保留)。
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, kind, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
    [tokenId, hashToken(token), userId, networkId || null, name, "full", networkId ? null : "cli"]
  );
  return { ok: true, token, token_id: tokenId };
}

export function revokeToken(userId: string, tokenId: string): { ok: boolean; error?: string } {
  const result = db.run("DELETE FROM api_tokens WHERE token_id = ?1 AND user_id = ?2", [tokenId, userId]);
  return result.changes > 0 ? { ok: true } : { ok: false, error: "token not found" };
}

export function issueUserToken(
  userId: string,
  name = "user-login",
  opts: { kind?: UserTokenKind; clientLabel?: string | null; userAgent?: string | null } = {},
): { token: string; token_id: string } {
  const token = generateUserToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, client_label, user_agent, kind, node_identity_epoch) VALUES (?1, ?2, ?3, NULL, ?4, 'user', ?5, ?6, ?7, 1)",
    [tokenId, hashToken(token), userId, name, opts.clientLabel ?? null, opts.userAgent ?? null, opts.kind === "cli" ? "cli" : "login"]
  );
  return { token, token_id: tokenId };
}

/** 一条令牌的种类和设备标识(改密码换发新令牌时沿用,命令行的令牌换完还是命令行的)。 */
export function getUserTokenMeta(userId: string, tokenId: string): { kind: UserTokenKind; client_label: string | null; user_agent: string | null } | null {
  const row = db.get<any>("SELECT kind, client_label, user_agent FROM api_tokens WHERE token_id = ?1 AND user_id = ?2 AND network_id IS NULL", tokenId, userId);
  if (!row) return null;
  return { kind: row.kind === "cli" ? "cli" : "login", client_label: row.client_label ?? null, user_agent: row.user_agent ?? null };
}

// #711 改密码撤销哪些令牌。kind 为 NULL 的(启动回填之后由旧版 Hub 签出的)按 'login' 算。
const CLI_KIND_SQL = "kind = 'cli'";
const NOT_CLI_KIND_SQL = "COALESCE(kind, 'login') <> 'cli'";

/** 改密码后保留下来的命令行 / 脚本令牌(给 UI 列出来、让用户逐条撤销)。**永远不含令牌值。** */
export type KeptCliToken = { token_id: string; name: string; client_label: string | null; created_at: string; last_used_at: string | null };

/**
 * 改密码后的令牌撤销。默认(keepCli=false)= 改密码前的行为:撤销全部不绑网络的令牌;
 * keepCli=true 时保留 kind='cli' 的,并把它们列出来。当前这条(exceptTokenId)和节点 / 网络令牌永远不动。
 */
export function revokeTokensAfterPasswordChange(userId: string, exceptTokenId: string | null | undefined, keepCli: boolean): { login: number; cli: number; kept: KeptCliToken[] } {
  const except = exceptTokenId ? " AND token_id != ?2" : "";
  const params = exceptTokenId ? [userId, exceptTokenId] : [userId];
  const login = db.run(`DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL AND ${NOT_CLI_KIND_SQL}${except}`, params).changes;
  if (!keepCli) {
    const cli = db.run(`DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL${except}`, params).changes;
    return { login, cli, kept: [] };
  }
  const kept = db.all<any>(
    `SELECT token_id, name, client_label, created_at, last_used_at FROM api_tokens
     WHERE user_id = ?1 AND network_id IS NULL AND ${CLI_KIND_SQL}${except}
     ORDER BY created_at DESC`,
    ...params,
  ).map((r) => ({ token_id: r.token_id, name: r.name, client_label: r.client_label ?? null, created_at: r.created_at, last_used_at: r.last_used_at ?? null }));
  return { login, cli: 0, kept };
}

export function revokeOtherUserTokens(userId: string, exceptTokenId?: string | null): number {
  const result = exceptTokenId
    ? db.run("DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL AND token_id != ?2", [userId, exceptTokenId])
    : db.run("DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL", [userId]);
  return result.changes;
}

export type LoginSession = {
  token_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  client_label: string | null;
  user_agent: string | null;
  kind: UserTokenKind;
  is_current: boolean;
};

/** 我的登录会话(未过期、未撤销),最近使用的在前。 */
export function listSessions(userId: string, currentTokenId: string | null): LoginSession[] {
  const cutoff = idleCutoffOffset();
  const rows = db.all<any>(
    `SELECT token_id, name, created_at, last_used_at, client_label, user_agent, kind FROM api_tokens
     WHERE user_id = ?1 AND ${SESSION_TOKEN_SQL} AND revoked_at IS NULL${cutoff ? `
       AND COALESCE(last_used_at, created_at) >= datetime('now', ?2)` : ""}
     ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC`,
    ...(cutoff ? [userId, cutoff] : [userId]));
  return rows.map((r) => ({
    token_id: r.token_id,
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at ?? null,
    client_label: r.client_label ?? null,
    user_agent: r.user_agent ?? null,
    kind: r.kind === "cli" ? "cli" : "login",
    is_current: !!currentTokenId && r.token_id === currentTokenId,
  }));
}

/** 撤销我的一个登录会话;可以是当前这个(= 退出登录)。不是会话令牌(API 令牌 / 节点令牌)时当作不存在。 */
export function revokeSession(userId: string, tokenId: string): { ok: boolean; error?: string } {
  const result = db.run(`DELETE FROM api_tokens WHERE token_id = ?1 AND user_id = ?2 AND ${SESSION_TOKEN_SQL}`, [tokenId, userId]);
  return result.changes > 0 ? { ok: true } : { ok: false, error: "session_not_found" };
}

/** 退出其他所有设备:撤销我除当前之外的全部登录会话(含已闲置过期的)。API 令牌、节点令牌不动。 */
export function revokeOtherSessions(userId: string, currentTokenId: string): number {
  return db.run(`DELETE FROM api_tokens WHERE user_id = ?1 AND ${SESSION_TOKEN_SQL} AND token_id != ?2`, [userId, currentTokenId]).changes;
}

export type ChangePasswordResult = { ok: boolean; error?: string; revoked?: number; revoked_login?: number; revoked_cli?: number; kept_cli_tokens?: KeptCliToken[] };

/**
 * 改密码。默认撤销该用户全部不绑网络的令牌(改密码前的行为,旧 app 依赖它)。#711:opts.keepCliTokens=true
 * 时保留 kind='cli' 的(anet 命令行登录、具名脚本令牌),并在 kept_cli_tokens 里列出。当前会话和节点令牌永远保留。
 * revoked = 两类合计(旧字段,兼容旧客户端)。
 */
export function changePassword(userId: string, oldPassword: string, newPassword: string, currentTokenId?: string | null, opts: { keepCliTokens?: boolean } = {}): ChangePasswordResult {
  const passwordError = validatePasswordStrength(newPassword, "new password");
  if (passwordError) return { ok: false, error: passwordError };
  const user = db.get<any>("SELECT password_hash FROM users WHERE user_id = ?1", userId);
  if (!user) return { ok: false, error: "user not found" };
  // Round-6 A1: verifyPassword accepts both formats. No need to
  // lazy-rehash here separately because we're about to overwrite
  // password_hash with the new password's scrypt hash below anyway.
  const verify = verifyPassword(oldPassword, user.password_hash);
  if (!verify.ok) return { ok: false, error: "incorrect current password" };
  // #261 P0-2 — clearing must_change_password as a side-effect of a real
  // password change. If the user changes via `anet passwd`, the bootstrap
  // nudge goes away on next login. SET to 0 explicitly (rather than skip)
  // so a future flag flip can't drift the state.
  db.run("UPDATE users SET password_hash = ?1, must_change_password = 0, updated_at = datetime('now') WHERE user_id = ?2", [hashPassword(newPassword), userId]);
  const keep = opts.keepCliTokens === true;
  const r = revokeTokensAfterPasswordChange(userId, currentTokenId, keep);
  return { ok: true, revoked: r.login + r.cli, revoked_login: r.login, revoked_cli: r.cli, ...(keep ? { kept_cli_tokens: r.kept } : {}) };
}

/**
 * #261 P0-2 — mark a user as needing to change their password on first
 * login. Called by the hub-bootstrap path (`anet hub start`) AFTER it
 * auto-registers the admin with a random bootstrap password. Idempotent.
 * Returns true if a row was affected (i.e. the user exists), false
 * otherwise. NOT exposed via any HTTP endpoint — internal-only, called
 * via direct module import or a local-process SQLite handle.
 */
export function markMustChangePassword(userId: string): boolean {
  const r = db.run("UPDATE users SET must_change_password = 1 WHERE user_id = ?1", [userId]);
  return r.changes > 0;
}

export function resetUserPassword(targetUsername: string, callerIsHubAdmin: boolean): { ok: boolean; error?: string; username?: string; user_id?: string; password?: string; token?: string; token_id?: string; revoked?: number } {
  if (!callerIsHubAdmin) return { ok: false, error: "hub admin required" };
  const user = db.get<any>("SELECT user_id, username FROM users WHERE username = ?1", targetUsername);
  if (!user) return { ok: false, error: "user not found" };
  const password = `anet-${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  db.run("UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE user_id = ?2", [hashPassword(password), user.user_id]);
  const revoked = revokeOtherUserTokens(user.user_id, null);
  const issued = issueUserToken(user.user_id, "admin-reset");
  db.run(
    "INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail) VALUES (?1, ?2, 'password_reset_by_admin', 'user', ?3, ?4)",
    [user.user_id, user.username, user.user_id, "local hub admin reset"]
  );
  return { ok: true, username: user.username, user_id: user.user_id, password, token: issued.token, token_id: issued.token_id, revoked };
}

// ══════════════════════════════════════
//  V3.13: Network Members
// ══════════════════════════════════════

export function getNetworkMembers(networkId: string) {
  return db.all<any>(
    `SELECT nm.user_id, nm.role, nm.joined_at, nm.invited_by, u.username, u.display_name,
            CASE WHEN u.role = 'admin' OR nm.role IN ('owner', 'admin') OR nm.agent_access = 'all' THEN 'all' ELSE 'granted' END AS agent_access,
            (SELECT COUNT(*) FROM network_member_agent_grants g WHERE g.network_id = nm.network_id AND g.user_id = nm.user_id) AS agent_grant_count,
            CASE WHEN u.role = 'admin' OR nm.role IN ('owner', 'admin') OR nm.task_access = 'all' THEN 'all' ELSE 'scoped' END AS task_access,
            (SELECT COUNT(*) FROM network_member_project_grants pg WHERE pg.network_id = nm.network_id AND pg.user_id = nm.user_id) AS task_project_count,
            (SELECT COUNT(*) FROM network_member_group_grants gg WHERE gg.network_id = nm.network_id AND gg.user_id = nm.user_id) AS agent_group_count,
            nm.department_id
     FROM network_members nm JOIN users u ON nm.user_id = u.user_id
     WHERE nm.network_id = ?1 ORDER BY nm.joined_at`,
    networkId);
}

/** 网络里的人类成员(给受限成员也能看的通讯录):只有身份字段,不含角色与授权。 */
export function getNetworkHumans(networkId: string) {
  return db.all<{ user_id: string; username: string; display_name: string | null }>(
    `SELECT u.user_id, u.username, u.display_name
       FROM network_members nm JOIN users u ON nm.user_id = u.user_id
      WHERE nm.network_id = ?1 ORDER BY COALESCE(NULLIF(u.display_name, ''), u.username), u.user_id`,
    networkId);
}

export function getUserNetworkRole(userId: string, networkId: string): string | null {
  const row = db.get<any>("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  return row?.role || null;
}

const MEMBER_ROLES = new Set(["admin", "member", "viewer"]);

/**
 * 用户名与本网络某个 Agent 的 alias 相同时不能入网:用户的私人 SSE 频道、inbox、
 * 任务往来都按「用户名」寻址,与 alias 撞名会让受限成员收到那个 Agent 的流量。
 * 只在入网时查(管理员 / 邀请码持有者才触发),不放在公开的 /api/auth/register 上,
 * 免得注册接口变成 alias 探测器。
 */
export function usernameCollidesWithAgent(networkId: string, userId: string): boolean {
  return !!db.get(
    `SELECT 1 FROM users u WHERE u.user_id = ?2 AND (
       EXISTS (SELECT 1 FROM sessions s WHERE s.network_id = ?1 AND s.alias = u.username)
       OR EXISTS (SELECT 1 FROM nodes n WHERE n.network_id = ?1 AND n.alias = u.username))`,
    networkId, userId,
  );
}

// 新成员默认 agent_access='granted'(零 Agent 权限),owner/admin 角色不看这一列。
export function addNetworkMember(networkId: string, userId: string, role: string, invitedBy?: string, opts: { agentAccess?: "all" | "granted"; taskAccess?: TaskAccessMode } = {}): { ok: boolean; error?: string } {
  if (!MEMBER_ROLES.has(role)) return { ok: false, error: "invalid role" };
  const agentAccess = opts.agentAccess === "all" ? "all" : "granted";
  // 任务范围:新成员默认 NEW_MEMBER_TASK_ACCESS(task-access.ts 一处定义)。
  const taskAccess: TaskAccessMode = opts.taskAccess === "all" || opts.taskAccess === "scoped" ? opts.taskAccess : NEW_MEMBER_TASK_ACCESS;
  if (!db.get("SELECT 1 FROM users WHERE user_id = ?1", userId)) return { ok: false, error: "user not found" };
  const existing = db.get<any>("SELECT 1 FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  if (existing) return { ok: false, error: "user already a member" };
  if (usernameCollidesWithAgent(networkId, userId)) return { ok: false, error: "username_collides_with_agent_alias" };
  db.run("INSERT INTO network_members (network_id, user_id, role, invited_by, agent_access, task_access) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [networkId, userId, role, invitedBy || null, agentAccess, taskAccess]);
  return { ok: true };
}

export function updateMemberRole(networkId: string, userId: string, newRole: string): { ok: boolean; error?: string } {
  if (newRole === "owner") return { ok: false, error: "cannot assign owner role" };
  const result = db.run("UPDATE network_members SET role = ?1 WHERE network_id = ?2 AND user_id = ?3 AND role != 'owner'",
    [newRole, networkId, userId]);
  return result.changes > 0 ? { ok: true } : { ok: false, error: "member not found or is owner" };
}

export function removeNetworkMember(networkId: string, userId: string): { ok: boolean; error?: string } {
  const member = db.get<any>("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  if (!member) return { ok: false, error: "not a member" };
  if (member.role === "owner") return { ok: false, error: "cannot remove owner" };
  groupTx(() => { // RFC-042 §9.3:同 db.transaction,另在提交后推 group_membership_changed(移出网络 → 他所在每个群)
    db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
    // #488 —— 他在这个网络里的令牌(节点令牌 / 邀请码令牌)一起吊销;resolveToken 也会拒非成员的令牌,这里让库里的状态如实。
    db.run("UPDATE api_tokens SET revoked_at = datetime('now') WHERE network_id = ?1 AND user_id = ?2 AND revoked_at IS NULL", [networkId, userId]);
    deleteAgentGrants(networkId, userId);
    deleteTaskGrantsForMember(networkId, userId); removeMemberFromChatGroups(networkId, userId); // RFC-042:他在本网络所有群里的行(不论来源)。同一行:文档钉着 auth.ts 的行号
  });
  return { ok: true };
}

// ══════════════════════════════════════
//  V3.13: Invite Codes
// ══════════════════════════════════════

export function createInvite(networkId: string, createdBy: string, role: string = "member", maxUses: number = 1, expiresInDays?: number): { ok: boolean; invite_code?: string; error?: string } {
  if (!["admin", "member", "viewer"].includes(role)) return { ok: false, error: "invalid role" };
  const code = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const expiresAt = expiresInDays ? `datetime('now', '+${expiresInDays} days')` : null;
  if (expiresAt) {
    db.run("INSERT INTO network_invites (invite_code, network_id, role, created_by, max_uses, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', ?6))",
      [code, networkId, role, createdBy, maxUses, `+${expiresInDays} days`]);
  } else {
    db.run("INSERT INTO network_invites (invite_code, network_id, role, created_by, max_uses) VALUES (?1, ?2, ?3, ?4, ?5)",
      [code, networkId, role, createdBy, maxUses]);
  }
  return { ok: true, invite_code: code };
}

export function joinByInvite(inviteCode: string, userId: string): { ok: boolean; network_id?: string; role?: string; error?: string } {
  const invite = db.get<any>(
    "SELECT invite_code, network_id, role, created_by, max_uses, used_count, expires_at, created_at FROM network_invites WHERE invite_code = ?1",
    inviteCode,
  );
  if (!invite) return { ok: false, error: "invalid invite code" };
  if (invite.max_uses > 0 && invite.used_count >= invite.max_uses) return { ok: false, error: "invite code fully used" };
  if (invite.expires_at) {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    if (invite.expires_at < now) return { ok: false, error: "invite code expired" };
  }
  // Check not already member
  const existing = db.get<any>("SELECT 1 FROM network_members WHERE network_id = ?1 AND user_id = ?2", invite.network_id, userId);
  if (existing) return { ok: false, error: "already a member of this network" };
  if (usernameCollidesWithAgent(invite.network_id, userId)) return { ok: false, error: "username_collides_with_agent_alias" };
  // Add member + increment used count
  db.run("INSERT INTO network_members (network_id, user_id, role, invited_by, agent_access, task_access) VALUES (?1, ?2, ?3, ?4, 'granted', ?5)",
    [invite.network_id, userId, invite.role, invite.created_by, NEW_MEMBER_TASK_ACCESS]);
  db.run("UPDATE network_invites SET used_count = used_count + 1 WHERE invite_code = ?1", [inviteCode]);
  // 受限成员不能持有网络令牌(resolveToken 会拒),别签一个用不了的。
  if (isAgentRestricted(userId, invite.network_id)) return { ok: true, network_id: invite.network_id, role: invite.role };
  // Auto-create a token for this network
  const token = generateToken();
  const tokenId = generateId("tok");
  db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, node_identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
    [tokenId, hashToken(token), userId, invite.network_id, "auto-join", "full"]);
  return { ok: true, network_id: invite.network_id, role: invite.role };
}

/** Get all networks a user is a member of (replaces owner-only query) */
export function getUserAllNetworks(userId: string) {
  return db.all<any>(
    `SELECT ${sqlColumns(NETWORK_REST_COLUMNS, "n")}, nm.role as member_role,
            -- 多用户 Agent 权限:客户端据此显示「还没有被分配任何 Agent,请联系管理员」。
            CASE WHEN u.role = 'admin' OR nm.role IN ('owner', 'admin') OR nm.agent_access = 'all' THEN 'all' ELSE 'granted' END AS agent_access,
            -- 任务权限(RFC-038 §9):客户端据此显示只读提示与「还没有与你相关的任务」。
            CASE WHEN u.role = 'admin' OR nm.role IN ('owner', 'admin') OR nm.task_access = 'all' THEN 'all' ELSE 'scoped' END AS task_access
     FROM networks n JOIN network_members nm ON n.network_id = nm.network_id
     JOIN users u ON u.user_id = nm.user_id
     WHERE nm.user_id = ?1 ORDER BY nm.role = 'owner' DESC, n.created_at`,
    userId);
}

// ══════════════════════════════════════
//  多用户账号:管理员建号
// ══════════════════════════════════════

export type AdminCreateUserInput = {
  username?: unknown;
  password?: unknown;
  display_name?: unknown;
  email?: unknown;
  network_id?: unknown;
  role?: unknown;
};

export type AdminCreateUserResult =
  | { ok: true; user: AuthUser; network_id: string; membership: { network_id: string; role: string; agent_access: "granted" } | null }
  | { ok: false; error: string; status: number };

/**
 * 管理员(或某网络的 owner/admin,限于把人建进自己管的网络)代建账号。
 * 走 register() 的全部规则(用户名、密码 ≥ 8 且不是弱密码、自动建个人网络),
 * 但不签发令牌 —— 用户自己登录才拿令牌。
 * 可选一步把新用户加进 network_id,默认 role=member、agent_access='granted'(零 Agent 权限)。
 * 建号与入网在同一事务里:入网失败(如用户名与 Agent alias 撞名)时账号也不落库。
 */
export function adminCreateUser(input: AdminCreateUserInput, actor: { userId: string; isHubAdmin: boolean }): AdminCreateUserResult {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const username = str(input.username);
  const password = typeof input.password === "string" ? input.password : "";
  const displayName = str(input.display_name) || undefined;
  const email = str(input.email) || undefined;
  const networkId = str(input.network_id) || null;
  const role = str(input.role) || "member";

  if (networkId) {
    if (!db.get("SELECT 1 FROM networks WHERE network_id = ?1", networkId)) return { ok: false, error: "network_not_found", status: 404 };
    if (!MEMBER_ROLES.has(role)) return { ok: false, error: "invalid role", status: 400 };
    const actorRole = getUserNetworkRole(actor.userId, networkId);
    if (!actor.isHubAdmin && actorRole !== "owner" && actorRole !== "admin") return { ok: false, error: "owner/admin required", status: 403 };
    // 网络 admin 不能建出和自己平级的 admin;只有 owner / Hub 管理员可以。
    if (role === "admin" && !actor.isHubAdmin && actorRole !== "owner") return { ok: false, error: "owner required to add admins", status: 403 };
  } else if (!actor.isHubAdmin) {
    return { ok: false, error: "admin required", status: 403 };
  }
  // 首个用户会被 register() 自动设成 Hub 管理员;代建路径上永远不会是首个用户(调用者本身就是用户)。
  // 但仍显式拒绝,防止空库 + 旧令牌之类的边角把代建变成「造管理员」。
  const userCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM users");
  if (!userCount || userCount.cnt === 0) return { ok: false, error: "bootstrap_via_register", status: 400 };

  class Rollback extends Error { constructor(readonly result: AdminCreateUserResult) { super("rollback"); } }
  try {
    return db.transaction(() => {
      const created = register(username, password, email, displayName, { issueTokens: false });
      if (!created.ok || !created.user) throw new Rollback({ ok: false, error: created.error || "register_failed", status: 400 });
      if (!networkId) return { ok: true as const, user: created.user, network_id: created.network_id!, membership: null };
      const added = addNetworkMember(networkId, created.user.user_id, role, actor.userId);
      if (!added.ok) throw new Rollback({ ok: false, error: added.error || "add_member_failed", status: added.error === "username_collides_with_agent_alias" ? 409 : 400 });
      return {
        ok: true as const,
        user: created.user,
        network_id: created.network_id!,
        membership: { network_id: networkId, role, agent_access: "granted" as const },
      };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    throw error;
  }
}

/** Hub 管理员的用户列表:每个用户带上他所在的网络与角色、agent_access。不含密码哈希。 */
export function listUsersWithMemberships() {
  const users = db.all<{ user_id: string; username: string; display_name: string | null; email: string | null; role: string; created_at: string }>(
    "SELECT user_id, username, display_name, email, role, created_at FROM users ORDER BY created_at",
  );
  const memberships = db.all<{ user_id: string; network_id: string; network_name: string | null; role: string; agent_access: string | null }>(
    `SELECT nm.user_id, nm.network_id, n.network_name, nm.role, nm.agent_access
       FROM network_members nm JOIN networks n ON n.network_id = nm.network_id`,
  );
  const byUser = new Map<string, Array<{ network_id: string; network_name: string | null; role: string; agent_access: "all" | "granted" }>>();
  for (const m of memberships) {
    const list = byUser.get(m.user_id) ?? [];
    list.push({ network_id: m.network_id, network_name: m.network_name, role: m.role, agent_access: m.agent_access === "all" ? "all" : "granted" });
    byUser.set(m.user_id, list);
  }
  return users.map((u) => ({ ...u, networks: byUser.get(u.user_id) ?? [] }));
}

// Hub 管理员删**别人的**网络(清理旧测试账号留下的个人网络)。只删空网络:
// 下面每张表里有一行就拒(409),并把计数原样回给调用方。表是按 schema 里所有带
// network_id 的表逐个分类的,不是凭记忆 —— 新加一张带 network_id 的表要在这里归一类。
//   阻断:真实内容,或会在删后重新长出节点的在途请求。
//   清理:只描述「这个网络」本身的元数据/历史,网络没了它们就悬空。
//   保留:audit_log(删除记录本身要留下)。
const NETWORK_CONTENT_CHECKS: Array<[label: string, sql: string]> = [
  ["nodes", "SELECT COUNT(*) AS cnt FROM nodes WHERE network_id = ?1"],
  ["sessions", "SELECT COUNT(*) AS cnt FROM sessions WHERE network_id = ?1"],
  ["tasks", "SELECT COUNT(*) AS cnt FROM tasks WHERE network_id = ?1"],
  ["inbox", "SELECT COUNT(*) AS cnt FROM inbox WHERE network_id = ?1"],
  ["user_inbox", "SELECT COUNT(*) AS cnt FROM user_inbox WHERE network_id = ?1"],
  ["requirements", "SELECT COUNT(*) AS cnt FROM requirements WHERE network_id = ?1"],
  ["requirement_projects", "SELECT COUNT(*) AS cnt FROM requirement_projects WHERE network_id = ?1"],
  ["scheduled_tasks", "SELECT COUNT(*) AS cnt FROM scheduled_tasks WHERE network_id = ?1"],
  ["providers", "SELECT COUNT(*) AS cnt FROM providers WHERE network_id = ?1"],
  ["network_secrets", "SELECT COUNT(*) AS cnt FROM network_secrets WHERE network_id = ?1"],
  ["skillhub_skills", "SELECT COUNT(*) AS cnt FROM skillhub_skills WHERE network_id = ?1"],
  ["side_chats", "SELECT COUNT(*) AS cnt FROM side_chats WHERE network_id = ?1"],
  // #2144 —— 组是管理员手工建的配置,和 requirements 一样算内容:有组就拒,别替人删掉。
  ["agent_groups", "SELECT COUNT(*) AS cnt FROM agent_groups WHERE network_id = ?1"],
  ["pending_node_create_requests", "SELECT COUNT(*) AS cnt FROM node_create_requests WHERE network_id = ?1 AND status IN ('pending', 'delivered')"],
  ["pending_node_start_requests", "SELECT COUNT(*) AS cnt FROM node_start_requests WHERE network_id = ?1 AND status IN ('pending', 'delivered')"],
];
const NETWORK_CLEANUP_TABLES = [
  "network_members", "network_member_agent_grants", "network_invites", "api_tokens",
  "node_create_requests", "node_start_requests", "node_stop_requests", "node_rules_requests",
  "node_config_updates", "rename_txn", "probe_results", "agent_telemetry", "completions",
  "task_events", "task_terminal_events", "task_late_replies", "scheduled_task_runs", "external_schedule_edits",
  // 标签颜色:网络本身的元数据(标签本体在 requirements 行里,那张表是阻断项)。
  "network_tags",
  // 组织架构(board #419):部门是网络本身的元数据。
  "network_departments",
];

function tableExists(name: string): boolean {
  return db.dialect === "postgres"
    ? !!db.get("SELECT 1 AS x FROM information_schema.tables WHERE table_name = ?1", name)
    : !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?1", name);
}

export function countNetworkContents(networkId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [label, sql] of NETWORK_CONTENT_CHECKS) {
    const table = sql.match(/FROM (\w+)/)![1];
    // 按需建表的模块(requirements / side-thread)在没用过的库上可能还没有这张表 —— 那就是 0 行。
    if (!tableExists(table)) continue;
    const cnt = db.get<{ cnt: number }>(sql, networkId)?.cnt ?? 0;
    if (cnt > 0) counts[label] = cnt;
  }
  return counts;
}

export type AdminDeleteNetworkResult =
  | { ok: true; owner_id: string; network_name: string; cleaned: Record<string, number> }
  | { ok: false; status: number; error: string; counts?: Record<string, number> };

// extraCounts:库外的内容(上传文件的索引在磁盘上),由调用方数好传进来,和库内计数一起判。
export function adminDeleteEmptyNetwork(networkId: string, extraCounts: Record<string, number> = {}): AdminDeleteNetworkResult {
  if (networkId === "default") return { ok: false, status: 409, error: "the default network cannot be deleted" };
  return db.transaction((): AdminDeleteNetworkResult => {
    const net = db.get<{ owner_id: string; network_name: string }>("SELECT owner_id, network_name FROM networks WHERE network_id = ?1", networkId);
    if (!net) return { ok: false, status: 404, error: "network not found" };
    const counts = { ...countNetworkContents(networkId) };
    for (const [k, v] of Object.entries(extraCounts)) if (v > 0) counts[k] = v;
    if (Object.keys(counts).length > 0) {
      const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
      return { ok: false, status: 409, error: `network is not empty (${summary}); only empty networks can be deleted by a hub admin`, counts };
    }
    const cleaned: Record<string, number> = {};
    for (const table of NETWORK_CLEANUP_TABLES) {
      if (!tableExists(table)) continue;
      const changes = db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [networkId]).changes;
      if (changes > 0) cleaned[table] = changes;
    }
    for (const [table, changes] of Object.entries(deleteNetworkAgentGroups(networkId))) if (changes > 0) cleaned[table] = changes;
    db.run("DELETE FROM networks WHERE network_id = ?1", [networkId]);
    return { ok: true, owner_id: net.owner_id, network_name: net.network_name, cleaned };
  });
}

// #2144 —— Agent 分组(#2131)的三张表跟着网络一起删。agent_group_members 没有 network_id 列,
// 只能按该网络的 group_id 删,所以必须在删 agent_groups 之前删它。owner 删网络与管理员删空网络共用。
export function deleteNetworkAgentGroups(networkId: string): Record<string, number> {
  return {
    network_member_group_grants: db.run("DELETE FROM network_member_group_grants WHERE network_id = ?1", [networkId]).changes,
    agent_group_members: db.run("DELETE FROM agent_group_members WHERE group_id IN (SELECT group_id FROM agent_groups WHERE network_id = ?1)", [networkId]).changes,
    agent_groups: db.run("DELETE FROM agent_groups WHERE network_id = ?1", [networkId]).changes,
  };
}
