import { createHash } from "crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "fs";
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
const RECOVERY_COPY_CHUNK_BYTES = 4 * 1024 * 1024;

/** Transaction boundary shared by Windows and POSIX cutovers: the snapshot
 * cannot begin until every authoritative state writer has quiesced. */
export async function quiesceThenSnapshot<T>(quiesce: () => Promise<void>, snapshot: () => T): Promise<T> {
  await quiesce();
  return snapshot();
}

/** A recovery point is defense-in-depth: failure must be visible, but must not
 * strand a quiesced node before its replacement runtime can start. */
export function bestEffortCodexRecoveryPoint(
  snapshot: () => void,
  warn: (message: string) => void,
): boolean {
  try {
    snapshot();
    return true;
  } catch (error) {
    warn(`[anet] ⚠ skipped Codex recovery-point backup: ${(error as Error)?.message || error}`);
    warn("[anet]    Startup will continue with the original CODEX_HOME unchanged; no backup was recorded.");
    return false;
  }
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

/** Copy and hash without ever materializing the whole file in a Buffer.
 * Zero chunks are sought over and the final length is truncated explicitly,
 * so a multi-GiB sparse rollout stays sparse in the private recovery point. */
export function copyAndHashRecoveryFile(source: string, target: string): { size: number; sha256: string } {
  const input = openSync(source, "r");
  let output: number | undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(RECOVERY_COPY_CHUNK_BYTES);
  let offset = 0;
  try {
    output = openSync(target, "wx", 0o600);
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      let allZero = true;
      for (let i = 0; i < count; i += 1) {
        if (chunk[i] !== 0) { allZero = false; break; }
      }
      if (!allZero) {
        let written = 0;
        while (written < count) written += writeSync(output, chunk, written, count - written, offset + written);
      }
      offset += count;
    }
    ftruncateSync(output, offset);
    chmodSync(target, 0o600);
    return { size: offset, sha256: hash.digest("hex") };
  } catch (error) {
    try { if (output !== undefined) closeSync(output); } catch { /* best effort */ }
    output = undefined;
    try { unlinkSync(target); } catch { /* best effort */ }
    throw error;
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
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
  const hasTurns = Object.prototype.hasOwnProperty.call(thread, "turns");
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (hasTurns && turns.length === 0) {
    throw new Error(`thread/read returned no persisted history for ${expectedThreadId}`);
  }
  return {
    method,
    threadId: expectedThreadId,
    verifiedAt: now.toISOString(),
    historyTurnCount: turns.length,
    historyFingerprint: hasTurns
      ? hashJson(turns.map((turn: any) => ({ id: turn?.id ?? null, status: turn?.status ?? null })))
      : hashJson({ threadId: expectedThreadId, metadataOnly: true }),
  };
}

/**
 * #512 — `model` is the node's resolved model. It MUST ride on thread/resume:
 * measured on codex 0.155 (Docker), a resume without it puts the thread back on
 * the model recorded in the rollout's last turn_context and ignores the
 * app-server's `-c model=`. This launcher is the first client to load the
 * thread, and once loaded, later resumes without a model (the bridge's) keep
 * whatever the first one set — so this is the request that decides the model
 * for every subsequent turn: the configured model wins over the thread's
 * recorded one.
 *
 * Returns the model the app-server reports for the resumed thread (if any) so
 * the caller can say which model the session is actually on.
 */
export async function resumeAndVerifyCodexThread(
  threadId: string,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  model?: string,
): Promise<CodexRecoveryVerification & { resumedModel?: string }> {
  const params: Record<string, unknown> = { threadId, excludeTurns: true };
  if (typeof model === "string" && model.trim()) params.model = model.trim();
  let resumed: unknown;
  try {
    resumed = await request("thread/resume", params);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const message = String((error as { message?: unknown })?.message ?? error);
    if (code !== -32602 && !/excludeTurns.*(?:unknown|unsupported|invalid)|(?:unknown|unsupported).*excludeTurns/i.test(message)) throw error;
    delete params.excludeTurns;
    resumed = await request("thread/resume", params);
  }
  const read = await request("thread/read", { threadId, includeTurns: false });
  const verification = verifyCodexThreadHistory("thread/resume", threadId, read);
  const resumedModel = (resumed as { model?: unknown } | null)?.model;
  return typeof resumedModel === "string" ? { ...verification, resumedModel } : verification;
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
    const copied = copyAndHashRecoveryFile(source, target);
    manifestFiles.push({ path: relativePath, ...copied });
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
