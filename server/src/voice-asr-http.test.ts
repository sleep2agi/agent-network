import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-voice-asr-http-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");
process.env.ANET_HUB_SECRET_VAULT_KEY = "cd".repeat(32);

let hubServer: ReturnType<typeof Bun.serve>;
let base = "";

let globalAdminToken = "";
let globalAdminNetworkId = "";
let ownerToken = "";
let ownerNetworkId = "";
let memberToken = "";
let outsiderToken = "";
let outsiderNetworkId = "";
let nodeToken = "";

beforeAll(async () => {
  const { db } = await import("./db.js");
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  const suffix = Date.now();

  const first = register(`voice_boot_${suffix}`, "VoiceBoot-Strong-1!", undefined, "boot");
  expect(first.ok).toBe(true);
  globalAdminToken = first.token!;
  globalAdminNetworkId = first.network_id!;

  const owner = register(`voice_owner_${suffix}`, "VoiceOwner-Strong-1!", undefined, "owner");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  ownerNetworkId = owner.network_id!;

  const member = register(`voice_member_${suffix}`, "VoiceMember-Strong-1!", undefined, "member");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  const memberUserId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1",
    `voice_member_${suffix}`,
  )!.user_id;
  addNetworkMember(ownerNetworkId, memberUserId, "member");

  const outsider = register(`voice_outsider_${suffix}`, "VoiceOutsider-Strong-1!", undefined, "outsider");
  expect(outsider.ok).toBe(true);
  outsiderToken = outsider.token!;
  outsiderNetworkId = outsider.network_id!;

  const ownerUserId = db.get<{ user_id: string }>(
    "SELECT user_id FROM users WHERE username = ?1",
    `voice_owner_${suffix}`,
  )!.user_id;
  const minted = createNetworkTokenForNode(ownerUserId, ownerNetworkId, "voice-test-node");
  expect(minted.ok).toBe(true);
  nodeToken = minted.token!;

  const mod = await import("./server.js");
  hubServer = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hubServer.port}`;
}, 30_000);

afterAll(() => {
  try { hubServer?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("Hub /api/voice/* key distribution HTTP endpoints (#5653)", () => {
  test("rejects unauthenticated callers (401) and node tokens (403)", async () => {
    const r401 = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`);
    expect(r401.status).toBe(401);

    const rCreds401 = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`);
    expect(rCreds401.status).toBe(401);

    const rNodeGet = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(rNodeGet.status).toBe(403);

    const rNodeCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(rNodeCreds.status).toBe(403);
  });

  test("owner saves key once, member receives key via /api/voice/credentials, outsider is isolated", async () => {
    const apiKey = "volc-http-secret-key-8899";

    const initial = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: false,
      configured: false,
      mode: "hub-key",
      can_manage: true,
      vault_ready: true,
    });

    // Member cannot write
    const memberPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, api_key: apiKey }),
    });
    expect(memberPut.status).toBe(403);

    // Owner writes encrypted config
    const ownerPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        api_key: apiKey,
        stream_resource_id: "volc.bigasr.sauc.duration",
      }),
    });
    expect(ownerPut.status).toBe(200);
    const putBody = await ownerPut.json() as any;
    expect(putBody).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: true,
      configured: true,
      mode: "hub-key",
      provider: "doubao",
      auth_mode: "api-key",
      key_hint: "…8899",
      stream_resource_id: "volc.bigasr.sauc.duration",
      can_manage: true,
    });
    expect(JSON.stringify(putBody)).not.toContain(apiKey);

    // Isolated from /api/secrets catalog
    const secretsRes = await fetch(`${base}/api/secrets?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(secretsRes.status).toBe(200);
    expect((await secretsRes.json() as any).keys).toEqual([]);

    // Plain member reads non-secret config (no plaintext in /api/voice/config)
    const memberGet = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberGet.status).toBe(200);
    const memberGetBody = await memberGet.json() as any;
    expect(memberGetBody).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: true,
      configured: true,
      mode: "hub-key",
      can_manage: false,
      key_hint: "…8899",
    });
    expect(JSON.stringify(memberGetBody)).not.toContain(apiKey);

    // Plain member fetches credentials via /api/voice/credentials (no-store)
    const memberCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberCreds.status).toBe(200);
    expect(memberCreds.headers.get("cache-control")).toBe("no-store");
    expect(await memberCreds.json()).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: true,
      configured: true,
      mode: "hub-key",
      provider: "doubao",
      credentials: {
        auth_mode: "api-key",
        app_id: "",
        access_token: apiKey,
        endpoint: "",
        stream_endpoint: "",
        stream_resource_id: "volc.bigasr.sauc.duration",
      },
    });

    // Outsider cannot read config or fetch credentials of owner's network
    const outGet = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outGet.status).toBe(403);
    const outCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outCreds.status).toBe(403);

    // Outsider's own network stays unconfigured
    const outOwn = await fetch(`${base}/api/voice/credentials?network_id=${outsiderNetworkId}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outOwn.status).toBe(409);
  });

  test("toggle disabled revokes issuance, app-token mode & delete work, single-network global admin resolves", async () => {
    // Owner toggles disabled without re-sending key
    const disableRes = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    expect(await disableRes.json()).toMatchObject({ ok: true, enabled: false, configured: true });

    const disabledCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(disabledCreds.status).toBe(409);

    // Owner switches to legacy app-token mode
    const appTokPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        auth_mode: "app-token",
        app_id: "app-5653",
        access_token: "access-token-5653",
        endpoint: "https://asr.example/flash",
        stream_endpoint: "wss://asr.example/sauc",
      }),
    });
    expect(appTokPut.status).toBe(200);
    expect(await appTokPut.json()).toMatchObject({
      ok: true,
      auth_mode: "app-token",
      app_id: "app-5653",
      key_hint: "…5653",
      endpoint: "https://asr.example/flash",
      stream_endpoint: "wss://asr.example/sauc",
    });

    const appTokCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(appTokCreds.status).toBe(200);
    expect(await appTokCreds.json()).toMatchObject({
      ok: true,
      credentials: {
        auth_mode: "app-token",
        app_id: "app-5653",
        access_token: "access-token-5653",
        endpoint: "https://asr.example/flash",
        stream_endpoint: "wss://asr.example/sauc",
      },
    });

    // Member cannot DELETE; owner can DELETE
    const memberDel = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(memberDel.status).toBe(403);

    const ownerDel = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerDel.status).toBe(200);
    expect(await ownerDel.json()).toMatchObject({ ok: true, enabled: false, configured: false, key_hint: "" });

    const afterDelCreds = await fetch(`${base}/api/voice/credentials?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(afterDelCreds.status).toBe(409);

    // Single-network global Hub admin resolves without ?network_id
    const adminNoParam = await fetch(`${base}/api/voice/config`, {
      headers: { Authorization: `Bearer ${globalAdminToken}` },
    });
    expect(adminNoParam.status).toBe(200);
    expect(await adminNoParam.json()).toMatchObject({
      ok: true,
      network_id: globalAdminNetworkId,
      can_manage: true,
    });
  });
});
