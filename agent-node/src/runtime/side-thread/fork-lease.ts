import { spawn } from "node:child_process";
import { constants, chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  claimSupported(): boolean;
  claim(nodeId: string, sourceThreadId: string): Promise<ForkExecutorClaim>;
  claimOperation(nodeId: string, sideThreadId: string, operationId: string): Promise<ForkExecutorClaim>;
  acquire(record: ForkLeaseRecord): ForkLeaseRecord;
  put(record: ForkLeaseRecord): void;
  get(nodeId: string, sourceThreadId: string): ForkLeaseRecord | undefined;
  release(nodeId: string, sourceThreadId: string, operationId: string): void;
}

export interface ForkExecutorClaim { release(): Promise<void> }

/**
 * Crash-persistent, per-source exclusion for an owned stdio app-server.
 * There is deliberately no timeout/lease stealing: after an uncertain fork,
 * another process must reconcile the exact operation rather than guess that an
 * old owner is dead and emit a second thread/fork.
 */
export class PrivateFileForkLeaseStore implements ForkLeaseStore {
  private readonly platform: NodeJS.Platform;
  private readonly flockBinary: string;
  constructor(private readonly root: string, options: { platform?: NodeJS.Platform; flockBinary?: string } = {}) {
    this.platform = options.platform ?? process.platform;
    this.flockBinary = options.flockBinary ?? "/usr/bin/flock";
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  }
  claimSupported(): boolean {
    return this.platform === "linux" && existsSync(this.flockBinary) && existsSync("/bin/sh") && existsSync("/bin/cat");
  }
  async claim(nodeId: string, sourceThreadId: string): Promise<ForkExecutorClaim> {
    if (!this.claimSupported()) throw new Error("fork executor claim is unsupported on this platform");
    const sourceThreadHash = operationHash(sourceThreadId);
    const lockPath = this.path(nodeId, sourceThreadHash).replace(/\.json$/, ".executor.lock");
    return this.claimPath(lockPath);
  }
  async claimOperation(nodeId: string, sideThreadId: string, operationId: string): Promise<ForkExecutorClaim> {
    if (!this.claimSupported()) throw new Error("operation executor claim is unsupported on this platform");
    for (const [value, label] of [[nodeId, "nodeId"], [sideThreadId, "sideThreadId"], [operationId, "operationId"]] as const) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`invalid executor ${label}`);
    }
    const lockPath = join(this.root, `${nodeId}.${operationHash(`${sideThreadId}\0${operationId}`).slice(7)}.operation.lock`);
    return this.claimPath(lockPath);
  }
  private async claimPath(lockPath: string): Promise<ForkExecutorClaim> {
    const fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("runtime operation executor lock must be a single-link regular file");
      fchmodSync(fd, 0o600);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    const holder = spawn("/bin/sh", ["-c",
      "if ! \"$1\" --exclusive --nonblock 3; then exit 73; fi; printf 'LOCKED\\n'; /bin/cat >/dev/null",
      "side-thread-executor", this.flockBinary], {
      env: {}, stdio: ["pipe", "pipe", "pipe", fd],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false; let stdout = ""; let stderr = "";
        const timer = setTimeout(() => {
          if (settled) return; settled = true; holder.kill("SIGKILL");
          reject(new Error("runtime operation executor claim startup timed out"));
        }, 3_000);
        timer.unref?.();
        const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
        holder.stdout!.setEncoding("utf8");
        holder.stdout!.on("data", (chunk: string) => {
          stdout = (stdout + chunk).slice(-64);
          if (!settled && stdout.includes("LOCKED\n")) { settled = true; clearTimeout(timer); resolve(); }
        });
        holder.stderr!.setEncoding("utf8");
        holder.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-300); });
        holder.once("error", (error) => fail(new Error(`runtime operation executor claim unavailable: ${error.message}`)));
        holder.once("exit", (code) => fail(new Error(code === 73
          ? "runtime operation executor is already claimed"
          : `runtime operation executor holder exited before claim${stderr ? `: ${stderr.trim()}` : ""}`)));
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    let released = false;
    return { release: async () => {
      if (released) return; released = true;
      await new Promise<void>((resolve) => {
        if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
        holder.once("exit", () => resolve()); holder.stdin!.end();
      });
      closeSync(fd);
    } };
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
  private read(path: string): ForkLeaseRecord {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("fork lease must be a single-link regular file");
      fchmodSync(fd, 0o600);
      const value = JSON.parse(readFileSync(fd, "utf8")); validate(value); return value;
    } finally { closeSync(fd); }
  }
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
