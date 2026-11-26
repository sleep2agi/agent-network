import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "anet-voice-asr-unit-"));
process.env.COMMHUB_DB ||= join(TEST_DIR, "hub.db");

import { db } from "./db.js";
import { _resetVaultKeyForTest, vaultListKeys } from "./vault.js";
import {
  DOUBAO_DEFAULT_ENDPOINT,
  DOUBAO_FLASH_RESOURCE_ID,
  MAX_WAV_BYTES,
  VOICE_WRITE_ERROR_CODES,
  VOICE_WRITE_STATUS,
  deleteNetworkVoiceConfig,
  interpretDoubaoFlashResponse,
  maskVoiceSecretTail,
  readNetworkVoiceConfig,
  recognizeNetworkVoice,
  saveNetworkVoiceConfig,
  validateVoiceEndpoint,
  validateWavBase64,
  voiceWriteStatus,
  type VoiceFetchLike,
} from "./voice-asr.js";

const VALID_KEY = "ab".repeat(32);
const NET_A = "net_voice_unit_a";
const NET_B = "net_voice_unit_b";
const SAMPLE_WAV_B64 = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ").toString("base64");

beforeEach(() => {
  process.env.ANET_HUB_SECRET_VAULT_KEY = VALID_KEY;
  _resetVaultKeyForTest();
  db.run("DELETE FROM network_voice_configs WHERE network_id IN (?1, ?2)", [NET_A, NET_B]);
  db.run("DELETE FROM audit_log WHERE target_id IN (?1, ?2)", [NET_A, NET_B]);
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe("voice-asr pure validators & mappers", () => {
  test("VOICE_WRITE_STATUS covers every VoiceWriteErrorCode exhaustively", () => {
    expect(Object.keys(VOICE_WRITE_STATUS).sort()).toEqual([...VOICE_WRITE_ERROR_CODES].sort());
    for (const code of VOICE_WRITE_ERROR_CODES) {
      expect(voiceWriteStatus(code)).toBeGreaterThanOrEqual(400);
    }
  });

  test("maskVoiceSecretTail hides short secrets and exposes only last 4 chars for >=8", () => {
    expect(maskVoiceSecretTail("")).toBe("");
    expect(maskVoiceSecretTail("1234567")).toBe("…");
    expect(maskVoiceSecretTail("12345678")).toBe("…5678");
    expect(maskVoiceSecretTail("  sk-doubao-secret-9988  ")).toBe("…9988");
  });

  test("validateVoiceEndpoint enforces https and blocks SSRF/metadata/userinfo", () => {
    expect(validateVoiceEndpoint("")).toEqual({ ok: true, url: "" });
    expect(validateVoiceEndpoint("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")).toEqual({
      ok: true,
      url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    });
    expect(validateVoiceEndpoint("http://openspeech.bytedance.com/flash").ok).toBe(false);
    expect(validateVoiceEndpoint("https://user:pass@openspeech.bytedance.com/flash").ok).toBe(false);
    expect(validateVoiceEndpoint("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateVoiceEndpoint("https://metadata.google.internal/computeMetadata").ok).toBe(false);
    expect(validateVoiceEndpoint("http://127.0.0.1:9999/flash", { allowLoopback: false }).ok).toBe(false);
    expect(validateVoiceEndpoint("https://localhost:9999/flash", { allowLoopback: false }).ok).toBe(false);
    expect(validateVoiceEndpoint("http://127.0.0.1:9999/flash", { allowLoopback: true })).toEqual({
      ok: true,
      url: "http://127.0.0.1:9999/flash",
    });
  });

  test("validateWavBase64 rejects empty, malformed, and oversized payloads", () => {
    expect(validateWavBase64(null)).toMatchObject({ ok: false, code: "bad_audio" });
    expect(validateWavBase64("")).toMatchObject({ ok: false, code: "bad_audio" });
    expect(validateWavBase64("not@valid!base64")).toMatchObject({ ok: false, code: "bad_audio" });
    const ok = validateWavBase64(SAMPLE_WAV_B64);
    expect(ok).toMatchObject({ ok: true, byteLength: 16 });
    const huge = Buffer.alloc(MAX_WAV_BYTES + 1, 1).toString("base64");
    expect(validateWavBase64(huge)).toMatchObject({ ok: false, status: 413, code: "too_long" });
  });

  test("interpretDoubaoFlashResponse maps status codes cleanly", () => {
    expect(interpretDoubaoFlashResponse(200, "20000000", { result: { text: "  你好  " } })).toEqual({ text: "你好" });
    expect(interpretDoubaoFlashResponse(200, "20000003", {})).toEqual({ text: "" });
    expect(interpretDoubaoFlashResponse(200, "45000002", {})).toEqual({ text: "" });
    expect(interpretDoubaoFlashResponse(401, null, { message: "secret leak" })).toEqual({ error: "auth_failed", upstream: "401" });
    expect(interpretDoubaoFlashResponse(403, null, {})).toEqual({ error: "not_enabled", upstream: "403" });
    expect(interpretDoubaoFlashResponse(429, null, {})).toEqual({ error: "rate_limited", upstream: "429" });
    expect(interpretDoubaoFlashResponse(200, "55000031", {})).toEqual({ error: "rate_limited", upstream: "55000031" });
    expect(interpretDoubaoFlashResponse(200, "45000151", {})).toEqual({ error: "bad_audio", upstream: "45000151" });
    expect(interpretDoubaoFlashResponse(200, "20000000", {})).toEqual({ error: "upstream_error", upstream: "no_text" });
    expect(interpretDoubaoFlashResponse(500, "not-digits", {})).toEqual({ error: "upstream_error", upstream: "500" });
  });
});

describe("voice-asr encrypted storage & proxy", () => {
  test("saves encrypted secret isolated from network_secrets and never leaks plaintext", async () => {
    const secret = "volc-super-secret-apikey-7788";
    const saved = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", {
      enabled: true,
      auth_mode: "api-key",
      api_key: secret,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unreachable");
    expect(saved).toMatchObject({
      ok: true,
      network_id: NET_A,
      enabled: true,
      configured: true,
      mode: "hub-proxy",
      provider: "doubao",
      auth_mode: "api-key",
      app_id: "",
      key_hint: "…7788",
      endpoint: "",
      can_manage: true,
      vault_ready: true,
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(vaultListKeys(NET_A)).toEqual([]);

    // Raw DB row stores ciphertext, not plaintext
    const rawRow = db.get<any>("SELECT * FROM network_voice_configs WHERE network_id = ?1", NET_A);
    expect(JSON.stringify(rawRow)).not.toContain(secret);

    // Audit row never contains plaintext
    const auditRows = db.all<any>("SELECT * FROM audit_log WHERE target_id = ?1", NET_A);
    expect(auditRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows)).not.toContain(secret);

    // Partial update (toggle enabled off then on) without re-sending secret preserves ciphertext
    const disabled = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { enabled: false });
    expect(disabled).toMatchObject({ ok: true, enabled: false, configured: true, key_hint: "…7788" });

    const blocked = await recognizeNetworkVoice(NET_A, SAMPLE_WAV_B64);
    expect(blocked).toMatchObject({ ok: false, status: 409, code: "not_configured" });

    const reenabled = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { enabled: true });
    expect(reenabled).toMatchObject({ ok: true, enabled: true, configured: true, key_hint: "…7788" });

    // Switching auth_mode requires a fresh secret
    const badSwitch = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { auth_mode: "app-token", app_id: "123456" });
    expect(badSwitch).toMatchObject({ ok: false, error: "credential_required" });

    // Mocked recognition forwards X-Api-Key
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const mockFetch: VoiceFetchLike = async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return {
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === "x-api-status-code" ? "20000000" : null) },
        json: async () => ({ result: { text: "测试通过" } }),
      };
    };
    const rec = await recognizeNetworkVoice(NET_A, SAMPLE_WAV_B64, { fetchImpl: mockFetch, requestId: "req-1" });
    expect(rec).toEqual({ ok: true, status: 200, text: "测试通过" });
    expect(seenUrl).toBe(DOUBAO_DEFAULT_ENDPOINT);
    expect(seenHeaders["X-Api-Key"]).toBe(secret);
    expect(seenHeaders["X-Api-Resource-Id"]).toBe(DOUBAO_FLASH_RESOURCE_ID);
    expect(seenHeaders["X-Api-Request-Id"]).toBe("req-1");
    expect(seenHeaders["X-Api-App-Key"]).toBeUndefined();

    // Another network stays completely unconfigured
    expect(readNetworkVoiceConfig(NET_B, false)).toMatchObject({
      ok: true,
      network_id: NET_B,
      enabled: false,
      configured: false,
      can_manage: false,
    });

    // Delete clears credentials cleanly
    const deleted = deleteNetworkVoiceConfig(NET_A, "u_owner", "owner");
    expect(deleted).toMatchObject({ ok: true, enabled: false, configured: false, key_hint: "" });
  });

  test("app-token mode forwards X-Api-App-Key + X-Api-Access-Key and upstream 401 maps to HTTP 502", async () => {
    const token = "old-console-access-token-4321";
    const saved = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", {
      enabled: true,
      auth_mode: "app-token",
      app_id: "987654321",
      access_token: token,
    });
    expect(saved).toMatchObject({ ok: true, auth_mode: "app-token", app_id: "987654321", key_hint: "…4321" });

    let seenHeaders: Record<string, string> = {};
    const authFailFetch: VoiceFetchLike = async (_url, init) => {
      seenHeaders = init.headers;
      return {
        status: 401,
        headers: { get: () => null },
        json: async () => ({ message: "should never leak" }),
      };
    };
    const res = await recognizeNetworkVoice(NET_A, SAMPLE_WAV_B64, { fetchImpl: authFailFetch });
    expect(seenHeaders["X-Api-App-Key"]).toBe("987654321");
    expect(seenHeaders["X-Api-Access-Key"]).toBe(token);
    expect(seenHeaders["X-Api-Key"]).toBeUndefined();
    expect(res).toEqual({ ok: false, status: 502, code: "auth_failed", error: "auth_failed", upstream: "401" });
    expect(JSON.stringify(res)).not.toContain("should never leak");
    expect(JSON.stringify(res)).not.toContain(token);
  });

  test("missing vault master key returns 503 vault_master_key_missing cleanly", () => {
    delete process.env.ANET_HUB_SECRET_VAULT_KEY;
    _resetVaultKeyForTest();
    const res = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { api_key: "sk-test-12345678" });
    expect(res).toMatchObject({ ok: false, error: "vault_master_key_missing" });
    if (!res.ok) expect(voiceWriteStatus(res.error)).toBe(503);
  });

  test("timeout returns 504 timeout and network throw returns 502 network", async () => {
    saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { api_key: "sk-test-timeout-9999" });
    const hangFetch: VoiceFetchLike = (_u, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const tOut = await recognizeNetworkVoice(NET_A, SAMPLE_WAV_B64, { fetchImpl: hangFetch, timeoutMs: 25 });
    expect(tOut).toMatchObject({ ok: false, status: 504, code: "timeout" });

    const netErrFetch: VoiceFetchLike = async () => { throw new Error("ECONNREFUSED https://secret-host"); };
    const netOut = await recognizeNetworkVoice(NET_A, SAMPLE_WAV_B64, { fetchImpl: netErrFetch });
    expect(netOut).toEqual({ ok: false, status: 502, code: "network", error: "upstream_network_error" });
    expect(JSON.stringify(netOut)).not.toContain("secret-host");
  });
});
