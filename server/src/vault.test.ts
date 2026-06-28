// RFC-028 P1 §4.1 vault layer tests. F2 lazy gate is the critical
// invariant — existing prod hub升级 without ANET_HUB_SECRET_VAULT_KEY
// must NOT boot-fail. Every test runs with deterministic key isolation.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  encryptSecret, decryptSecret,
  vaultUpsert, vaultGet, vaultListKeys, vaultDelete,
  vaultStatusForBoot, vaultMasterKeyFingerprint,
  _resetVaultKeyForTest, VaultError,
} from "./vault.js";
import { db } from "./db.js";

const TEST_KEY_HEX = "0123456789abcdef".repeat(4);   // 32 bytes hex = 64 chars

function setKey(hex: string | undefined): void {
  if (hex === undefined) delete process.env.ANET_HUB_SECRET_VAULT_KEY;
  else process.env.ANET_HUB_SECRET_VAULT_KEY = hex;
  _resetVaultKeyForTest();
}

beforeEach(() => {
  db.run("DELETE FROM network_secrets");
  db.run("DELETE FROM provider_models");
  db.run("DELETE FROM providers");
});
afterAll(() => { _resetVaultKeyForTest(); delete process.env.ANET_HUB_SECRET_VAULT_KEY; });

describe("RFC-028 P1 §4.1 F2 — LAZY GATE (critical: don't brick prod hub)", () => {
  test("hub boot WITHOUT env + WITHOUT vault data → vaultStatusForBoot says configured=false, needsKeyToOp=false (boots OK)", () => {
    setKey(undefined);
    const s = vaultStatusForBoot();
    expect(s.configured).toBe(false);
    expect(s.tablesHaveData).toBe(false);
    expect(s.needsKeyToOp).toBe(false);
    // Crucially: no throw, no crash, hub keeps running.
  });

  test("hub boot WITH env + WITHOUT vault data → configured=true, tablesEmpty (no fingerprint needed)", () => {
    setKey(TEST_KEY_HEX);
    const s = vaultStatusForBoot();
    expect(s.configured).toBe(true);
    expect(s.tablesHaveData).toBe(false);
    expect(s.needsKeyToOp).toBe(false);
  });

  test("hub WITHOUT env + WITH vault data → needsKeyToOp=true (banner warning, NO throw)", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_test", "TEST_KEY", "plaintext-value");
    setKey(undefined);
    const s = vaultStatusForBoot();
    expect(s.configured).toBe(false);
    expect(s.tablesHaveData).toBe(true);
    expect(s.needsKeyToOp).toBe(true);
    // Still no throw — banner is informational; throw only happens on
    // actual vault op (test below).
  });

  test("vault op WITHOUT env throws vault_master_key_missing (lazy throw, not boot throw)", () => {
    setKey(undefined);
    expect(() => vaultUpsert("net_test", "K", "v")).toThrow(VaultError);
    try { vaultUpsert("net_test", "K", "v"); }
    catch (e: any) { expect(e.code).toBe("vault_master_key_missing"); }
  });

  test("vault op WITH invalid env (not 32 bytes hex) throws vault_master_key_invalid", () => {
    setKey("not-hex");
    expect(() => vaultUpsert("net_test", "K", "v")).toThrow(/vault_master_key_invalid/);
    setKey("aabbcc");  // too short
    expect(() => vaultUpsert("net_test", "K", "v")).toThrow(/vault_master_key_invalid/);
  });
});

describe("RFC-028 P1 §4.1 — AES-GCM encrypt/decrypt round-trip", () => {
  test("encrypt+decrypt roundtrip preserves plaintext", () => {
    setKey(TEST_KEY_HEX);
    const pt = "sk-ant-api03-abc123xyz";
    const enc = encryptSecret(pt);
    expect(enc.ciphertext.length).toBeGreaterThan(0);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
    expect(decryptSecret(enc)).toBe(pt);
  });

  test("ciphertext is unique per call (random IV)", () => {
    setKey(TEST_KEY_HEX);
    const a = encryptSecret("same-secret");
    const b = encryptSecret("same-secret");
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // Both decrypt back to same plaintext
    expect(decryptSecret(a)).toBe("same-secret");
    expect(decryptSecret(b)).toBe("same-secret");
  });

  test("tamper detection — flipping ciphertext bit throws vault_decrypt_failed", () => {
    setKey(TEST_KEY_HEX);
    const enc = encryptSecret("important");
    enc.ciphertext[0] ^= 0x01;
    expect(() => decryptSecret(enc)).toThrow(/vault_decrypt_failed/);
  });

  test("tamper detection — flipping tag bit throws vault_decrypt_failed", () => {
    setKey(TEST_KEY_HEX);
    const enc = encryptSecret("important");
    enc.tag[0] ^= 0x01;
    expect(() => decryptSecret(enc)).toThrow(/vault_decrypt_failed/);
  });

  test("wrong key cannot decrypt", () => {
    setKey(TEST_KEY_HEX);
    const enc = encryptSecret("important");
    setKey("ff".repeat(32));  // different key
    expect(() => decryptSecret(enc)).toThrow(/vault_decrypt_failed/);
  });
});

describe("RFC-028 P1 §4.1 — DB ops + key listing (永不返 value)", () => {
  test("vaultUpsert + vaultGet roundtrip via DB", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_A", "ANTHROPIC_API_KEY", "sk-ant-prod-1");
    expect(vaultGet("net_A", "ANTHROPIC_API_KEY")).toBe("sk-ant-prod-1");
  });

  test("vaultUpsert replaces existing key (same network_id + key)", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_B", "K1", "v1");
    vaultUpsert("net_B", "K1", "v2");
    expect(vaultGet("net_B", "K1")).toBe("v2");
  });

  test("vaultGet returns null for missing key (does NOT throw)", () => {
    setKey(TEST_KEY_HEX);
    expect(vaultGet("net_X", "MISSING")).toBeNull();
  });

  test("vaultListKeys returns key NAMES only (no values, ever)", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_L", "KEY_A", "value-a");
    vaultUpsert("net_L", "KEY_B", "value-b");
    const keys = vaultListKeys("net_L");
    expect(keys).toEqual(["KEY_A", "KEY_B"]);  // sorted; no values
    expect(JSON.stringify(keys)).not.toContain("value-a");
    expect(JSON.stringify(keys)).not.toContain("value-b");
  });

  test("network isolation — netA's secret不 visible to netB", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_A", "SHARED_NAME", "value-from-A");
    vaultUpsert("net_B", "SHARED_NAME", "value-from-B");
    expect(vaultGet("net_A", "SHARED_NAME")).toBe("value-from-A");
    expect(vaultGet("net_B", "SHARED_NAME")).toBe("value-from-B");
    expect(vaultListKeys("net_A")).toEqual(["SHARED_NAME"]);
    expect(vaultListKeys("net_B")).toEqual(["SHARED_NAME"]);
  });

  test("vaultDelete removes key + returns true; second delete returns false", () => {
    setKey(TEST_KEY_HEX);
    vaultUpsert("net_D", "K", "v");
    expect(vaultDelete("net_D", "K")).toBe(true);
    expect(vaultGet("net_D", "K")).toBeNull();
    expect(vaultDelete("net_D", "K")).toBe(false);  // no-op
  });
});

describe("RFC-028 P1 §4.1 — master key fingerprint", () => {
  test("fingerprint same for same key, different for different key", () => {
    setKey(TEST_KEY_HEX);
    const fp1 = vaultMasterKeyFingerprint();
    expect(fp1.length).toBe(16);
    setKey(TEST_KEY_HEX);  // re-set same key
    expect(vaultMasterKeyFingerprint()).toBe(fp1);
    setKey("ff".repeat(32));
    expect(vaultMasterKeyFingerprint()).not.toBe(fp1);
  });
});

describe("RFC-028 P1 §4.1 — DB ciphertext storage (PRAGMA-style: NO plaintext in DB)", () => {
  test("BLOB stored is ciphertext, not plaintext (raw SELECT verifies)", () => {
    setKey(TEST_KEY_HEX);
    const plaintext = "sk-very-secret-key-do-not-leak";
    vaultUpsert("net_P", "ANTHROPIC_API_KEY", plaintext);
    const raw = db.get<{ ciphertext: Buffer | Uint8Array; iv: Buffer | Uint8Array; tag: Buffer | Uint8Array }>(
      "SELECT ciphertext, iv, tag FROM network_secrets WHERE network_id = ?1 AND key = ?2",
      "net_P", "ANTHROPIC_API_KEY",
    );
    expect(raw).not.toBeNull();
    const ctBuf = Buffer.isBuffer(raw!.ciphertext) ? raw!.ciphertext : Buffer.from(raw!.ciphertext as any);
    // Plaintext substring MUST NOT appear in ciphertext bytes
    expect(ctBuf.toString("binary")).not.toContain(plaintext);
    expect(ctBuf.toString("utf8")).not.toContain(plaintext);
    // Even as hex / base64 / partial — bytes must not match plaintext bytes
    const plainBytes = Buffer.from(plaintext, "utf8");
    let found = false;
    for (let i = 0; i <= ctBuf.length - plainBytes.length; i++) {
      if (ctBuf.subarray(i, i + plainBytes.length).equals(plainBytes)) { found = true; break; }
    }
    expect(found).toBe(false);
  });
});
