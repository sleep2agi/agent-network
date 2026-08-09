/**
 * V3 Auth module — user registration, login, token management
 */
import { db, generateId, hashPassword, verifyPassword, hashToken, generateToken, generateUserToken, generateNetworkToken, uuidv4 } from "./db.js";
import { WEAK_PASSWORDS } from "./password-dict.js";
import { NETWORK_REST_COLUMNS, NETWORK_REST_SELECT, sqlColumns } from "./rest-projections.js";

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

export function register(username: string, password: string, email?: string, displayName?: string): AuthResult {
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

  // Auto-create default network + add as owner member
  const networkId = generateId("net");
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, description) VALUES (?1, ?2, ?3, ?4)",
    [networkId, "default", userId, "Auto-created default network"]
  );
  db.run(
    "INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')",
    [networkId, userId]
  );

  // User token (utok_) — not bound to network, for CLI/Dashboard login
  const userToken = generateUserToken();
  const userTokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [userTokenId, hashToken(userToken), userId, null, "user-login", "user"]
  );

  // Network token (ntok_) — bound to default network, for agent-node
  const networkToken = generateNetworkToken();
  const networkTokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [networkTokenId, hashToken(networkToken), userId, networkId, "default-network", "network"]
  );

  return {
    ok: true,
    user: { user_id: userId, username, display_name: displayName || username, email: email || null, role: isFirstUser ? "admin" : "user" },
    token: userToken,
    network_token: networkToken,
    network_id: networkId,
  };
}

export function login(username: string, password: string): AuthResult {
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

  // Issue a NEW user token — do NOT rotate/invalidate existing ones. Each
  // login (cli, dashboard, second machine) gets its own row so they don't
  // kick each other out of session. Tokens can be revoked via /api/auth/tokens.
  const userToken = generateUserToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [tokenId, hashToken(userToken), user.user_id, null, "user-login", "user"]
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
    network_id: networkId,
    // #261 P0-2 — only include field when truthy (back-compat; old clients
    // don't see this field at all unless their account is flagged).
    ...(user.must_change_password === 1 ? { must_change_password: true } : {}),
  };
}

/** Create a network-scoped token (ntok_) for a specific node */
export function createNetworkTokenForNode(userId: string, networkId: string, nodeName: string): { ok: boolean; token?: string; error?: string } {
  // Verify user is a member of this network with write access
  const role = getUserNetworkRole(userId, networkId);
  if (!role || role === "viewer") return { ok: false, error: "no write access to this network" };
  const token = generateNetworkToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [tokenId, hashToken(token), userId, networkId, `node:${nodeName}`, "network"]
  );
  return { ok: true, token };
}

export function resolveToken(token: string): { user: AuthUser; networkId: string | null; tokenName: string | null; tokenId: string | null } | null {
  const tHash = hashToken(token);
  const row = db.get<any>(
    `SELECT t.token_id, t.user_id, t.network_id, t.scope, t.name AS token_name,
            u.username, u.display_name, u.email, u.role
     FROM api_tokens t JOIN users u ON t.user_id = u.user_id
     WHERE t.token_hash = ?1
       AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
       AND t.revoked_at IS NULL`,
    tHash);

  if (!row) return null;

  // Update last_used
  db.run("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?1", [tHash]);

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
  db.run("DELETE FROM networks WHERE network_id = ?1 AND owner_id = ?2", [networkId, userId]);
  // PR #519 codex catch: leaving membership rows behind made deleted
  // networks count toward getUserNetworkIds — a stale row could flip a
  // single-network user to "ambiguous" or auto-resolve writes INTO the
  // deleted network. Remove memberships with the network.
  db.run("DELETE FROM network_members WHERE network_id = ?1", [networkId]);
  return { ok: true };
}

export function createToken(userId: string, name: string, networkId?: string): { ok: boolean; token?: string; token_id?: string; error?: string } {
  // Security: verify user is a member of the target network
  if (networkId) {
    const role = getUserNetworkRole(userId, networkId);
    if (!role) return { ok: false, error: "not a member of this network" };
    if (role === "viewer") return { ok: false, error: "viewer cannot create full-access network tokens" };
  }
  const token = generateToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [tokenId, hashToken(token), userId, networkId || null, name, "full"]
  );
  return { ok: true, token, token_id: tokenId };
}

export function revokeToken(userId: string, tokenId: string): { ok: boolean; error?: string } {
  const result = db.run("DELETE FROM api_tokens WHERE token_id = ?1 AND user_id = ?2", [tokenId, userId]);
  return result.changes > 0 ? { ok: true } : { ok: false, error: "token not found" };
}

export function issueUserToken(userId: string, name = "user-login"): { token: string; token_id: string } {
  const token = generateUserToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, NULL, ?4, 'user')",
    [tokenId, hashToken(token), userId, name]
  );
  return { token, token_id: tokenId };
}

export function revokeOtherUserTokens(userId: string, exceptTokenId?: string | null): number {
  const result = exceptTokenId
    ? db.run("DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL AND token_id != ?2", [userId, exceptTokenId])
    : db.run("DELETE FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL", [userId]);
  return result.changes;
}

export function changePassword(userId: string, oldPassword: string, newPassword: string, currentTokenId?: string | null): { ok: boolean; error?: string; revoked?: number } {
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
  const revoked = revokeOtherUserTokens(userId, currentTokenId);
  return { ok: true, revoked };
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
    `SELECT nm.user_id, nm.role, nm.joined_at, nm.invited_by, u.username, u.display_name
     FROM network_members nm JOIN users u ON nm.user_id = u.user_id
     WHERE nm.network_id = ?1 ORDER BY nm.joined_at`,
    networkId);
}

export function getUserNetworkRole(userId: string, networkId: string): string | null {
  const row = db.get<any>("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  return row?.role || null;
}

export function addNetworkMember(networkId: string, userId: string, role: string, invitedBy?: string): { ok: boolean; error?: string } {
  const existing = db.get<any>("SELECT 1 FROM network_members WHERE network_id = ?1 AND user_id = ?2", networkId, userId);
  if (existing) return { ok: false, error: "user already a member" };
  db.run("INSERT INTO network_members (network_id, user_id, role, invited_by) VALUES (?1, ?2, ?3, ?4)",
    [networkId, userId, role, invitedBy || null]);
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
  db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [networkId, userId]);
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
  // Add member + increment used count
  db.run("INSERT INTO network_members (network_id, user_id, role, invited_by) VALUES (?1, ?2, ?3, ?4)",
    [invite.network_id, userId, invite.role, invite.created_by]);
  db.run("UPDATE network_invites SET used_count = used_count + 1 WHERE invite_code = ?1", [inviteCode]);
  // Auto-create a token for this network
  const token = generateToken();
  const tokenId = generateId("tok");
  db.run("INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [tokenId, hashToken(token), userId, invite.network_id, "auto-join", "full"]);
  return { ok: true, network_id: invite.network_id, role: invite.role };
}

/** Get all networks a user is a member of (replaces owner-only query) */
export function getUserAllNetworks(userId: string) {
  return db.all<any>(
    `SELECT ${sqlColumns(NETWORK_REST_COLUMNS, "n")}, nm.role as member_role
     FROM networks n JOIN network_members nm ON n.network_id = nm.network_id
     WHERE nm.user_id = ?1 ORDER BY nm.role = 'owner' DESC, n.created_at`,
    userId);
}
