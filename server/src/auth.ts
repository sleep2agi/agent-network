/**
 * V3 Auth module — user registration, login, token management
 */
import { db, generateId, hashPassword, hashToken, generateToken, generateUserToken, generateNetworkToken, uuidv4 } from "./db.js";

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
}

export function register(username: string, password: string, email?: string, displayName?: string): AuthResult {
  if (!username || username.length < 2) return { ok: false, error: "username must be at least 2 characters" };
  if (username.length > 50) return { ok: false, error: "username too long (max 50)" };
  if (!password || password.length < 6) return { ok: false, error: "password must be at least 6 characters" };
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(username)) return { ok: false, error: "username contains invalid characters" };

  const existing = db.get<any>("SELECT user_id FROM users WHERE username = ?1", username);
  if (existing) return { ok: false, error: "username already taken" };

  // First user → auto admin
  const userCount = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM users");
  const isFirstUser = !userCount || userCount.cnt === 0;

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
    "SELECT user_id, username, password_hash, display_name, email, role FROM users WHERE username = ?1",
    username);

  if (!user) return { ok: false, error: "invalid username or password" };
  if (user.password_hash !== hashPassword(password)) return { ok: false, error: "invalid username or password" };

  // Generate/rotate user token (utok_, not bound to network)
  let userTokenRow = db.get<any>(
    "SELECT token_id FROM api_tokens WHERE user_id = ?1 AND scope = 'user' ORDER BY created_at DESC LIMIT 1",
    user.user_id);

  const userToken = generateUserToken();
  if (userTokenRow) {
    db.run("UPDATE api_tokens SET token_hash = ?1, last_used_at = datetime('now') WHERE token_id = ?2",
      [hashToken(userToken), userTokenRow.token_id]);
  } else {
    const tokenId = generateId("tok");
    db.run(
      "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [tokenId, hashToken(userToken), user.user_id, null, "user-login", "user"]
    );
  }

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

export function resolveToken(token: string): { user: AuthUser; networkId: string | null } | null {
  const tHash = hashToken(token);
  const row = db.get<any>(
    `SELECT t.user_id, t.network_id, t.scope, u.username, u.display_name, u.email, u.role
     FROM api_tokens t JOIN users u ON t.user_id = u.user_id
     WHERE t.token_hash = ?1 AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))`,
    tHash);

  if (!row) return null;

  // Update last_used
  db.run("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?1", [tHash]);

  return {
    user: { user_id: row.user_id, username: row.username, display_name: row.display_name, email: row.email, role: row.role },
    networkId: row.network_id,
  };
}

export function getUserNetworks(userId: string) {
  return db.all<any>(
    "SELECT * FROM networks WHERE owner_id = ?1 ORDER BY created_at",
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
  const net = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", networkId);
  if (!net) return { ok: false, error: "network not found" };
  if (net.owner_id !== userId) return { ok: false, error: "not your network" };
  const dup = db.get<any>("SELECT network_id FROM networks WHERE owner_id = ?1 AND network_name = ?2", userId, newName);
  if (dup) return { ok: false, error: "name already taken" };
  db.run("UPDATE networks SET network_name = ?1, updated_at = datetime('now') WHERE network_id = ?2", [newName, networkId]);
  return { ok: true };
}

export function deleteNetwork(userId: string, networkId: string): { ok: boolean; error?: string } {
  const net = db.get<any>("SELECT * FROM networks WHERE network_id = ?1", networkId);
  if (!net) return { ok: false, error: "network not found" };
  if (net.owner_id !== userId) return { ok: false, error: "not your network" };
  // Check if any sessions/tasks still reference this network
  const sessions = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sessions WHERE network_id = ?1", networkId);
  if (sessions && sessions.cnt > 0) return { ok: false, error: `network has ${sessions.cnt} active session(s) — stop them first` };
  db.run("DELETE FROM networks WHERE network_id = ?1 AND owner_id = ?2", [networkId, userId]);
  return { ok: true };
}

export function createToken(userId: string, name: string, networkId?: string): { ok: boolean; token?: string; token_id?: string; error?: string } {
  // Security: verify user is a member of the target network
  if (networkId) {
    const role = getUserNetworkRole(userId, networkId);
    if (!role) return { ok: false, error: "not a member of this network" };
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

export function changePassword(userId: string, oldPassword: string, newPassword: string): { ok: boolean; error?: string } {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "new password must be at least 6 characters" };
  const user = db.get<any>("SELECT password_hash FROM users WHERE user_id = ?1", userId);
  if (!user) return { ok: false, error: "user not found" };
  if (user.password_hash !== hashPassword(oldPassword)) return { ok: false, error: "incorrect current password" };
  db.run("UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE user_id = ?2", [hashPassword(newPassword), userId]);
  return { ok: true };
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
  const invite = db.get<any>("SELECT * FROM network_invites WHERE invite_code = ?1", inviteCode);
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
    `SELECT n.*, nm.role as member_role
     FROM networks n JOIN network_members nm ON n.network_id = nm.network_id
     WHERE nm.user_id = ?1 ORDER BY nm.role = 'owner' DESC, n.created_at`,
    userId);
}
