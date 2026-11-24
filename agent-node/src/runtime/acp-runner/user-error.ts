/**
 * User-facing ACP error normalizer (shared by antigravity-acp and grok-build-acp).
 *
 * Raw JSON-RPC / CLI errors stay on `err.message` for node logs (`error("✗ ...")`),
 * while recognized error shapes attach a concise, actionable Chinese sentence on
 * `err.userReplyText` (consumed verbatim by `runtimeErrorReplyText`).
 *
 * Rules:
 * - Only match error texts we have observed verbatim in real runs or fixtures.
 * - Never leak protocol jargon (`-32603`, `ACP`, raw JSON) or the wrong runtime name
 *   into user-facing replies.
 * - Return `null` for unrecognized errors so callers fall back without guessing.
 */

export interface AcpErrorLike {
  message?: unknown;
  code?: unknown;
  data?: unknown;
  userReplyText?: unknown;
}

const NOT_LOGGED_IN_RE =
  /(No browser is available here|Run\s+`?agy acp --login`?|Please (?:sign|log)\s?in to view available models|Launch the CLI without arguments to sign in|ACP authenticate failed:\s*no supported non-interactive auth method)/i;

const MISSING_CLI_RE = /\bspawn\s+\S+\s+ENOENT\b/i;

const BALANCE_EXHAUSTED_RE = /402\s*Payment\s*Required|usage balance exhausted/i;

const NETWORK_REQWEST_RE = /reqwest error\b[^\n]*error sending request for url/i;

function displayNameFor(runtimeLabel: string): string {
  if (runtimeLabel === "antigravity") return "Antigravity";
  if (runtimeLabel === "grok") return "Grok";
  return runtimeLabel;
}

function cliCommandFor(runtimeLabel: string): string {
  if (runtimeLabel === "antigravity") return "agy";
  if (runtimeLabel === "grok") return "grok";
  return runtimeLabel;
}

function loginCommandFor(runtimeLabel: string): string {
  if (runtimeLabel === "antigravity") return "agy acp --login";
  if (runtimeLabel === "grok") return "grok login";
  return `${runtimeLabel} login`;
}

function collectErrorDetail(err: unknown): { code?: unknown; message: string; dataText: string; httpStatus?: number } {
  if (!err || typeof err !== "object") {
    return { message: String(err ?? ""), dataText: "" };
  }
  const e = err as AcpErrorLike;
  const message = typeof e.message === "string" ? e.message : String(err);
  let dataText = "";
  let httpStatus: number | undefined;
  if (typeof e.data === "string") {
    dataText = e.data;
  } else if (e.data && typeof e.data === "object" && !Array.isArray(e.data)) {
    const rec = e.data as Record<string, unknown>;
    if (typeof rec.http_status === "number") httpStatus = rec.http_status;
    else if (typeof rec.status_code === "number") httpStatus = rec.status_code;
    if (typeof rec.message === "string") dataText = rec.message;
    else {
      try { dataText = JSON.stringify(rec); } catch { dataText = String(rec); }
    }
  }
  return { code: e.code, message, dataText, httpStatus };
}

/**
 * Pure mapper from a raw ACP runtime error to a short, plain-Chinese user reply
 * with an actionable next step. Returns `null` when the error is not a recognized
 * verbatim pattern.
 */
export function formatAcpUserError(runtimeLabel: string, err: unknown): string | null {
  const { code, message, dataText, httpStatus } = collectErrorDetail(err);
  const combined = dataText ? `${message}\n${dataText}` : message;
  const name = displayNameFor(runtimeLabel);
  const cli = cliCommandFor(runtimeLabel);

  // 1. Not logged in (verbatim from agy acp -32603 / agy models / selectAuthMethod).
  if (NOT_LOGGED_IN_RE.test(combined)) {
    return `这台机器上的 ${name} 还没有登录。请在那台机器的终端里运行 \`${loginCommandFor(runtimeLabel)}\` 完成登录，然后再发一次。`;
  }

  // 2. CLI binary missing (Node spawn ENOENT or readiness missingBinary).
  if (code === "ENOENT" || MISSING_CLI_RE.test(combined)) {
    return `这台机器上找不到 ${name} 程序。请确认已安装，再发一次。`;
  }

  // 3. Account quota / balance exhausted (verbatim #1941 / #1976 402 shape).
  if (httpStatus === 402 || BALANCE_EXHAUSTED_RE.test(combined)) {
    if (runtimeLabel === "grok") {
      return "这台机器上 Grok 账号的额度已经用完了。请充值或换一个还有额度的账号，然后再发一次。";
    }
    return `这台机器上 ${name} 账号的额度已经用完了。请检查账号额度或切换账号，然后再发一次。`;
  }

  // 4. Network unreachable (verbatim reqwest transport error from Grok ACP).
  if (NETWORK_REQWEST_RE.test(combined)) {
    return `这台机器暂时连不上 ${name} 服务。请检查这台机器的网络或代理设置，然后再发一次。`;
  }

  return null;
}

/**
 * Attach `userReplyText` onto an error object when `formatAcpUserError` recognizes it,
 * preserving the original `err.message` intact for node logs.
 */
export function attachAcpUserReplyText<T>(err: T, runtimeLabel: string): T {
  if (!err || typeof err !== "object") return err;
  const target = err as AcpErrorLike;
  if (typeof target.userReplyText === "string" && target.userReplyText.trim()) return err;
  const friendly = formatAcpUserError(runtimeLabel, err);
  if (friendly) {
    target.userReplyText = friendly;
  }
  return err;
}
