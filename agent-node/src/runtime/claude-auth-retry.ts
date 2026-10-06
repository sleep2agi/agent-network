/**
 * Board #672 — Claude Code retries a dead key inside the CLI, before
 * agent-node's own loop can see the error. SDK 0.3.289 puts the HTTP
 * status on `system/api_retry` (`error_status`).
 *
 * Abort only an auth-class retry, and not the first one. The CLI emits
 * `api_retry` attempt 1 and only then refreshes OAuth, apiKeyHelper, or
 * the host token. Several claude processes share one credentials file;
 * a stale access token 401s once and the next attempt succeeds. The long
 * stall (~10 retries) is the static-key path. Waiting until attempt >= 2
 * still cuts that stall after one backoff, and it does not have to guess
 * which credential the CLI used — env can carry a key and a credentials
 * file at the same time. 429 / 5xx / billing stay on the CLI's retries
 * and then #656.
 */

export const CLAUDE_AUTH_USER_TEXT = "执行出错: Claude 登录或 key 失效，请重新登录";
export const CLAUDE_LOGIN_STATUS_HINT = "Claude 登录已失效，请重新登录";

const CAPACITY_ERRORS = new Set(["rate_limit", "overloaded", "server_error", "billing_error"]);

export interface ClaudeApiRetryLike {
  type?: string;
  subtype?: string;
  attempt?: number | null;
  error_status?: number | null;
  error?: string | null;
  no_response?: unknown;
}

/** True only for a login/key failure the CLI is about to retry. */
export function claudeApiRetryIsAuthFailure(message: ClaudeApiRetryLike): boolean {
  if (!message || message.type !== "system" || message.subtype !== "api_retry") return false;
  // First-byte timeout. The SDK gives it its own retry cap; it is not auth.
  if (message.no_response != null) return false;
  const error = typeof message.error === "string" ? message.error : "";
  const status = typeof message.error_status === "number" ? message.error_status : null;
  const capacity = CAPACITY_ERRORS.has(error)
    || status === 429
    || status === 529
    || (status != null && status >= 500 && status <= 599);
  if (capacity) return false;
  if (error === "authentication_failed" || status === 401 || status === 403) return true;
  return false;
}

export type ClaudeAuthRetryDecision =
  | { action: "continue" }
  | { action: "abort"; userText: string; markLoginDead: true };

/**
 * What the message loop should do with one SDK message.
 * Attempt 1 is the refresh chance. Attempt >= 2 is a key that did not recover.
 */
export function claudeAuthRetryDecision(message: ClaudeApiRetryLike): ClaudeAuthRetryDecision {
  if (!claudeApiRetryIsAuthFailure(message)) return { action: "continue" };
  const attempt = typeof message.attempt === "number" ? message.attempt : 0;
  if (attempt >= 2) {
    return { action: "abort", userText: CLAUDE_AUTH_USER_TEXT, markLoginDead: true };
  }
  return { action: "continue" };
}

/**
 * SDK 0.3.289 throws `Claude Code returned an error result: ${result}`.
 * That prefix is 38 characters. With `Failed to authenticate. API Error: 403 `
 * it fills an 80-character slice, so the user saw `403 Req` / `403 You` and
 * not the reason. Drop the prefix, then keep the vendor sentence.
 */
const CLAUDE_CODE_ERROR_RESULT_PREFIX = "Claude Code returned an error result: ";

const CLAUDE_VENDOR_KEY_SUFFIX =
  "refresh API key and re-export ENV var; see agent-node log for vendor-specific URL";

/**
 * A region block or a permission denial is not a dead key. The vendor
 * sentence already says which. Telling the operator to refresh the key
 * sends them at the wrong fix. A revoked credential still uses the key suffix.
 */
function claudeVendorAuthSuffix(detail: string): string {
  const region = /request not allowed/i.test(detail);
  const permission = /does not have permission/i.test(detail);
  if ((region || permission) && !/revoked/i.test(detail)) {
    return "see agent-node log for the vendor reason";
  }
  return CLAUDE_VENDOR_KEY_SUFFIX;
}

/** Same shape cli.ts used before #672. The raw vendor text stays in the reply. */
export function claudeVendorAuthUserText(message: string): string {
  const detail = message.startsWith(CLAUDE_CODE_ERROR_RESULT_PREFIX)
    ? message.slice(CLAUDE_CODE_ERROR_RESULT_PREFIX.length)
    : message;
  const shown = detail.slice(0, 200);
  return `执行出错: vendor API auth failed (${shown}) — ${claudeVendorAuthSuffix(shown)}`;
}

/** Thrown CLI text, not an api_retry. Kept in one place so the catch branch is testable. */
export function claudeMessageLooksLikeAuthError(message: string): boolean {
  if (!message) return false;
  return /(401|403)\b|invalid[_\s]?api[_\s]?key|authentication[_\s]?error|expired[_\s]?token|unauthor(iz|is)ed|A02\d{2}|user[_\s]?token[_\s]?expired/i.test(message);
}

export type ClaudeThrownDisposition =
  | { action: "fallthrough" }
  | { action: "stop"; userText: string; markLoginDead: boolean };

/**
 * Catch-path decision. An abort that rejects the stream must win before any
 * 403 classification, or a region/permission error thrown during shutdown
 * would replace the login result and skip the sticky status.
 * A 403 marks the node only when the text says the credential was revoked.
 * Region blocks and permission errors keep the vendor sentence and the
 * previous node status.
 */
export function claudeThrownErrorDisposition(message: string, authAbortedThisAttempt: boolean): ClaudeThrownDisposition {
  if (authAbortedThisAttempt) {
    return { action: "stop", userText: CLAUDE_AUTH_USER_TEXT, markLoginDead: false };
  }
  if (!claudeMessageLooksLikeAuthError(message)) return { action: "fallthrough" };
  const has401 = /(401)\b/.test(message);
  const has403 = /(403)\b/.test(message);
  const markLoginDead = has401 || (has403 && /revoked/i.test(message));
  return { action: "stop", userText: claudeVendorAuthUserText(message), markLoginDead };
}

/**
 * What `report_status` should send after a Claude login failure.
 *
 * The running task description stays. A caller-supplied task (the in-flight
 * text, or a #656 progress line) is sent as-is. While something is still
 * in flight, `task` is left untouched so the hub COALESCE keeps it.
 * Only an idle report with no caller text publishes the hint, and the
 * status becomes `error` so the node card shows it. Same shape as the
 * codex login gate: working is not rewritten.
 */
export function claudeAuthStatusReport(input: {
  status: string;
  task: string | undefined;
  callerTask?: string;
  inFlight: number;
  loginDead: boolean;
}): { status: string; task: string | undefined } {
  if (!input.loginDead) return { status: input.status, task: input.task };
  if (input.callerTask != null && input.callerTask !== "") {
    return { status: input.status, task: input.task };
  }
  if (input.inFlight > 0) return { status: input.status, task: input.task };
  if (input.status !== "idle" && input.status !== "error") {
    return { status: input.status, task: input.task };
  }
  return { status: "error", task: CLAUDE_LOGIN_STATUS_HINT };
}
