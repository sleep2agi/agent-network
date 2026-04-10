/**
 * V3 Auth module — user registration, login, token management
 */
import { db, generateId, hashPassword, hashToken, generateToken, uuidv4 } from "./db.js";

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
  token?: string;
}

export function register(username: string, password: string, email?: string, displayName?: string): AuthResult {
  if (!username || username.length < 2) return { ok: false, error: "username must be at least 2 characters" };
  if (!password || password.length < 6) return { ok: false, error: "password must be at least 6 characters" };
  if (!/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(username)) return { ok: false, error: "username contains invalid characters" };

  const existing = db.query<any, [string]>("SELECT user_id FROM users WHERE username = ?1").get(username);
  if (existing) return { ok: false, error: "username already taken" };

  const userId = generateId("u");
  const pwHash = hashPassword(password);

  db.run(
    "INSERT INTO users (user_id, username, password_hash, email, display_name) VALUES (?1, ?2, ?3, ?4, ?5)",
    [userId, username, pwHash, email || null, displayName || username]
  );

  // Auto-create default network
  const networkId = generateId("net");
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, description) VALUES (?1, ?2, ?3, ?4)",
    [networkId, "default", userId, "Auto-created default network"]
  );

  // Auto-create API token
  const token = generateToken();
  const tokenId = generateId("tok");
  db.run(
    "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [tokenId, hashToken(token), userId, networkId, "default", "full"]
  );

  return {
    ok: true,
    user: { user_id: userId, username, display_name: displayName || username, email: email || null, role: "user" },
    token,
  };
}

export function login(username: string, password: string): AuthResult {
  const user = db.query<any, [string]>(
    "SELECT user_id, username, password_hash, display_name, email, role FROM users WHERE username = ?1"
  ).get(username);

  if (!user) return { ok: false, error: "invalid username or password" };
  if (user.password_hash !== hashPassword(password)) return { ok: false, error: "invalid username or password" };

  // Find or create token
  let tokenRow = db.query<any, [string]>(
    "SELECT token_id FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1"
  ).get(user.user_id);

  let token: string;
  if (tokenRow) {
    // Generate new token (rotate)
    token = generateToken();
    db.run("UPDATE api_tokens SET token_hash = ?1, last_used_at = datetime('now') WHERE token_id = ?2",
      [hashToken(token), tokenRow.token_id]);
  } else {
    token = generateToken();
    const tokenId = generateId("tok");
    const networkId = db.query<any, [string]>(
      "SELECT network_id FROM networks WHERE owner_id = ?1 LIMIT 1"
    ).get(user.user_id)?.network_id;
    db.run(
      "INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name) VALUES (?1, ?2, ?3, ?4, ?5)",
      [tokenId, hashToken(token), user.user_id, networkId || null, "login"]
    );
  }

  return {
    ok: true,
    user: { user_id: user.user_id, username: user.username, display_name: user.display_name, email: user.email, role: user.role },
    token,
  };
}

export function resolveToken(token: string): { user: AuthUser; networkId: string | null } | null {
  const tHash = hashToken(token);
  const row = db.query<any, [string]>(
    `SELECT t.user_id, t.network_id, t.scope, u.username, u.display_name, u.email, u.role
     FROM api_tokens t JOIN users u ON t.user_id = u.user_id
     WHERE t.token_hash = ?1 AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))`
  ).get(tHash);

  if (!row) return null;

  // Update last_used
  db.run("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?1", [tHash]);

  return {
    user: { user_id: row.user_id, username: row.username, display_name: row.display_name, email: row.email, role: row.role },
    networkId: row.network_id,
  };
}

export function getUserNetworks(userId: string) {
  return db.query<any, [string]>(
    "SELECT * FROM networks WHERE owner_id = ?1 ORDER BY created_at"
  ).all(userId);
}

export function createNetwork(userId: string, name: string, description?: string) {
  const existing = db.query<any, [string, string]>(
    "SELECT network_id FROM networks WHERE owner_id = ?1 AND network_name = ?2"
  ).get(userId, name);
  if (existing) return { ok: false, error: "network name already exists" };

  const networkId = generateId("net");
  db.run(
    "INSERT INTO networks (network_id, network_name, owner_id, description) VALUES (?1, ?2, ?3, ?4)",
    [networkId, name, userId, description || null]
  );
  return { ok: true, network_id: networkId, network_name: name };
}

export function changePassword(userId: string, oldPassword: string, newPassword: string): { ok: boolean; error?: string } {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: "new password must be at least 6 characters" };
  const user = db.query<any, [string]>("SELECT password_hash FROM users WHERE user_id = ?1").get(userId);
  if (!user) return { ok: false, error: "user not found" };
  if (user.password_hash !== hashPassword(oldPassword)) return { ok: false, error: "incorrect current password" };
  db.run("UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE user_id = ?2", [hashPassword(newPassword), userId]);
  return { ok: true };
}
