import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "anet-voice-asr-unit-"));
process.env.COMMHUB_DB ||= join(TEST_DIR, "hub.db");

import { db } from "./db.js";
import { _resetVaultKeyForTest, vaultListKeys } from "./vault.js";
import {
  VOICE_WRITE_ERROR_CODES,
  VOICE_WRITE_STATUS,
  deleteNetworkVoiceConfig,
  maskVoiceSecretTail,
  readNetworkVoiceConfig,
  readNetworkVoiceCredentials,
  saveNetworkVoiceConfig,
  validateVoiceEndpoint,
  validateVoiceStreamEndpoint,
  voiceWriteStatus,
} from "./voice-asr.js";

const VALID_KEY = "ab".repeat(32);
const NET_A = "net_voice_unit_a";
const NET_B = "net_voice_unit_b";

beforeEach(() => {
  process.env.ANET_HUB_SECRET_VAULT_KEY = VALID_KEY;
  _resetVaultKeyForTest();
  db.run("DELETE FROM network_voice_configs WHERE network_id IN (?1, ?2)", [NET_A, NET_B]);
  db.run("DELETE FROM audit_log WHERE target_id IN (?1, ?2)", [NET_A, NET_B]);
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe("voice-asr pure validators", () => {
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

  test("validateVoiceEndpoint and validateVoiceStreamEndpoint enforce https/wss and reject userinfo", () => {
    expect(validateVoiceEndpoint("")).toEqual({ ok: true, url: "" });
    expect(validateVoiceEndpoint("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")).toEqual({
      ok: true,
      url: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    });
    expect(validateVoiceEndpoint("http://127.0.0.1:9999/flash")).toEqual({
      ok: true,
      url: "http://127.0.0.1:9999/flash",
    });
    expect(validateVoiceEndpoint("http://openspeech.bytedance.com/flash").ok).toBe(false);
    expect(validateVoiceEndpoint("https://user:pass@openspeech.bytedance.com/flash").ok).toBe(false);

    expect(validateVoiceStreamEndpoint("")).toEqual({ ok: true, url: "" });
    expect(validateVoiceStreamEndpoint("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")).toEqual({
      ok: true,
      url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    });
    expect(validateVoiceStreamEndpoint("ws://127.0.0.1:9999/sauc")).toEqual({
      ok: true,
      url: "ws://127.0.0.1:9999/sauc",
    });
    expect(validateVoiceStreamEndpoint("ws://openspeech.bytedance.com/sauc").ok).toBe(false);
    expect(validateVoiceStreamEndpoint("wss://u:p@openspeech.bytedance.com/sauc").ok).toBe(false);
  });
});

describe("voice-asr encrypted storage & member key distribution", () => {
  test("saves encrypted secret isolated from network_secrets, hides plaintext in config/DB/audit, and issues credentials when enabled", () => {
    const secret = "volc-super-secret-apikey-7788";
    const saved = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", {
      enabled: true,
      auth_mode: "api-key",
      api_key: secret,
      stream_resource_id: "volc.seedasr.sauc.duration",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unreachable");
    expect(saved).toMatchObject({
      ok: true,
      network_id: NET_A,
      enabled: true,
      configured: true,
      mode: "hub-key",
      provider: "doubao",
      auth_mode: "api-key",
      app_id: "",
      key_hint: "…7788",
      endpoint: "",
      stream_endpoint: "",
      stream_resource_id: "volc.seedasr.sauc.duration",
      can_manage: true,
      vault_ready: true,
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(vaultListKeys(NET_A)).toEqual([]);

    // Raw DB row stores ciphertext, never plaintext
    const rawRow = db.get<any>("SELECT * FROM network_voice_configs WHERE network_id = ?1", NET_A);
    expect(JSON.stringify(rawRow)).not.toContain(secret);

    // Audit row never contains plaintext
    const auditRows = db.all<any>("SELECT * FROM audit_log WHERE target_id = ?1", NET_A);
    expect(auditRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows)).not.toContain(secret);

    // Credentials distribution returns exact decrypted credentials for direct Doubao calls
    const issued = readNetworkVoiceCredentials(NET_A);
    expect(issued).toMatchObject({
      ok: true,
      status: 200,
      network_id: NET_A,
      enabled: true,
      configured: true,
      mode: "hub-key",
      provider: "doubao",
      credentials: {
        provider: "doubao",
        auth_mode: "api-key",
        app_id: "",
        access_token: secret,
        endpoint: "",
        stream_endpoint: "",
        stream_resource_id: "volc.seedasr.sauc.duration",
      },
    });

    // Partial update (toggle enabled off then on) preserves ciphertext without re-entering key
    const disabled = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { enabled: false });
    expect(disabled).toMatchObject({ ok: true, enabled: false, configured: true, key_hint: "…7788" });

    const blocked = readNetworkVoiceCredentials(NET_A);
    expect(blocked).toMatchObject({ ok: false, status: 409, error: "voice_not_configured" });

    const reenabled = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { enabled: true });
    expect(reenabled).toMatchObject({ ok: true, enabled: true, configured: true, key_hint: "…7788" });
    expect(readNetworkVoiceCredentials(NET_A)).toMatchObject({ ok: true, credentials: { access_token: secret } });

    // Switching auth_mode requires a fresh secret
    const badSwitch = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { auth_mode: "app-token", app_id: "123456" });
    expect(badSwitch).toMatchObject({ ok: false, error: "credential_required" });

    // Invalid stream resource ID rejected
    const badRid = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { stream_resource_id: "volc.unknown.id" });
    expect(badRid).toMatchObject({ ok: false, error: "invalid_stream_resource_id" });

    // Another network stays completely unconfigured
    expect(readNetworkVoiceConfig(NET_B, false)).toMatchObject({
      ok: true,
      network_id: NET_B,
      enabled: false,
      configured: false,
      can_manage: false,
    });
    expect(readNetworkVoiceCredentials(NET_B)).toMatchObject({ ok: false, status: 409, error: "voice_not_configured" });

    // Delete clears credentials cleanly
    const deleted = deleteNetworkVoiceConfig(NET_A, "u_owner", "owner");
    expect(deleted).toMatchObject({ ok: true, enabled: false, configured: false, key_hint: "" });
    expect(readNetworkVoiceCredentials(NET_A)).toMatchObject({ ok: false, status: 409, error: "voice_not_configured" });
  });

  test("app-token mode stores and distributes App ID + Access Token + custom endpoints", () => {
    const token = "old-console-access-token-4321";
    const saved = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", {
      enabled: true,
      auth_mode: "app-token",
      app_id: "987654321",
      access_token: token,
      endpoint: "https://asr.example/flash",
      stream_endpoint: "wss://asr.example/sauc",
    });
    expect(saved).toMatchObject({
      ok: true,
      auth_mode: "app-token",
      app_id: "987654321",
      key_hint: "…4321",
      endpoint: "https://asr.example/flash",
      stream_endpoint: "wss://asr.example/sauc",
    });
    expect(JSON.stringify(saved)).not.toContain(token);

    const issued = readNetworkVoiceCredentials(NET_A);
    expect(issued).toMatchObject({
      ok: true,
      credentials: {
        auth_mode: "app-token",
        app_id: "987654321",
        access_token: token,
        endpoint: "https://asr.example/flash",
        stream_endpoint: "wss://asr.example/sauc",
      },
    });
  });

  test("missing vault master key returns 503 vault_master_key_missing cleanly", () => {
    delete process.env.ANET_HUB_SECRET_VAULT_KEY;
    _resetVaultKeyForTest();
    const res = saveNetworkVoiceConfig(NET_A, "u_owner", "owner", { api_key: "sk-test-12345678" });
    expect(res).toMatchObject({ ok: false, error: "vault_master_key_missing" });
    if (!res.ok) expect(voiceWriteStatus(res.error)).toBe(503);
  });
});
