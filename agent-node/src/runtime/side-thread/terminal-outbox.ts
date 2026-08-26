import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SideThreadTerminalEnvelope } from "./command-transport";

/** Private durable node→Hub terminal outbox. */
export class PrivateFileTerminalOutbox {
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); }
  enqueue(event: SideThreadTerminalEnvelope): void {
    const path = this.path(event), value = `${JSON.stringify(event)}\n`;
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== value) throw new Error("terminal envelope is immutable");
      return;
    }
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, value, { flag: "wx", mode: 0o600 }); this.sync(tmp);
    renameSync(tmp, path); chmodSync(path, 0o600); this.syncDir();
  }
  list(): SideThreadTerminalEnvelope[] {
    return readdirSync(this.root).filter((x) => x.endsWith(".json")).sort().map((name) => {
      const value = JSON.parse(readFileSync(join(this.root, name), "utf8"));
      if (value?.protocol !== "side_thread.terminal.v1") throw new Error("invalid terminal outbox entry");
      return value;
    });
  }
  remove(event: SideThreadTerminalEnvelope): void { const path = this.path(event); if (existsSync(path)) { unlinkSync(path); this.syncDir(); } }
  private path(event: SideThreadTerminalEnvelope): string {
    const key = JSON.stringify([event.sideThreadId, event.attemptId, event.threadId, event.turnId]);
    return join(this.root, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  private sync(path: string) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private syncDir() { const fd = openSync(this.root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
