import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { operationHash } from "./operation-ledger";

export interface ForkLeaseRecord {
  version: 1;
  nodeId: string;
  sourceThreadHash: string;
  sideThreadId: string;
  operationId: string;
  fingerprint: string;
  snapshotThreadIdHashes: string[];
  state: "snapshot" | "sent" | "ambiguous";
  updatedAt: number;
}

export interface ForkLeaseStore {
  acquire(record: ForkLeaseRecord): ForkLeaseRecord;
  put(record: ForkLeaseRecord): void;
  get(nodeId: string, sourceThreadId: string): ForkLeaseRecord | undefined;
  release(nodeId: string, sourceThreadId: string, operationId: string): void;
}

/**
 * Crash-persistent, per-source exclusion for an owned stdio app-server.
 * There is deliberately no timeout/lease stealing: after an uncertain fork,
 * another process must reconcile the exact operation rather than guess that an
 * old owner is dead and emit a second thread/fork.
 */
export class PrivateFileForkLeaseStore implements ForkLeaseStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  }
  acquire(record: ForkLeaseRecord): ForkLeaseRecord {
    validate(record);
    const path = this.path(record.nodeId, record.sourceThreadHash);
    try {
      writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      this.sync(path); return clone(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const existing = this.read(path);
      if (existing.operationId !== record.operationId || existing.fingerprint !== record.fingerprint
        || existing.sideThreadId !== record.sideThreadId) {
        throw new Error("source thread already has an unresolved fork lease");
      }
      return existing;
    }
  }
  put(record: ForkLeaseRecord): void {
    validate(record);
    const path = this.path(record.nodeId, record.sourceThreadHash);
    const existing = this.read(path);
    if (existing.operationId !== record.operationId || existing.fingerprint !== record.fingerprint
      || existing.sideThreadId !== record.sideThreadId) throw new Error("fork lease ownership changed");
    if (record.updatedAt < existing.updatedAt
      || (existing.state !== record.state && !(existing.state === "snapshot" && record.state === "sent")
        && !(existing.state === "sent" && record.state === "ambiguous"))) {
      throw new Error(`invalid fork lease transition ${existing.state}->${record.state}`);
    }
    if (existing.state !== "snapshot"
      && JSON.stringify(existing.snapshotThreadIdHashes) !== JSON.stringify(record.snapshotThreadIdHashes)) {
      throw new Error("fork lease snapshot is immutable after send");
    }
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    this.sync(tmp); renameSync(tmp, path); chmodSync(path, 0o600); this.syncDir();
  }
  get(nodeId: string, sourceThreadId: string): ForkLeaseRecord | undefined {
    const path = this.path(nodeId, operationHash(sourceThreadId));
    return existsSync(path) ? this.read(path) : undefined;
  }
  release(nodeId: string, sourceThreadId: string, operationId: string): void {
    const path = this.path(nodeId, operationHash(sourceThreadId));
    if (!existsSync(path)) return;
    const existing = this.read(path);
    if (existing.operationId !== operationId) throw new Error("fork lease release ownership mismatch");
    unlinkSync(path); this.syncDir();
  }
  private path(nodeId: string, sourceThreadHash: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(nodeId)) throw new Error("invalid fork lease nodeId");
    if (!/^sha256:[0-9a-f]{64}$/.test(sourceThreadHash)) throw new Error("fork lease source hash required");
    return join(this.root, `${nodeId}.${sourceThreadHash.slice(7)}.json`);
  }
  private read(path: string): ForkLeaseRecord { const value = JSON.parse(readFileSync(path, "utf8")); validate(value); return value; }
  private sync(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } this.syncDir(); }
  private syncDir(): void { const fd = openSync(this.root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function validate(value: ForkLeaseRecord): void {
  if (value?.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.nodeId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.sideThreadId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.operationId)
    || !/^sha256:[0-9a-f]{64}$/.test(value.sourceThreadHash)
    || !/^sha256:[0-9a-f]{64}$/.test(value.fingerprint)
    || !/^(snapshot|sent|ambiguous)$/.test(value.state)
    || value.snapshotThreadIdHashes.some((x) => !/^sha256:[0-9a-f]{64}$/.test(x))) throw new Error("invalid fork lease");
}
function clone(value: ForkLeaseRecord): ForkLeaseRecord { return { ...value, snapshotThreadIdHashes: [...value.snapshotThreadIdHashes] }; }
