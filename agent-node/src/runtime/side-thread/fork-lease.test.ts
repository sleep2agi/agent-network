import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateFileForkLeaseStore, type ForkLeaseRecord } from "./fork-lease";
import { operationHash } from "./operation-ledger";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const lease = (operationId = "op-00000001"): ForkLeaseRecord => ({ version: 1, nodeId: "node-1",
  sourceThreadHash: operationHash("source-1"), sideThreadId: "side-1", operationId,
  fingerprint: operationHash("fork-input"), snapshotThreadIdHashes: [], state: "snapshot", updatedAt: 1 });

describe("PrivateFileForkLeaseStore", () => {
  test("persists a private per-source lease and the same operation resumes across instances", () => {
    const root = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(root);
    const first = new PrivateFileForkLeaseStore(root); first.acquire(lease());
    const second = new PrivateFileForkLeaseStore(root);
    expect(second.acquire(lease())).toEqual(lease());
    expect(statSync(root).mode & 0o777).toBe(0o700);
    second.put({ ...lease(), state: "sent", updatedAt: 2 });
    second.put({ ...lease(), state: "ambiguous", updatedAt: 3 });
    expect(first.get("node-1", "source-1")?.state).toBe("ambiguous");
    second.release("node-1", "source-1", "op-00000001");
    expect(first.get("node-1", "source-1")).toBeUndefined();
  });
  test("a different operation cannot steal an unresolved source lease", () => {
    const root = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(root);
    const store = new PrivateFileForkLeaseStore(root); store.acquire(lease());
    expect(() => store.acquire({ ...lease("op-00000002"), sideThreadId: "side-2" })).toThrow("unresolved fork lease");
    expect(() => store.release("node-1", "source-1", "op-00000002")).toThrow("ownership mismatch");
  });
});
