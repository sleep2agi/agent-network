import { statSync } from "fs";
import { findThreadRollouts } from "./codex-pending-thread-restart";

export const CODEX_RESUME_TIMEOUT_ENV = "ANET_CODEX_RESUME_TIMEOUT_MS";
export const CODEX_RESUME_BASE_TIMEOUT_MS = 60_000;
export const CODEX_RESUME_PER_GIB_MS = 120_000;
export const CODEX_RESUME_MAX_TIMEOUT_MS = 15 * 60_000;

/** Resolve the recovery deadline once, before opening the app-server socket.
 * The automatic budget is 60 s plus 120 s for each started GiB of the exact
 * recorded rollout, capped at 15 minutes. An explicit environment value wins. */
export function resolveCopresenceResumeTimeoutMs(
  codexHome: string,
  threadId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(message),
): number {
  const configured = env[CODEX_RESUME_TIMEOUT_ENV];
  if (configured !== undefined && configured !== "") {
    if (/^[1-9]\d*$/.test(configured)) {
      const parsed = Number(configured);
      if (Number.isSafeInteger(parsed) && parsed <= CODEX_RESUME_MAX_TIMEOUT_MS) return parsed;
    }
    warn(`[anet] ignoring invalid ${CODEX_RESUME_TIMEOUT_ENV}=${JSON.stringify(configured)}; expected whole milliseconds from 1 to ${CODEX_RESUME_MAX_TIMEOUT_MS}`);
  }
  if (!threadId) return CODEX_RESUME_BASE_TIMEOUT_MS;
  const matches = findThreadRollouts(codexHome, threadId);
  if (!matches || matches.length !== 1) return CODEX_RESUME_BASE_TIMEOUT_MS;
  try {
    const bytes = statSync(matches[0]).size;
    const gib = Math.ceil(bytes / (1024 ** 3));
    return Math.min(CODEX_RESUME_MAX_TIMEOUT_MS, CODEX_RESUME_BASE_TIMEOUT_MS + gib * CODEX_RESUME_PER_GIB_MS);
  } catch {
    return CODEX_RESUME_BASE_TIMEOUT_MS;
  }
}
