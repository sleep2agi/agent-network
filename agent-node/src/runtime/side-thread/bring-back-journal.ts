import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { SideThreadAmbiguousError, SideThreadConflictError } from "./domain";

type Entry = { version: 1; operationId: string; fingerprint: string; state: "prepared" | "sent" | "accepted" | "ambiguous"; destinationTurnId?: string };

/**
 * Executes bring-back only behind a private write-ahead journal. A crash after
 * send is ambiguous and therefore never retried automatically; this is the
 * fail-closed alternative to duplicating content in the source thread.
 */
export class JournaledBringBackExecutor {
  constructor(private readonly root: string, private readonly send: (input: {
    destinationThreadId: string; text: string; clientRequestId: string;
  }) => Promise<{ destinationTurnId: string }>) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  }
  async execute(input: { operationId: string; destinationThreadId: string; text: string }): Promise<{ destinationTurnId: string }> {
    const fingerprint = hash(JSON.stringify([input.destinationThreadId, input.text]));
    const prior = this.read(input.operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new SideThreadConflictError("bring-back operation payload changed");
      if (prior.state === "accepted" && prior.destinationTurnId) return { destinationTurnId: prior.destinationTurnId };
      if (prior.state === "sent" || prior.state === "ambiguous") throw new SideThreadAmbiguousError("bring-back outcome is ambiguous; refusing duplicate send");
    } else this.write({ version: 1, operationId: input.operationId, fingerprint, state: "prepared" });
    this.write({ version: 1, operationId: input.operationId, fingerprint, state: "sent" });
    try {
      const result = await this.send({ destinationThreadId: input.destinationThreadId, text: input.text, clientRequestId: input.operationId });
      if (!safe(result.destinationTurnId)) throw new Error("invalid destination turn identity");
      this.write({ version: 1, operationId: input.operationId, fingerprint, state: "accepted", destinationTurnId: result.destinationTurnId });
      return result;
    } catch (error) {
      this.write({ version: 1, operationId: input.operationId, fingerprint, state: "ambiguous" });
      throw error instanceof SideThreadConflictError ? error : new SideThreadAmbiguousError("bring-back response lost; refusing duplicate send");
    }
  }
  private read(operationId: string): Entry | undefined { const p = this.path(operationId); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined; }
  private write(entry: Entry): void {
    const path = this.path(entry.operationId), tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path); chmodSync(path, 0o600);
    const dir = openSync(this.root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  private path(id: string): string { if (!safe(id)) throw new Error("invalid operationId"); return join(this.root, `${id}.json`); }
}
function safe(v: unknown): v is string { return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v); }
function hash(v: string): string { return createHash("sha256").update(v).digest("hex"); }
