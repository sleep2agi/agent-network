import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(() => store.acquire({ ...lease("op-00000002"), sideThreadId: "side-2", updatedAt: Date.now() + 10 ** 9 })).toThrow("unresolved fork lease");
    expect(() => store.release("node-1", "source-1", "op-00000002")).toThrow("ownership mismatch");
  });
  test("kernel executor claim is process-exclusive and explicitly gated off unproved platforms", async () => {
    const root = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(root);
    const store = new PrivateFileForkLeaseStore(root);
    expect(store.claimSupported()).toBe(true);
    const first = await store.claim("node-1", "source-1");
    const distinct = await store.claim("node-1", "source-2");
    const operation = await store.claimOperation("node-1", "side-1", "op-1");
    await expect(store.claim("node-1", "source-1")).rejects.toThrow("already claimed");
    await expect(store.claimOperation("node-1", "side-1", "op-1")).rejects.toThrow("already claimed");
    await operation.release(); await distinct.release(); await first.release();
    const resumed = await store.claim("node-1", "source-1"); await resumed.release();
    expect(new PrivateFileForkLeaseStore(root, { platform: "win32" }).claimSupported()).toBe(false);
  });
  test("reopen repairs lease mode and rejects hard-linked state", () => {
    const root = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(root);
    const store = new PrivateFileForkLeaseStore(root); store.acquire(lease());
    const path = join(root, readdirSync(root).find((name) => name.endsWith(".json"))!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    expect(new PrivateFileForkLeaseStore(root).acquire(lease())).toEqual(lease());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    linkSync(path, join(root, "lease-hardlink"));
    expect(() => store.get("node-1", "source-1")).toThrow("single-link regular file");
  });
  test("executor lock refuses symlink and hardlink substitution", async () => {
    const symlinkRoot = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(symlinkRoot);
    const sourceHash = operationHash("source-1").slice(7);
    const lockName = `node-1.${sourceHash}.executor.lock`;
    const target = join(symlinkRoot, "target"); writeFileSync(target, "do-not-follow");
    symlinkSync(target, join(symlinkRoot, lockName));
    await expect(new PrivateFileForkLeaseStore(symlinkRoot).claim("node-1", "source-1")).rejects.toThrow();

    const hardlinkRoot = mkdtempSync(join(tmpdir(), "fork-lease-")); roots.push(hardlinkRoot);
    const store = new PrivateFileForkLeaseStore(hardlinkRoot);
    const first = await store.claim("node-1", "source-1"); await first.release();
    const lockPath = join(hardlinkRoot, lockName); linkSync(lockPath, join(hardlinkRoot, "executor-hardlink"));
    await expect(store.claim("node-1", "source-1")).rejects.toThrow("single-link regular file");
  });
});
