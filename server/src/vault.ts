// RFC-028 P1 §4.1 — vault layer (AES-GCM at-rest + lazy master key gate).
//
// F2 CRITICAL: master key from ANET_HUB_SECRET_VAULT_KEY env is
// resolved LAZILY — hub boot does NOT require it. Existing prod hubs
// without the env should boot + run normally. The env is only required
// when:
//   (a) vault write hits (upsert_network_secret)
//   (b) vault read hits (probe / create-node env_refs)
//   (c) network_secrets / providers tables are non-empty at boot
//       (banner status only — doesn't throw)
//
// If the env is missing AND a vault op runs → throw `vault_master_key_missing`
// with explicit migration message. Existing hub stays up.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { db } from "./db.js";

let _masterKey: Buffer | null = null;
let _bootBannerShown = false;

/** Lazy getter — throws on first vault op if env missing. */
export function getVaultMasterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const hex = process.env.ANET_HUB_SECRET_VAULT_KEY;
  if (!hex) {
    throw new VaultError("vault_master_key_missing",
      "ANET_HUB_SECRET_VAULT_KEY env var not set. Generate one: openssl rand -hex 32. " +
      "Required only when using vault/provider features; this op tried to access vault."
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new VaultError("vault_master_key_invalid",
      "ANET_HUB_SECRET_VAULT_KEY must be 32 bytes hex (64 chars). Generate: openssl rand -hex 32"
    );
  }
  _masterKey = Buffer.from(hex, "hex");
  return _masterKey;
}

/** Banner-only check (does not throw). Call on boot for operator visibility. */
export function vaultStatusForBoot(): { configured: boolean; tablesHaveData: boolean; needsKeyToOp: boolean } {
  const configured = !!process.env.ANET_HUB_SECRET_VAULT_KEY
    && /^[0-9a-fA-F]{64}$/.test(process.env.ANET_HUB_SECRET_VAULT_KEY);
  let tablesHaveData = false;
  try {
    const r1 = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_secrets");
    const r2 = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM providers");
    tablesHaveData = (r1?.n || 0) > 0 || (r2?.n || 0) > 0;
  } catch { /* tables may not exist yet */ }
  return {
    configured,
    tablesHaveData,
    needsKeyToOp: tablesHaveData && !configured,
  };
}

/** Reset for unit tests (must be combined with delete process.env.ANET_HUB_SECRET_VAULT_KEY). */
export function _resetVaultKeyForTest(): void { _masterKey = null; _bootBannerShown = false; }

export class VaultError extends Error {
  constructor(public code: string, msg: string) {
    super(`${code}: ${msg}`);
    this.name = "VaultError";
  }
}

// ── AES-GCM encrypt/decrypt ─────────────────────────────────────────
// AES-256-GCM. 12-byte IV per RFC 5116. Auth tag is 16 bytes. We
// store iv + ciphertext + tag separately (DB schema mirrors NIST SP
// 800-38D structure for forward-compatibility).

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = getVaultMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct, iv, tag };
}

export function decryptSecret(enc: EncryptedSecret): string {
  const key = getVaultMasterKey();
  if (enc.tag.length !== TAG_BYTES) {
    throw new VaultError("vault_tag_invalid", `auth tag must be ${TAG_BYTES} bytes, got ${enc.tag.length}`);
  }
  const decipher = createDecipheriv(ALGO, key, enc.iv);
  decipher.setAuthTag(enc.tag);
  try {
    const pt = Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
    return pt.toString("utf8");
  } catch (e: any) {
    // GCM auth fail = either wrong key, tampered ciphertext, or
    // tampered iv/tag. All collapse to one error.
    throw new VaultError("vault_decrypt_failed", `AES-GCM auth fail (key/iv/tag/ciphertext mismatch): ${e?.message || e}`);
  }
}

// ── DB ops ───────────────────────────────────────────────────────────

export function vaultUpsert(networkId: string, key: string, plaintext: string): void {
  const enc = encryptSecret(plaintext);
  const now = Date.now();
  db.run(
    `INSERT INTO network_secrets (network_id, key, ciphertext, iv, tag, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(network_id, key) DO UPDATE SET
       ciphertext = ?3, iv = ?4, tag = ?5, updated_at = ?6`,
    [networkId, key, enc.ciphertext, enc.iv, enc.tag, now],
  );
}

/** Returns the decrypted plaintext, or null if no row.
 *  Throws VaultError on missing key / decrypt failure. */
export function vaultGet(networkId: string, key: string): string | null {
  const row = db.get<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
    "SELECT ciphertext, iv, tag FROM network_secrets WHERE network_id = ?1 AND key = ?2",
    networkId, key,
  );
  if (!row) return null;
  return decryptSecret({
    ciphertext: Buffer.isBuffer(row.ciphertext) ? row.ciphertext : Buffer.from(row.ciphertext as any),
    iv:         Buffer.isBuffer(row.iv)         ? row.iv         : Buffer.from(row.iv as any),
    tag:        Buffer.isBuffer(row.tag)        ? row.tag        : Buffer.from(row.tag as any),
  });
}

/** List vault key names for a network (NEVER returns values). */
export function vaultListKeys(networkId: string): string[] {
  const rows = db.all<{ key: string }>(
    "SELECT key FROM network_secrets WHERE network_id = ?1 ORDER BY key",
    networkId,
  );
  return rows.map(r => r.key);
}

export function vaultDelete(networkId: string, key: string): boolean {
  const r: any = db.run("DELETE FROM network_secrets WHERE network_id = ?1 AND key = ?2", [networkId, key]);
  return (r?.changes ?? 0) > 0;
}

/** Test/diagnostic: fingerprint of master key (sha256 hex first 8) so
 *  ops can verify two hubs share the same vault key without leaking it. */
export function vaultMasterKeyFingerprint(): string {
  const key = getVaultMasterKey();
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
