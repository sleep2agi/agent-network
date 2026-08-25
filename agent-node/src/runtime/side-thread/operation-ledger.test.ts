import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateFileOperationLedger, type SideThreadOperation } from "./operation-ledger";
const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const op = (state: SideThreadOperation["state"] = "sent"): SideThreadOperation => ({ version: 1, nodeId: "node-1", sideThreadId: "side-1", opId: "op-1", idempotencyKey: "request-0001", method: "fork", targetHash: `sha256:${"a".repeat(64)}`, fingerprint: `sha256:${"b".repeat(64)}`, state, updatedAt: 1 });
describe("PrivateFileOperationLedger", () => {
  test("atomically persists 0600 and recovers across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "side-ledger-")); roots.push(root);
    const first = new PrivateFileOperationLedger(root); first.put(op()); first.put({ ...op("ambiguous"), updatedAt: 2 });
    const path = join(root, "node-1", "side-1", "op-1.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new PrivateFileOperationLedger(root).get("node-1", "side-1", "op-1")?.state).toBe("ambiguous");
    expect(new PrivateFileOperationLedger(root).list("node-1", "side-1")).toHaveLength(1);
    expect(new PrivateFileOperationLedger(root).find("node-1", "side-1", "request-0001", "fork", op().fingerprint)?.state).toBe("ambiguous");
  });
  test("rejects traversal, bearer, URL and unhashed targets", () => {
    const root = mkdtempSync(join(tmpdir(), "side-ledger-")); roots.push(root); const ledger = new PrivateFileOperationLedger(root);
    for (const bad of ["../escape", "Bearer SECRET", "https://host/x", "/private/path"]) expect(() => ledger.put({ ...op(), nodeId: bad })).toThrow("invalid");
    expect(() => ledger.put({ ...op(), targetHash: "/private/path" })).toThrow("hashes required");
  });
});
