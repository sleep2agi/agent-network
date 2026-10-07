import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

function snapshot(path: string, nodeId: unknown): string | null {
    try {
      const st = lstatSync(path, {bigint:true});
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== BigInt(process.getuid?.() ?? -1) || (st.mode & 0o022n)) return null;
      const raw = readFileSync(path, "utf8"), data = JSON.parse(raw);
      if (typeof nodeId !== "string" || !nodeId || data?.node_id !== nodeId || data.stopped !== true) return null;
      // Device numbers can change across boot; inode/ctime/content stay bound
      // to the receipt in this node directory, not the host's device mapping.
      return `${st.ino}:${st.ctimeNs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (e: any) { if (e.code === "ENOENT" || e instanceof SyntaxError) return null; throw e; }
}

/** Capture BEFORE asynchronous manual start. Successful start supersedes only
 * this exact receipt, without unlinking it: check-then-unlink would race another
 * process writing a new stop. A late certificate can never supersede that new
 * receipt, even if its JSON is identical (inode/ctime are part of identity). */
export function stoppedReceiptAtStart(nodeDir: string, nodeId: unknown): () => void {
  const path = join(nodeDir, ".hub-stopped"), before = snapshot(path, nodeId);
  return () => {
    if (before === null || snapshot(path, nodeId) !== before) return;
    const file = join(nodeDir, ".hub-resumed"), tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({version:1,node_id:nodeId,receipt_fingerprint:before}), {mode:0o600,flag:"wx"});
      renameSync(tmp, file);
    } finally { try { unlinkSync(tmp); } catch (e:any) { if(e.code!=="ENOENT")throw e; } }
  };
}

/** Missing stop => runnable. Unreadable/unsafe/legacy stop => stay stopped.
 * Keep the fleet boot probe's wire format in sync (Docker parity test). */
export function isHubStopped(nodeDir: string, nodeId: unknown): boolean {
  const path = join(nodeDir, ".hub-stopped");
  try { lstatSync(path); } catch(e:any) { return e.code !== "ENOENT"; }
  try {
    const fingerprint = snapshot(path, nodeId), resumed = join(nodeDir, ".hub-resumed"), st = lstatSync(resumed);
    if (!fingerprint || !st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) return true;
    const data = JSON.parse(readFileSync(resumed, "utf8"));
    return !(data?.version === 1 && data.node_id === nodeId && data.receipt_fingerprint === fingerprint);
  } catch { return true; }
}
