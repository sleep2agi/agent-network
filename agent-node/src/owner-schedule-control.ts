import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parseExternalSchedulePatch, parseManagedCronExpression, type ExternalSchedulePatch } from "./shared/external-schedule-contract.js";

const MAX_CRONTAB_BYTES = 1024 * 1024;
const JOURNAL_NAME = ".external-schedule-edit-journal.json";
const AUDIT_NAME = ".external-schedule-edit-audit.jsonl";
const MAX_AUDIT_BYTES = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BEGIN_RE = /^# ANET-MANAGED-SCHEDULE id=([A-Za-z0-9][A-Za-z0-9._-]{0,127}) revision=(\d+) command_sha256=([0-9a-f]{64})$/;
const DISABLED_PREFIX = "# ANET-DISABLED ";

export class OwnerScheduleSafetyError extends Error {}

export type ManagedCronEntry = {
  id: string;
  revision: number;
  enabled: boolean;
  cron: string;
  commandTail: string;
  commandSha256: string;
  beginLine: number;
  jobLine: number;
  endLine: number;
};

export type ScheduleEditIntent = {
  intent_id: string;
  node_id: string;
  schedule_id: string;
  base_revision: number;
  patch: ExternalSchedulePatch;
};

export type CrontabAdapter = {
  read(): string;
  install(content: string): void;
};

type Journal = {
  schema: 1;
  intent_id: string;
  schedule_id: string;
  base_revision: number;
  result_revision: number;
  before_sha256: string;
  after_sha256: string;
  before_content: string;
  after_content: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(a: ReturnType<typeof lstatSync>, b: ReturnType<typeof lstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new OwnerScheduleSafetyError(`owner schedule control refuses unsafe directory: ${path}`);
  }
}

function readJournal(path: string): Journal | null {
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(path); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const uid = process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || uid === undefined || before.uid !== uid || (before.mode & 0o177) !== 0) {
    throw new OwnerScheduleSafetyError("owner schedule control refuses unsafe journal");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd);
    if (!sameIdentity(before, opened) || opened.size > 2 * MAX_CRONTAB_BYTES) {
      throw new OwnerScheduleSafetyError("owner schedule journal changed during read");
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as Journal;
    if (parsed?.schema !== 1 || !ID_RE.test(parsed.schedule_id) || !/^sei_[0-9a-f-]+$/.test(parsed.intent_id)
      || !Number.isSafeInteger(parsed.base_revision) || parsed.result_revision !== parsed.base_revision + 1
      || sha256(parsed.before_content) !== parsed.before_sha256 || sha256(parsed.after_content) !== parsed.after_sha256) {
      throw new OwnerScheduleSafetyError("invalid owner schedule journal");
    }
    return parsed;
  } finally { closeSync(fd); }
}

function writeJournal(path: string, journal: Journal): void {
  const parent = dirname(path);
  assertPrivateDirectory(parent);
  let fd: number | undefined;
  try {
    // O_EXCL is the no-overwrite publication primitive. A partial journal
    // after process death is intentionally fail-closed and blocks host writes.
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    writeFileSync(fd, JSON.stringify(journal) + "\n", "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const parentFd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    throw error;
  }
}

function removeJournal(path: string): void {
  const journal = readJournal(path);
  if (!journal) return;
  rmSync(path);
  const parentFd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
}

export function parseManagedCrontab(content: string): Map<string, ManagedCronEntry> {
  if (Buffer.byteLength(content) > MAX_CRONTAB_BYTES || /[\r\0]/.test(content)) {
    throw new OwnerScheduleSafetyError("unsafe crontab content");
  }
  const lines = content.split("\n");
  const result = new Map<string, ManagedCronEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const begin = lines[index].match(BEGIN_RE);
    if (!begin) continue;
    const id = begin[1];
    const revision = Number(begin[2]);
    const commandSha256 = begin[3];
    if (!Number.isSafeInteger(revision) || result.has(id) || index + 2 >= lines.length) {
      throw new OwnerScheduleSafetyError("invalid managed cron marker");
    }
    const rawJob = lines[index + 1];
    const enabled = !rawJob.startsWith(DISABLED_PREFIX);
    const job = enabled ? rawJob : rawJob.slice(DISABLED_PREFIX.length);
    const match = job.match(/^(\S+(?:[ \t]+\S+){4})([ \t]+.+)$/);
    if (!match) throw new OwnerScheduleSafetyError("managed cron must contain exactly one job line");
    const cron = parseManagedCronExpression(match[1].replace(/[ \t]+/g, " "));
    if (sha256(match[2]) !== commandSha256) throw new OwnerScheduleSafetyError("managed cron command fingerprint mismatch");
    const end = `# ANET-MANAGED-SCHEDULE-END id=${id}`;
    if (lines[index + 2] !== end) throw new OwnerScheduleSafetyError("invalid managed cron end marker");
    result.set(id, {
      id,
      revision,
      enabled,
      cron,
      commandTail: match[2],
      commandSha256,
      beginLine: index,
      jobLine: index + 1,
      endLine: index + 2,
    });
    index += 2;
  }
  return result;
}

export function systemCrontabAdapter(): CrontabAdapter {
  return {
    read(): string {
      const result = spawnSync("crontab", ["-l"], { encoding: "utf8", maxBuffer: MAX_CRONTAB_BYTES + 1 });
      if (result.status === 0) return result.stdout;
      if (result.status === 1 && /no crontab/i.test(result.stderr || "")) return "";
      throw new OwnerScheduleSafetyError("crontab read failed");
    },
    install(content: string): void {
      const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8", maxBuffer: MAX_CRONTAB_BYTES + 1 });
      if (result.status !== 0) throw new OwnerScheduleSafetyError("crontab install failed");
    },
  };
}

function renderEdit(content: string, entry: ManagedCronEntry, patch: ExternalSchedulePatch): string {
  const lines = content.split("\n");
  const cron = patch.cron ?? entry.cron;
  const enabled = patch.enabled ?? entry.enabled;
  const job = `${cron}${entry.commandTail}`;
  lines[entry.beginLine] = `# ANET-MANAGED-SCHEDULE id=${entry.id} revision=${entry.revision + 1} command_sha256=${entry.commandSha256}`;
  lines[entry.jobLine] = enabled ? job : `${DISABLED_PREFIX}${job}`;
  return lines.join("\n");
}

export function applyOwnerScheduleIntent(options: {
  configPath: string;
  expectedNodeId: string;
  intent: ScheduleEditIntent;
  adapter?: CrontabAdapter;
}): { status: "applied"; result_revision: number; journalPath: string } {
  const { configPath, expectedNodeId, intent } = options;
  if (!configPath || !expectedNodeId || intent.node_id !== expectedNodeId || !/^sei_[0-9a-f-]+$/.test(intent.intent_id)
    || !ID_RE.test(intent.schedule_id) || !Number.isSafeInteger(intent.base_revision) || intent.base_revision < 0) {
    throw new OwnerScheduleSafetyError("invalid schedule edit intent");
  }
  const patch = parseExternalSchedulePatch(intent.patch);
  const nodeDir = dirname(configPath);
  assertPrivateDirectory(nodeDir);
  const journalPath = join(nodeDir, JOURNAL_NAME);
  const adapter = options.adapter ?? systemCrontabAdapter();
  const existingJournal = readJournal(journalPath);
  if (existingJournal) {
    if (existingJournal.intent_id !== intent.intent_id || existingJournal.schedule_id !== intent.schedule_id
      || existingJournal.base_revision !== intent.base_revision) {
      throw new OwnerScheduleSafetyError("owner schedule recovery required");
    }
    const currentHash = sha256(adapter.read());
    if (currentHash === existingJournal.after_sha256) {
      return { status: "applied", result_revision: existingJournal.result_revision, journalPath };
    }
    if (currentHash !== existingJournal.before_sha256) {
      throw new OwnerScheduleSafetyError("owner schedule recovery conflict");
    }
  }

  const before = existingJournal?.before_content ?? adapter.read();
  const entry = parseManagedCrontab(before).get(intent.schedule_id);
  if (!entry) throw new OwnerScheduleSafetyError("schedule is not managed");
  if (entry.revision !== intent.base_revision) throw new OwnerScheduleSafetyError("revision conflict");
  const after = existingJournal?.after_content ?? renderEdit(before, entry, patch);
  const journal = existingJournal ?? {
    schema: 1 as const,
    intent_id: intent.intent_id,
    schedule_id: intent.schedule_id,
    base_revision: intent.base_revision,
    result_revision: intent.base_revision + 1,
    before_sha256: sha256(before),
    after_sha256: sha256(after),
    before_content: before,
    after_content: after,
  };
  if (!existingJournal) writeJournal(journalPath, journal);
  try {
    adapter.install(after);
    if (sha256(adapter.read()) !== journal.after_sha256) throw new OwnerScheduleSafetyError("crontab readback mismatch");
    return { status: "applied", result_revision: journal.result_revision, journalPath };
  } catch (error) {
    try {
      adapter.install(before);
      if (sha256(adapter.read()) !== journal.before_sha256) throw new OwnerScheduleSafetyError("crontab rollback verification failed");
    } catch (rollbackError) {
      throw new OwnerScheduleSafetyError(`owner schedule rollback failed: ${String(rollbackError)}`);
    }
    throw error;
  }
}

/** Delete the recovery record only after Hub accepted the terminal ACK. */
export function finalizeOwnerScheduleIntent(configPath: string, expectedIntentId: string): void {
  const path = join(dirname(configPath), JOURNAL_NAME);
  const journal = readJournal(path);
  if (!journal) return;
  if (journal.intent_id !== expectedIntentId) throw new OwnerScheduleSafetyError("journal intent mismatch");
  removeJournal(path);
}

/**
 * Persist a field-minimized local audit after Hub accepted the terminal ACK.
 * Command bytes, host paths and credentials are deliberately absent.
 */
export function recordOwnerScheduleAudit(configPath: string, entry: {
  intent_id: string;
  schedule_id: string;
  base_revision: number;
  status: "applied" | "rejected";
  result_revision?: number;
  error_code?: string;
}): void {
  if (!/^sei_[0-9a-f-]+$/.test(entry.intent_id) || !ID_RE.test(entry.schedule_id)
    || !Number.isSafeInteger(entry.base_revision) || entry.base_revision < 0
    || (entry.status === "applied" && entry.result_revision !== entry.base_revision + 1)
    || (entry.status === "rejected" && entry.result_revision !== undefined)
    || (entry.error_code !== undefined && !/^[a-z0-9_]{1,64}$/.test(entry.error_code))) {
    throw new OwnerScheduleSafetyError("invalid owner schedule audit entry");
  }
  const parent = dirname(configPath);
  assertPrivateDirectory(parent);
  const path = join(parent, AUDIT_NAME);
  let existing = "";
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || uid === undefined || stat.uid !== uid
      || (stat.mode & 0o177) !== 0 || stat.size > MAX_AUDIT_BYTES) {
      throw new OwnerScheduleSafetyError("owner schedule control refuses unsafe audit log");
    }
    existing = readFileSync(path, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  // ACK retry after a crash between audit fsync and journal deletion is
  // idempotent. Match the exact JSON field, not a substring of another id.
  if (existing.split("\n").some((line) => {
    try { return JSON.parse(line)?.intent_id === entry.intent_id; } catch { return false; }
  })) return;
  const line = JSON.stringify({ schema: 1, ...entry, recorded_at: new Date().toISOString() }) + "\n";
  if (Buffer.byteLength(existing) + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
    throw new OwnerScheduleSafetyError("owner schedule audit log full");
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || uid === undefined || stat.uid !== uid || (stat.mode & 0o177) !== 0) {
      throw new OwnerScheduleSafetyError("owner schedule control refuses unsafe audit log");
    }
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function managedCronInventory(adapter: CrontabAdapter = systemCrontabAdapter()): Map<string, Pick<ManagedCronEntry, "cron" | "enabled" | "revision">> {
  const result = new Map<string, Pick<ManagedCronEntry, "cron" | "enabled" | "revision">>();
  for (const [id, entry] of parseManagedCrontab(adapter.read())) {
    result.set(id, { cron: entry.cron, enabled: entry.enabled, revision: entry.revision });
  }
  return result;
}
