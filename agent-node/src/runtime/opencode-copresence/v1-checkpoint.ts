import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";
import type { Stats } from "fs";

export interface V1CheckpointIdentity { nodeId: string; networkId: string }
export interface V1SessionData { info: Record<string, any>; messages: Array<{ info: Record<string, any>; parts: any[] }> }
export interface V1Checkpoint extends V1CheckpointIdentity {
  version: 1;
  savedAt: string;
  cleanShutdown: boolean;
  data: V1SessionData;
}
const NAME = "opencode-v1-session.json";
const LIMIT = 64 * 1024 * 1024;

function validateEmbeddedFile(part: any): void {
  if (part?.type === "file" && (typeof part.url !== "string" || !part.url.startsWith("data:"))) {
    throw new Error("OpenCode V1 checkpoint cannot restore external file references");
  }
}

function privateStat(stat: Stats, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()
    || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (!directory && stat.nlink !== 1)) {
    throw new Error("OpenCode V1 checkpoint requires an owned private directory/file");
  }
}

export function validateV1SessionData(data: V1SessionData, sessionId: string): void {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId) || data?.info?.id !== sessionId || !Array.isArray(data.messages)) {
    throw new Error("OpenCode V1 checkpoint session mismatch");
  }
  const messages = new Set<string>();
  const parts = new Set<string>();
  for (const message of data.messages) {
    const id = message?.info?.id;
    if (typeof id !== "string" || !id.startsWith("msg_") || messages.has(id)
      || message.info.sessionID !== sessionId || !Array.isArray(message.parts)) {
      throw new Error("OpenCode V1 checkpoint message identity mismatch");
    }
    messages.add(id);
    for (const part of message.parts) {
      if (typeof part?.id !== "string" || parts.has(part.id)
        || part.sessionID !== sessionId || part.messageID !== id) {
        throw new Error("OpenCode V1 checkpoint part identity mismatch");
      }
      // Old writable state must not turn a file URL into a read outside the
      // fresh workspace. Embedded media is self-contained; local/remote file
      // migration requires a separate explicit materialization path.
      validateEmbeddedFile(part);
      if (Array.isArray(part.state?.attachments)) part.state.attachments.forEach(validateEmbeddedFile);
      parts.add(part.id);
    }
  }
}

export function readV1Checkpoint(workDir: string, identity: V1CheckpointIdentity, sessionId?: string): V1Checkpoint | undefined {
  privateStat(lstatSync(workDir), true);
  const path = join(workDir, NAME);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    privateStat(stat);
    if (stat.size > LIMIT) throw new Error("OpenCode V1 checkpoint exceeds 64 MiB");
    const value = JSON.parse(readFileSync(fd, "utf8")) as V1Checkpoint;
    if (value.version !== 1 || value.nodeId !== identity.nodeId || value.networkId !== identity.networkId
      || !identity.nodeId || !identity.networkId || typeof value.savedAt !== "string"
      || typeof value.cleanShutdown !== "boolean" || (sessionId && value.data?.info?.id !== sessionId)) {
      throw new Error("OpenCode V1 checkpoint node/network/session mismatch");
    }
    validateV1SessionData(value.data, value.data?.info?.id);
    return value;
  } finally { closeSync(fd); }
}

export function writeV1Checkpoint(workDir: string, identity: V1CheckpointIdentity,
  data: V1SessionData, cleanShutdown: boolean, options: { exclusive?: boolean } = {}): void {
  privateStat(lstatSync(workDir), true);
  if (!identity.nodeId || !identity.networkId) throw new Error("OpenCode V1 checkpoint requires immutable node/network identity");
  validateV1SessionData(data, data?.info?.id);
  const path = join(workDir, NAME);
  try { privateStat(lstatSync(path)); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const body = JSON.stringify({ version: 1, nodeId: identity.nodeId, networkId: identity.networkId,
    savedAt: new Date().toISOString(), cleanShutdown, data });
  if (Buffer.byteLength(body) > LIMIT) throw new Error("OpenCode V1 checkpoint exceeds 64 MiB");
  const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); }
  catch (error) { rmSync(temp, { force: true }); throw error; }
  finally { closeSync(fd); }
  try {
    // First legacy capture must never replace an existing recovery point,
    // including one created concurrently after preflight.
    if (options.exclusive) linkSync(temp, path);
    else renameSync(temp, path);
  }
  finally { rmSync(temp, { force: true }); }
}

/** Only a local JSON file in the fresh launch root is handed to native import.
 * Never import URLs, reuse the old DB root, or send a transcript to stdout. */
export function importV1Checkpoint(binary: string, env: NodeJS.ProcessEnv, cwd: string, checkpoint: V1Checkpoint): void {
  const root = env.XDG_DATA_HOME;
  if (!root) throw new Error("OpenCode V1 checkpoint import requires a fresh data root");
  const path = join(root, `anet-session-import-${randomBytes(8).toString("hex")}.json`);
  // Session-local permission overrides and sharing state are not history.
  // Always use the current launch's policy, never imported authorization.
  const { permission: _permission, share: _share, ...info } = checkpoint.data.info;
  writeFileSync(path, JSON.stringify({ info, messages: checkpoint.data.messages }), { mode: 0o600, flag: "wx" });
  try {
    const result = spawnSync(binary, ["import", path], { cwd, env, timeout: 30_000,
      maxBuffer: 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0) throw new Error("OpenCode V1 checkpoint native import failed; saved history retained");
    // v1.18.1 may exit 0 after an import read error. Prove success again with
    // authenticated GET session/history after server startup, not exit code.
  } finally { rmSync(path, { force: true }); }
}

export function verifyV1ImportedHistory(checkpoint: V1Checkpoint, actual: V1SessionData): void {
  validateV1SessionData(actual, checkpoint.data.info.id);
  if (actual.messages.length !== checkpoint.data.messages.length) throw new Error("OpenCode V1 imported history count mismatch");
  const byId = new Map(actual.messages.map(message => [message.info.id, message]));
  for (const message of checkpoint.data.messages) {
    const restored = byId.get(message.info.id);
    if (!restored || !isDeepStrictEqual(restored.parts, message.parts)
      || restored.info.role !== message.info.role || restored.info.parentID !== message.info.parentID) {
      throw new Error("OpenCode V1 imported history mismatch; refusing a new session");
    }
  }
}
