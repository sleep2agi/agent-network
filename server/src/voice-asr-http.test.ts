import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-voice-asr-http-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");
process.env.ANET_HUB_SECRET_VAULT_KEY = "cd".repeat(32);
process.env.ANET_VOICE_ALLOW_LOOPBACK_ENDPOINT = "1";

let hubServer: ReturnType<typeof Bun.serve>;
let mockAsrServer: ReturnType<typeof Bun.serve>;
let base = "";
let mockAsrUrl = "";

let globalAdminToken = "";
let globalAdminNetworkId = "";
let ownerToken = "";
let ownerNetworkId = "";
let memberToken = "";
let outsiderToken = "";
let outsiderNetworkId = "";
let nodeToken = "";

let mockMode: "ok" | "silence" | "auth401" | "rate429" = "ok";
let lastUpstreamHeaders: Record<string, string> = {};

const SAMPLE_WAV_B64 = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ").toString("base64");

beforeAll(async () => {
  mockAsrServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      lastUpstreamHeaders = {};
      req.headers.forEach((v, k) => { lastUpstreamHeaders[k.toLowerCase()] = v; });
      if (mockMode === "auth401") {
        return Response.json({ message: "bad volc key raw detail" }, { status: 401 });
      }
      if (mockMode === "rate429") {
        return Response.json({ message: "too many requests" }, { status: 429 });
      }
      if (mockMode === "silence") {
        return Response.json({ result: { text: "" } }, {
          status: 200,
          headers: { "X-Api-Status-Code": "20000003" },
        });
      }
      return Response.json({ result: { text: "你好，这是 Hub 代理识别结果" } }, {
        status: 200,
        headers: { "X-Api-Status-Code": "20000000" },
      });
    },
  });
  mockAsrUrl = `http://127.0.0.1:${mockAsrServer.port}/flash`;

  const { db } = await import("./db.js");
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  const suffix = Date.now();

  // First user becomes global admin; create a second non-global owner + member + outsider
  // so RBAC tests verify network-level owner/member boundaries rather than global-admin bypass.
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
  try { mockAsrServer?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("Hub /api/voice/* HTTP endpoints (#5653)", () => {
  test("rejects unauthenticated callers (401) and node tokens (403)", async () => {
    const r401 = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`);
    expect(r401.status).toBe(401);

    const rNodeGet = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });
    expect(rNodeGet.status).toBe(403);

    const rNodeRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(rNodeRec.status).toBe(403);
  });

  test("owner configures key once, member reads & recognizes zero-config, outsider is isolated", async () => {
    const apiKey = "volc-http-secret-key-8899";

    // Unconfigured initially
    const initial = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: false,
      configured: false,
      can_manage: true,
      vault_ready: true,
    });

    // Member cannot write
    const memberPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, api_key: apiKey, endpoint: mockAsrUrl }),
    });
    expect(memberPut.status).toBe(403);

    // Owner writes encrypted config
    const ownerPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, api_key: apiKey, endpoint: mockAsrUrl }),
    });
    expect(ownerPut.status).toBe(200);
    const putBody = await ownerPut.json() as any;
    expect(putBody).toMatchObject({
      ok: true,
      network_id: ownerNetworkId,
      enabled: true,
      configured: true,
      mode: "hub-proxy",
      provider: "doubao",
      auth_mode: "api-key",
      key_hint: "…8899",
      endpoint: mockAsrUrl,
      can_manage: true,
    });
    expect(JSON.stringify(putBody)).not.toContain(apiKey);

    // Isolated from /api/secrets catalog
    const secretsRes = await fetch(`${base}/api/secrets?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(secretsRes.status).toBe(200);
    expect((await secretsRes.json() as any).keys).toEqual([]);

    // Plain member reads config (never sees secret, can_manage=false)
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
      can_manage: false,
      key_hint: "…8899",
    });
    expect(JSON.stringify(memberGetBody)).not.toContain(apiKey);

    // Plain member recognizes audio without ever possessing the API key
    mockMode = "ok";
    const memberRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(memberRec.status).toBe(200);
    expect(await memberRec.json()).toEqual({ ok: true, text: "你好，这是 Hub 代理识别结果" });
    expect(lastUpstreamHeaders["x-api-key"]).toBe(apiKey);
    expect(lastUpstreamHeaders["x-api-resource-id"]).toBe("volc.bigasr.auc_turbo");

    // Outsider cannot read, modify, or use owner's network voice config
    const outGet = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outGet.status).toBe(403);
    const outRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${outsiderToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(outRec.status).toBe(403);

    // Outsider's own network stays unconfigured
    const outOwn = await fetch(`${base}/api/voice/recognize?network_id=${outsiderNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${outsiderToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(outOwn.status).toBe(409);
    expect(await outOwn.json()).toMatchObject({ ok: false, code: "not_configured" });
  });

  test("upstream silence / 401->502 / 429 / oversize / toggle / app-token / delete lifecycle", async () => {
    // Silence returns 200 empty text
    mockMode = "silence";
    const silenceRes = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(silenceRes.status).toBe(200);
    expect(await silenceRes.json()).toEqual({ ok: true, text: "" });

    // Upstream Volcengine 401 NEVER returns HTTP 401 (returns 502 auth_failed)
    mockMode = "auth401";
    const authFailRes = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(authFailRes.status).toBe(502);
    const authFailBody = await authFailRes.json() as any;
    expect(authFailBody).toMatchObject({ ok: false, code: "auth_failed", upstream: "401" });
    expect(JSON.stringify(authFailBody)).not.toContain("bad volc key raw detail");

    // Upstream 429
    mockMode = "rate429";
    const rateRes = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(rateRes.status).toBe(429);
    expect(await rateRes.json()).toMatchObject({ ok: false, code: "rate_limited", upstream: "429" });

    // Oversize rejected with 413
    const hugeBody = JSON.stringify({ wav_base64: "A".repeat(4 * 1024 * 1024 + 16) });
    const hugeRes = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: hugeBody,
    });
    expect(hugeRes.status).toBe(413);
    expect(await hugeRes.json()).toMatchObject({ ok: false, code: "too_long" });

    // Owner toggles disabled without re-sending secret
    const disableRes = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    expect(await disableRes.json()).toMatchObject({ ok: true, enabled: false, configured: true });

    const disabledRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(disabledRec.status).toBe(409);

    // Owner switches to legacy app-token mode
    mockMode = "ok";
    const appTokPut = await fetch(`${base}/api/voice/config?network_id=${ownerNetworkId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        auth_mode: "app-token",
        app_id: "app-5653",
        access_token: "access-token-5653",
        endpoint: mockAsrUrl,
      }),
    });
    expect(appTokPut.status).toBe(200);
    expect(await appTokPut.json()).toMatchObject({ ok: true, auth_mode: "app-token", app_id: "app-5653", key_hint: "…5653" });

    const appTokRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(appTokRec.status).toBe(200);
    expect(lastUpstreamHeaders["x-api-app-key"]).toBe("app-5653");
    expect(lastUpstreamHeaders["x-api-access-key"]).toBe("access-token-5653");

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

    const afterDelRec = await fetch(`${base}/api/voice/recognize?network_id=${ownerNetworkId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: SAMPLE_WAV_B64 }),
    });
    expect(afterDelRec.status).toBe(409);

    // Single-network global Hub admin works even when ?network_id is omitted
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
