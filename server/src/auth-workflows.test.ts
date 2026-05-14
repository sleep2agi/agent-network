import { beforeEach, describe, expect, it } from "bun:test";
import {
  addNetworkMember,
  changePassword,
  createInvite,
  createNetwork,
  createNetworkTokenForNode,
  createToken,
  deleteNetwork,
  getUserNetworkRole,
  issueUserToken,
  joinByInvite,
  listTokens,
  login,
  register,
  removeNetworkMember,
  renameNetwork,
  resetUserPassword,
  resolveToken,
  revokeOtherUserTokens,
  revokeToken,
  updateMemberRole,
} from "./auth.js";
import { db } from "./db.js";

function wipeAuthState() {
  db.run("DELETE FROM api_tokens");
  db.run("DELETE FROM network_invites");
  db.run("DELETE FROM network_members");
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM networks");
  db.run("DELETE FROM users");
  db.run("DELETE FROM audit_log");
}

beforeEach(() => {
  wipeAuthState();
});

describe("auth workflow — bootstrap/login/token resolution", () => {
  it("registers first user as admin with default network and member owner role", () => {
    const r = register("bootstrap_admin", "abcd");
    expect(r.ok).toBe(true);
    expect(r.user?.role).toBe("admin");
    expect(r.token?.startsWith("utok_")).toBe(true);
    expect(r.network_token?.startsWith("ntok_")).toBe(true);
    expect(getUserNetworkRole(r.user!.user_id, r.network_id!)).toBe("owner");
  });

  it("login issues a new user token and resolveToken returns user info", () => {
    register("admin_seed", "abcd");
    const u = register("alice", "StrongPw123");
    expect(u.ok).toBe(true);

    const logged = login("alice", "StrongPw123");
    expect(logged.ok).toBe(true);
    expect(logged.token?.startsWith("utok_")).toBe(true);

    const resolved = resolveToken(logged.token!);
    expect(resolved?.user.username).toBe("alice");
    expect(resolved?.networkId).toBe(null);
    expect(resolved?.tokenName).toBe("user-login");

    const tokenRow = db.get<{ last_used_at: string | null }>(
      "SELECT last_used_at FROM api_tokens WHERE token_id = ?1",
      resolved?.tokenId,
    );
    expect(tokenRow?.last_used_at).not.toBeNull();
  });

  it("rejects login when password is incorrect", () => {
    register("admin_seed", "abcd");
    register("alice", "StrongPw123");
    const logged = login("alice", "bad-password");
    expect(logged.ok).toBe(false);
    expect(logged.error).toContain("invalid username or password");
  });
});

describe("auth workflow — network and token permissions", () => {
  it("enforces createNetwork quota for free users", () => {
    register("admin_seed", "abcd");
    const r = register("bob", "StrongPw123");
    const uid = r.user!.user_id;

    expect(createNetwork(uid, "net-2").ok).toBe(true);
    const third = createNetwork(uid, "net-3");
    expect(third.ok).toBe(false);
    expect(third.error).toContain("quota exceeded");
  });

  it("blocks duplicate network names for same owner", () => {
    const admin = register("owner", "abcd");
    const uid = admin.user!.user_id;
    expect(createNetwork(uid, "project").ok).toBe(true);
    const dup = createNetwork(uid, "project");
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("network name already exists");
  });

  it("enforces viewer restrictions and allows member network tokens", () => {
    const owner = register("owner", "abcd");
    register("seed2", "StrongPw123");
    const member = register("charlie", "StrongPw123");
    const ownerNet = owner.network_id!;

    expect(addNetworkMember(ownerNet, member.user!.user_id, "viewer", owner.user!.user_id).ok).toBe(true);
    expect(createToken(member.user!.user_id, "viewer-token", ownerNet).error).toContain("viewer cannot create");
    expect(createNetworkTokenForNode(member.user!.user_id, ownerNet, "node-charlie").error).toContain("no write access");

    expect(updateMemberRole(ownerNet, member.user!.user_id, "member").ok).toBe(true);
    const ntok = createNetworkTokenForNode(member.user!.user_id, ownerNet, "node-charlie");
    expect(ntok.ok).toBe(true);
    expect(ntok.token?.startsWith("ntok_")).toBe(true);

    const full = createToken(member.user!.user_id, "full-member", ownerNet);
    expect(full.ok).toBe(true);
    expect(full.token?.startsWith("atok_")).toBe(true);
    expect(resolveToken(full.token!)?.networkId).toBe(ownerNet);
  });

  it("supports token revoke by token id", () => {
    const u = register("owner", "abcd");
    const uid = u.user!.user_id;
    const issued = issueUserToken(uid, "extra-login");
    expect(revokeToken(uid, issued.token_id).ok).toBe(true);
    expect(revokeToken(uid, issued.token_id).ok).toBe(false);
  });
});

describe("auth workflow — network rename/delete guards", () => {
  it("checks ownership, duplicate names, and active sessions for delete", () => {
    const owner = register("owner", "abcd");
    const other = register("other", "StrongPw123");
    const ownerId = owner.user!.user_id;
    const net = createNetwork(ownerId, "project");
    const netId = net.network_id!;

    expect(renameNetwork(other.user!.user_id, netId, "renamed").error).toContain("not your network");
    expect(renameNetwork(ownerId, netId, "renamed").ok).toBe(true);

    const another = createNetwork(ownerId, "another");
    expect(renameNetwork(ownerId, another.network_id!, "renamed").error).toContain("name already taken");
    expect(deleteNetwork(other.user!.user_id, netId).error).toContain("not your network");

    db.run("INSERT INTO sessions (resume_id, alias, network_id) VALUES (?1, ?2, ?3)", ["sess_1", "a1", netId]);
    const blockedDelete = deleteNetwork(ownerId, netId);
    expect(blockedDelete.ok).toBe(false);
    expect(blockedDelete.error).toContain("active session");

    db.run("DELETE FROM sessions WHERE resume_id = ?1", ["sess_1"]);
    expect(deleteNetwork(ownerId, netId).ok).toBe(true);
  });
});

describe("auth workflow — password and admin reset lifecycle", () => {
  it("changePassword validates old/new password and revokes other user tokens", () => {
    register("admin_seed", "abcd");
    const user = register("dana", "StrongPw123");
    const uid = user.user!.user_id;

    const current = issueUserToken(uid, "current-session");
    issueUserToken(uid, "extra-session");
    expect(listTokens(uid).length).toBeGreaterThanOrEqual(3);

    expect(changePassword(uid, "wrong-old", "StrongerPw456", current.token_id).error).toContain("incorrect current password");
    expect(changePassword(uid, "StrongPw123", "password", current.token_id).error).toContain("too common");

    const changed = changePassword(uid, "StrongPw123", "StrongerPw456", current.token_id);
    expect(changed.ok).toBe(true);
    expect((changed.revoked ?? 0) > 0).toBe(true);

    const remaining = db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM api_tokens WHERE user_id = ?1 AND network_id IS NULL",
      uid,
    );
    expect(remaining?.cnt).toBe(1);

    expect(login("dana", "StrongPw123").ok).toBe(false);
    expect(login("dana", "StrongerPw456").ok).toBe(true);
  });

  it("resetUserPassword requires admin flag, rotates credentials, and writes audit log", () => {
    const admin = register("admin_seed", "abcd");
    const target = register("erin", "StrongPw123");
    issueUserToken(target.user!.user_id, "extra-before-reset");

    const denied = resetUserPassword("erin", false);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("hub admin required");

    const reset = resetUserPassword("erin", true);
    expect(reset.ok).toBe(true);
    expect(reset.password?.startsWith("anet-")).toBe(true);
    expect(reset.token?.startsWith("utok_")).toBe(true);

    expect(login("erin", "StrongPw123").ok).toBe(false);
    expect(login("erin", reset.password!).ok).toBe(true);

    const audit = db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM audit_log WHERE action = 'password_reset_by_admin' AND user_id = ?1",
      target.user!.user_id,
    );
    expect((audit?.cnt || 0) > 0).toBe(true);

    expect(revokeOtherUserTokens(admin.user!.user_id)).toBeGreaterThanOrEqual(1);
  });
});

describe("auth workflow — invite and member management", () => {
  it("covers invite role validation, usage limits, and expiry", () => {
    const owner = register("owner", "abcd");
    register("seed2", "StrongPw123");
    const invitee = register("frank", "StrongPw123");
    const invitee2 = register("grace", "StrongPw123");
    const netId = owner.network_id!;

    expect(createInvite(netId, owner.user!.user_id, "bad-role").ok).toBe(false);
    expect(joinByInvite("inv_not_found", invitee.user!.user_id).error).toContain("invalid invite code");

    const oneUse = createInvite(netId, owner.user!.user_id, "viewer", 1);
    expect(oneUse.ok).toBe(true);
    const firstJoin = joinByInvite(oneUse.invite_code!, invitee.user!.user_id);
    expect(firstJoin.ok).toBe(true);
    expect(firstJoin.network_id).toBe(netId);
    expect(firstJoin.role).toBe("viewer");
    expect(joinByInvite(oneUse.invite_code!, invitee2.user!.user_id).error).toContain("fully used");

    const expired = createInvite(netId, owner.user!.user_id, "member", 2);
    db.run("UPDATE network_invites SET expires_at = '2000-01-01 00:00:00' WHERE invite_code = ?1", [expired.invite_code!]);
    expect(joinByInvite(expired.invite_code!, invitee2.user!.user_id).error).toContain("expired");
  });

  it("covers member add/update/remove edge cases", () => {
    const owner = register("owner", "abcd");
    register("seed2", "StrongPw123");
    const member = register("hank", "StrongPw123");
    const netId = owner.network_id!;

    expect(addNetworkMember(netId, member.user!.user_id, "member", owner.user!.user_id).ok).toBe(true);
    expect(addNetworkMember(netId, member.user!.user_id, "member", owner.user!.user_id).error).toContain("already a member");
    expect(updateMemberRole(netId, member.user!.user_id, "owner").error).toContain("cannot assign owner role");
    expect(updateMemberRole(netId, member.user!.user_id, "viewer").ok).toBe(true);
    expect(removeNetworkMember(netId, owner.user!.user_id).error).toContain("cannot remove owner");
    expect(removeNetworkMember(netId, "u_not_member").error).toContain("not a member");
    expect(removeNetworkMember(netId, member.user!.user_id).ok).toBe(true);
  });
});
