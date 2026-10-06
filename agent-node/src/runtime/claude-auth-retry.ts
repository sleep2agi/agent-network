/**
 * Board #672 — Claude Code retries a dead key inside the CLI, before
 * agent-node's own loop can see the error. SDK 0.3.289 puts the HTTP
 * status on `system/api_retry` (`error_status`). Abort only that auth
 * class. 429 / 5xx / billing stay on the CLI's retries and then #656.
 */

export const CLAUDE_AUTH_USER_TEXT = "执行出错: Claude 登录或 key 失效，请重新登录";
export const CLAUDE_LOGIN_STATUS_HINT = "Claude 登录已失效，请重新登录";

const CAPACITY_ERRORS = new Set(["rate_limit", "overloaded", "server_error", "billing_error"]);

export interface ClaudeApiRetryLike {
  type?: string;
  subtype?: string;
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
