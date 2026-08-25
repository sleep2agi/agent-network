import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type OperationState = "sent" | "acked" | "ambiguous" | "reconciling" | "reconciled" | "compensated";
export type OperationMethod = "fork" | "start" | "interrupt" | "archive" | "delete";
export interface SideThreadOperation {
  version: 1; nodeId: string; sideThreadId: string; opId: string; idempotencyKey: string;
  method: OperationMethod; targetHash: string; fingerprint: string; state: OperationState;
  result?: { derivedThreadIdHash?: string; turnIdHash?: string; classification?: "exists" | "not-found" | "terminal" | "active" };
  updatedAt: number;
}
export interface OperationLedger { put(op: SideThreadOperation): void; get(nodeId: string, sideThreadId: string, opId: string): SideThreadOperation | undefined; list(nodeId: string, sideThreadId: string): SideThreadOperation[]; }

export class PrivateFileOperationLedger implements OperationLedger {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); }
  put(op: SideThreadOperation): void {
    validate(op);
    const path = this.path(op.nodeId, op.sideThreadId, op.opId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700);
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(op)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path); chmodSync(path, 0o600);
    const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  get(nodeId: string, sideThreadId: string, opId: string): SideThreadOperation | undefined {
    const path = this.path(nodeId, sideThreadId, opId); if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")); validate(value); return value;
  }
  list(nodeId: string, sideThreadId: string): SideThreadOperation[] {
    const dir = dirname(this.path(nodeId, sideThreadId, "probe"));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => {
      const value = JSON.parse(readFileSync(join(dir, x), "utf8")); validate(value); return value;
    }).sort((a, b) => a.updatedAt - b.updatedAt || a.opId.localeCompare(b.opId));
  }
  private path(nodeId: string, sideThreadId: string, opId: string): string {
    for (const [v, label] of [[nodeId, "nodeId"], [sideThreadId, "sideThreadId"], [opId, "opId"]] as const) requireSafe(v, label);
    return join(this.root, nodeId, sideThreadId, `${opId}.json`);
  }
}
function requireSafe(value: string, label: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`invalid operation ${label}`); }
function validate(op: SideThreadOperation): void {
  if (op?.version !== 1) throw new Error("unsupported operation ledger version");
  for (const [v, label] of [[op.nodeId, "nodeId"], [op.sideThreadId, "sideThreadId"], [op.opId, "opId"], [op.idempotencyKey, "idempotencyKey"]] as const) requireSafe(v, label);
  if (!/^(fork|start|interrupt|archive|delete)$/.test(op.method) || !/^(sent|acked|ambiguous|reconciling|reconciled|compensated)$/.test(op.state)) throw new Error("invalid operation state");
  if (!/^sha256:[0-9a-f]{64}$/.test(op.targetHash) || !/^sha256:[0-9a-f]{64}$/.test(op.fingerprint)) throw new Error("operation hashes required");
}
