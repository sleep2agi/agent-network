import { createHash } from "crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";

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

/** Private, node-local recovery point. The exact config is retained for
 * rollback with mode 0600; reports/logs receive only filenames and hashes.
 * CODEX_HOME credentials are intentionally excluded. */
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
  if (existsSync(opts.codexHome)) {
    for (const name of readdirSync(opts.codexHome)) {
      if (!SESSION_STATE_NAMES.has(name)) continue;
      const source = join(opts.codexHome, name);
      const target = join(stateDir, name);
      cpSync(source, target, { recursive: lstatSync(source).isDirectory(), preserveTimestamps: true });
      stateFiles.push(name);
    }
  }
  const manifest = {
    createdAt: now.toISOString(),
    configSha256: createHash("sha256").update(rawConfig).digest("hex"),
    stateFiles: stateFiles.map((name) => ({ name: basename(name), size: statSync(join(stateDir, name)).size })),
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
