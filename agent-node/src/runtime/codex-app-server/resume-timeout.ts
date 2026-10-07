// Startup `thread/resume` deadline for the codex-app-server bridge.
//
// The bridge resumes its persistent thread before it can take any task, and
// that request used to ride the JSON-RPC client's generic 30 s default. On a
// thread with a very large rollout (a field report: ~950 MB, the app-server
// read ~1.09 GB in 30 s while replaying it) the resume took ~24 s on one
// start and >30 s on the next — a race, not a hard failure. On timeout the
// node exited after it had already registered with the hub, so the hub kept
// showing it idle while nothing consumed its tasks.
//
// Default 300 s: field evidence shows even 0.26–0.78 GiB threads can exceed
// 60 s during a cold Codex start. The same budget governs the co-presence
// "wait for the TUI's thread to materialize" path. Operators with even larger
// threads can raise it (the launcher also derives a size-aware budget).
import { statSync } from "node:fs";
import { codexSessionsRoot, findCodexRolloutFile } from "../codex-thread-size-check";
import { resolveTimeoutEnvMs } from "./timeout-env";

export const RESUME_TIMEOUT_ENV = "ANET_CODEX_RESUME_TIMEOUT_MS";
export const DEFAULT_RESUME_TIMEOUT_MS = 300_000;
export const RECOVERY_MAX_PAYLOAD_ENV = "ANET_CODEX_RECOVERY_MAX_PAYLOAD_BYTES";
export const RECOVERY_MIN_PAYLOAD_BYTES = 128 * 1024 ** 2;
export const RECOVERY_MAX_PAYLOAD_BYTES = 1536 * 1024 ** 2;
/** Total resume attempts on timeout (1 retry). A retry usually lands on a thread the app-server finished loading meanwhile. */
export const DEFAULT_RESUME_ATTEMPTS = 2;
const warnedValues = new Set<string>();

/** Startup resume deadline from `ANET_CODEX_RESUME_TIMEOUT_MS`; same rules as ANET_QUEUE_TIMEOUT_MS. */
export function resolveResumeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): number {
  return resolveTimeoutEnvMs(RESUME_TIMEOUT_ENV, env[RESUME_TIMEOUT_ENV], DEFAULT_RESUME_TIMEOUT_MS, warnedValues, warn);
}

/** Test hook: forget which bad values were already warned about. */
export function resetResumeTimeoutWarnings(): void {
  warnedValues.clear();
}

/** Strictly consume the finite launcher-computed receive ceiling. Standalone
 * bridges derive the same bound from the exact rollout on disk. */
export function resolveRecoveryMaxPayloadBytes(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env[RECOVERY_MAX_PAYLOAD_ENV];
  if (configured && /^[1-9]\d*$/.test(configured)) {
    const parsed = Number(configured);
    if (Number.isSafeInteger(parsed) && parsed >= RECOVERY_MIN_PAYLOAD_BYTES && parsed <= RECOVERY_MAX_PAYLOAD_BYTES) return parsed;
  }
  try {
    const path = findCodexRolloutFile(codexSessionsRoot(env), threadId);
    const bytes = path ? statSync(path).size : 0;
    return Math.min(RECOVERY_MAX_PAYLOAD_BYTES, Math.max(RECOVERY_MIN_PAYLOAD_BYTES, bytes * 2 + 64 * 1024 ** 2));
  } catch {
    return RECOVERY_MIN_PAYLOAD_BYTES;
  }
}

/** "(rollout 908.8 MB)" for log lines, or "" when the rollout can't be found cheaply. */
export function describeRolloutSize(threadId: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const path = findCodexRolloutFile(codexSessionsRoot(env), threadId);
    if (!path) return "";
    const bytes = statSync(path).size;
    return ` (rollout ${(bytes / 1024 / 1024).toFixed(1)} MB)`;
  } catch {
    return "";
  }
}
