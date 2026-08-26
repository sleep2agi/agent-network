import { createHash } from "crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { join, sep } from "path";

export interface CodexRecoveryVerification {
  method: "thread/start" | "thread/resume";
  threadId: string;
  verifiedAt: string;
  historyTurnCount: number;
  historyFingerprint: string;
}

export interface CodexRecoveryBackup {
  backupDir: string;
  createdAt: string;
  stateFiles: string[];
}

const SESSION_STATE_NAMES = new Set(["sessions", "history.jsonl", "state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"]);

/** Transaction boundary shared by Windows and POSIX cutovers: the snapshot
 * cannot begin until every authoritative state writer has quiesced. */
export async function quiesceThenSnapshot<T>(quiesce: () => Promise<void>, snapshot: () => T): Promise<T> {
  await quiesce();
  return snapshot();
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function redactRecoveryConfig(value: unknown, key = ""): unknown {
  if (/token|secret|password|authorization|auth/i.test(key)) return "[REDACTED]";
  if (typeof value === "string" && /^(?:ntok_|utok_|atok_|sk-|Bearer\s)/i.test(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((child) => redactRecoveryConfig(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactRecoveryConfig(child, childKey)]));
  }
  return value;
}

/** A stored thread is never considered resumed until app-server reads the
 * exact thread back with persisted history. This is deliberately stricter
 * than accepting a successful thread/resume RPC response. */
export function verifyCodexThreadHistory(
  method: "thread/start" | "thread/resume",
  expectedThreadId: string,
  readResult: unknown,
  now = new Date(),
): CodexRecoveryVerification {
  const thread = (readResult as any)?.thread;
  if (!thread || thread.id !== expectedThreadId) {
    throw new Error(`thread/read identity mismatch: expected ${expectedThreadId}`);
  }
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (turns.length === 0) {
    throw new Error(`thread/read returned no persisted history for ${expectedThreadId}`);
  }
  return {
    method,
    threadId: expectedThreadId,
    verifiedAt: now.toISOString(),
    historyTurnCount: turns.length,
    historyFingerprint: hashJson(turns.map((turn: any) => ({ id: turn?.id ?? null, status: turn?.status ?? null }))),
  };
}

export async function resumeAndVerifyCodexThread(
  threadId: string,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<CodexRecoveryVerification> {
  await request("thread/resume", { threadId });
  const read = await request("thread/read", { threadId, includeTurns: true });
  return verifyCodexThreadHistory("thread/resume", threadId, read);
}

/** Private, node-local recovery point. config-recovery.json is deliberately
 * redacted non-credential audit/recovery metadata, not an identity backup.
 * Identity recovery relies on leaving the original node config and CODEX_HOME
 * in place. Credentials are never copied into this snapshot. */
export function backupCodexRecoveryState(opts: {
  nodeDir: string;
  codexHome: string;
  now?: Date;
}): CodexRecoveryBackup {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupDir = join(opts.nodeDir, "recovery", stamp);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configPath = join(opts.nodeDir, "config.json");
  if (!existsSync(configPath)) throw new Error(`missing node config: ${configPath}`);
  const rawConfig = readFileSync(configPath);
  const parsedConfig = JSON.parse(rawConfig.toString("utf8"));
  const recoveryConfigPath = join(backupDir, "config-recovery.json");
  writeFileSync(recoveryConfigPath, JSON.stringify(redactRecoveryConfig(parsedConfig), null, 2), { mode: 0o600 });
  chmodSync(recoveryConfigPath, 0o600);

  const stateDir = join(backupDir, "codex-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFiles: string[] = [];
  const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];
  const codexRoot = existsSync(opts.codexHome) ? realpathSync(opts.codexHome) : opts.codexHome;
  const copyStateTree = (source: string, target: string, relativePath: string) => {
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error(`recovery snapshot refuses symlink: ${relativePath}`);
    const resolved = realpathSync(source);
    if (resolved !== codexRoot && !resolved.startsWith(codexRoot + sep)) {
      throw new Error(`recovery snapshot path escapes CODEX_HOME: ${relativePath}`);
    }
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const child of readdirSync(source)) copyStateTree(join(source, child), join(target, child), join(relativePath, child));
      return;
    }
    if (!info.isFile()) throw new Error(`recovery snapshot refuses non-file state: ${relativePath}`);
    copyFileSync(source, target);
    const copied = readFileSync(target);
    manifestFiles.push({ path: relativePath, size: copied.length, sha256: createHash("sha256").update(copied).digest("hex") });
  };
  if (existsSync(opts.codexHome)) {
    for (const name of readdirSync(opts.codexHome)) {
      if (!SESSION_STATE_NAMES.has(name)) continue;
      const source = join(opts.codexHome, name);
      const target = join(stateDir, name);
      copyStateTree(source, target, name);
      stateFiles.push(name);
    }
  }
  const manifest = {
    createdAt: now.toISOString(),
    configSha256: createHash("sha256").update(rawConfig).digest("hex"),
    stateFiles: manifestFiles.sort((a, b) => a.path.localeCompare(b.path)),
    credentialsIncluded: false,
  };
  writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { backupDir, createdAt: now.toISOString(), stateFiles };
}

export function codexTopologyAudit(profile: Record<string, any>, nodeDir: string, cwd: string) {
  return {
    launchMode: profile.codexCopresence ? "managed-copresence" : "headless",
    cwd,
    codexHome: join(nodeDir, "codex-home"),
    remote: profile.codexAppServerUrl ?? null,
    threadId: profile.codexThreadId ?? null,
    model: profile.model ?? null,
    flags: profile.flags ?? {},
    lastRecoveryVerification: profile.codexRecoveryVerification ?? null,
    lastRecoveryBackup: profile.codexRecoveryBackup
      ? { createdAt: profile.codexRecoveryBackup.createdAt, stateFiles: profile.codexRecoveryBackup.stateFiles }
      : null,
  };
}
