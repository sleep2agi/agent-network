import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SideThreadCommandReceipt, SideThreadCommandReceiptStore } from "./command-transport";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * Crash-safe node journal for command execution receipts. The receipt is
 * persisted before an ACK is returned, so an ACK response loss/restart
 * replays the exact result without repeating a native mutation.
 */
export class PrivateFileCommandReceiptStore implements SideThreadCommandReceiptStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }

  get(commandId: string): SideThreadCommandReceipt | undefined {
    const path = this.path(commandId);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8"));
    validate(value);
    return value;
  }

  put(receipt: SideThreadCommandReceipt): void {
    validate(receipt);
    const path = this.path(receipt.commandId);
    if (existsSync(path)) {
      const prior = this.get(receipt.commandId)!;
      if (prior.fingerprint !== receipt.fingerprint || JSON.stringify(prior.ack) !== JSON.stringify(receipt.ack))
        throw new Error("command receipt is immutable");
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path); chmodSync(path, 0o600);
    const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  private path(commandId: string): string {
    if (!SAFE.test(commandId)) throw new Error("invalid commandId");
    return join(this.root, `${commandId}.json`);
  }
}

function validate(value: any): asserts value is SideThreadCommandReceipt {
  if (value?.version !== 1 || !SAFE.test(value.commandId) || typeof value.fingerprint !== "string"
    || value.fingerprint.length > 2_000_000 || value.ack?.commandId !== value.commandId
    || value.ack?.protocol !== "side_thread.ack.v1") throw new Error("invalid command receipt");
}
