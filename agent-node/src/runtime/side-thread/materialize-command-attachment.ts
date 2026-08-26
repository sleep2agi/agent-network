import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideThreadAttachmentGrant } from "./command-transport";

/** Materialize one exact, short-lived Hub grant into a private node cache. */
export async function materializeCommandAttachment(grant: SideThreadAttachmentGrant, deps: {
  hubUrl: string; nodeToken: string; cacheDir: string; fetchImpl?: typeof fetch;
}): Promise<{ path: string; mediaType: string; sha256: string; size: number }> {
  if (!deps.nodeToken.startsWith("ntok_")) throw new Error("bound node token required");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${deps.hubUrl.replace(/\/+$/, "")}/api/side-thread/attachment-grants/${encodeURIComponent(grant.grantId)}`, {
    headers: { Authorization: `Bearer ${deps.nodeToken}` },
  });
  if (!response.ok) throw new Error(`attachment grant refused: ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== grant.size) throw new Error("attachment grant size mismatch");
  if (grant.size > 50 * 1024 * 1024) throw new Error("attachment grant exceeds node cap");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== grant.size) throw new Error("attachment grant size mismatch");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== grant.sha256) throw new Error("attachment grant digest mismatch");
  mkdirSync(deps.cacheDir, { recursive: true, mode: 0o700 }); chmodSync(deps.cacheDir, 0o700);
  const path = join(deps.cacheDir, `${grant.fileId}-${grant.sha256.slice(0, 16)}`);
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
  renameSync(tmp, path); chmodSync(path, 0o600);
  return { path, mediaType: grant.mediaType, sha256: digest, size: bytes.byteLength };
}
