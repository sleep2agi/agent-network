import { statSync } from "fs";
import { findThreadRollouts } from "./codex-pending-thread-restart";

export const CODEX_RESUME_TIMEOUT_ENV = "ANET_CODEX_RESUME_TIMEOUT_MS";
export const CODEX_RESUME_BASE_TIMEOUT_MS = 300_000;
export const CODEX_RESUME_PER_GIB_MS = 120_000;
export const CODEX_RESUME_MAX_TIMEOUT_MS = 15 * 60_000;
export const CODEX_RECOVERY_MIN_PAYLOAD_BYTES = 128 * 1024 ** 2;
export const CODEX_RECOVERY_PAYLOAD_OVERHEAD_BYTES = 64 * 1024 ** 2;
export const CODEX_RECOVERY_MAX_PAYLOAD_BYTES = 1536 * 1024 ** 2;

export interface CopresenceResumeBudget {
  timeoutMs: number;
  rolloutBytes: number | null;
}

/** `--new-session` is authoritative for co-presence too: never feed the
 * recorded thread into thread/resume when the operator explicitly asked for
 * a fresh conversation. */
export function codexThreadIdForStart(
  recordedThreadId: string | undefined,
  newSession: boolean,
): string | undefined {
  return newSession ? undefined : recordedThreadId;
}

/** Resolve the recovery deadline once, before opening the app-server socket.
 * The automatic budget is 300 s plus 120 s for each started GiB of the exact
 * recorded rollout, capped at 15 minutes. An explicit environment value wins. */
export function resolveCopresenceResumeBudget(
  codexHome: string,
  threadId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): CopresenceResumeBudget {
  let rolloutBytes: number | null = null;
  if (threadId) {
    const matches = findThreadRollouts(codexHome, threadId);
    if (matches?.length === 1) {
      try { rolloutBytes = statSync(matches[0]).size; } catch { /* diagnostic stays unavailable */ }
    }
  }
  const configured = env[CODEX_RESUME_TIMEOUT_ENV];
  if (configured !== undefined && configured !== "") {
    if (/^[1-9]\d*$/.test(configured)) {
      const parsed = Number(configured);
      if (Number.isSafeInteger(parsed) && parsed <= CODEX_RESUME_MAX_TIMEOUT_MS) return { timeoutMs: parsed, rolloutBytes };
    }
    warn(`[anet] ignoring invalid ${CODEX_RESUME_TIMEOUT_ENV}=${JSON.stringify(configured)}; expected whole milliseconds from 1 to ${CODEX_RESUME_MAX_TIMEOUT_MS}`);
  }
  const gib = rolloutBytes === null ? 0 : Math.ceil(rolloutBytes / (1024 ** 3));
  return {
    timeoutMs: Math.min(CODEX_RESUME_MAX_TIMEOUT_MS, CODEX_RESUME_BASE_TIMEOUT_MS + gib * CODEX_RESUME_PER_GIB_MS),
    rolloutBytes,
  };
}

export function resolveCopresenceResumeTimeoutMs(
  codexHome: string,
  threadId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): number {
  return resolveCopresenceResumeBudget(codexHome, threadId, env, warn).timeoutMs;
}

export function formatCopresenceRolloutSize(bytes: number | null): string {
  return bytes === null ? "rollout size unavailable" : `rollout ${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A finite receive ceiling for the one large thread/resume frame emitted by
 * older Codex app-servers. Twice the rollout plus protocol headroom covers the
 * measured JSON expansion without giving the loopback peer an unlimited heap. */
export function resolveCopresenceMaxPayloadBytes(rolloutBytes: number | null): number {
  const derived = rolloutBytes === null
    ? CODEX_RECOVERY_MIN_PAYLOAD_BYTES
    : rolloutBytes * 2 + CODEX_RECOVERY_PAYLOAD_OVERHEAD_BYTES;
  return Math.min(
    CODEX_RECOVERY_MAX_PAYLOAD_BYTES,
    Math.max(CODEX_RECOVERY_MIN_PAYLOAD_BYTES, Math.ceil(derived)),
  );
}

/** The bridge can make one retry after a resume timeout, so launcher readiness
 * covers both bounded attempts instead of killing it at the old fixed 25 s. */
export function resolveCopresenceBridgeAttachTimeoutMs(resumeTimeoutMs: number): number {
  return resumeTimeoutMs * 2 + 10_000;
}
