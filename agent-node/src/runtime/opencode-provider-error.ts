/**
 * #540 — an OpenCode turn can end with the model call itself failing
 * (provider HTTP error, auth error, Zen free-tier rejection, abort, ...).
 * OpenCode still returns an assistant message for that turn; the failure is
 * recorded on `message.info.error` and the message usually has no text parts.
 * Reading only the parts made such a turn look like a successful empty reply
 * (`[opencode: assistant returned no reply]`, task `replied`).
 *
 * OpenCode 1.18.1 `AssistantMessage.error` is a named union, e.g.
 *   { name: "APIError", data: { message, statusCode, isRetryable, ... } }
 *   { name: "ProviderAuthError", data: { providerID, message } }
 *   { name: "UnknownError", data: { message } }
 *   { name: "MessageAbortedError", data: { message } }
 *   { name: "MessageOutputLengthError", data: {} }
 * Everything here is read defensively: any truthy `error` means the turn
 * failed, whatever its shape.
 */

/** Upstream wording of the OpenCode Zen free-tier rejection. */
export const OPENCODE_FREE_TIER_REJECTION_PATTERN = /free tier can only be used from within OpenCode/i;

export const OPENCODE_FREE_TIER_SAFE_PRESET_HINT =
  "OpenCode Zen 免费模型拒绝了本次请求：免费档只接受未收紧工具的请求，而本节点用的是默认安全预设（关闭了全部本机工具）。" +
  "二选一：① 在节点 config.json 里设 flags.opencodeUnsafeTools=true 后重启节点（会打开本机工具，仅用于可信任务，不是沙箱）；" +
  "② 换成带 key 的模型（anet opencode auth-login <节点> --provider <provider>，再 anet node edit <节点> --model <provider/model>）。";

export interface OpenCodeTurnError {
  name: string;
  message: string;
}

/** The turn's failure, or null when `message.info.error` is absent/falsy. */
export function openCodeTurnError(message: any): OpenCodeTurnError | null {
  const error = message?.info?.error;
  if (!error) return null;
  if (typeof error === "string") return { name: "Error", message: error };
  const name = typeof error?.name === "string" && error.name ? error.name : "Error";
  const candidates = [error?.data?.message, error?.message, error?.data?.responseBody];
  let text = candidates.find((c) => typeof c === "string" && c.trim()) as string | undefined;
  if (!text) {
    try { text = JSON.stringify(error); } catch { text = String(error); }
  }
  return { name, message: text.trim() };
}

export function isOpenCodeFreeTierRejection(text: string): boolean {
  return OPENCODE_FREE_TIER_REJECTION_PATTERN.test(text);
}

export class OpenCodeProviderError extends Error {
  readonly code = "opencode_provider_error";
  readonly upstreamName: string;
  readonly upstreamMessage: string;
  readonly freeTierRejected: boolean;
  /** Text the model produced before the failure, if any. */
  readonly partialReplyText: string;
  constructor(turnError: OpenCodeTurnError, partialReplyText = "") {
    const freeTierRejected = isOpenCodeFreeTierRejection(turnError.message);
    const upstream = `${turnError.name}: ${turnError.message}`;
    const partial = partialReplyText.trim();
    super(
      (freeTierRejected ? `${OPENCODE_FREE_TIER_SAFE_PRESET_HINT} 上游原文 — ${upstream}` : `模型调用失败（${upstream}）`) +
      (partial ? `\n\n失败前已产出的部分文本：\n${partial}` : ""),
    );
    this.name = "OpenCodeProviderError";
    this.upstreamName = turnError.name;
    this.upstreamMessage = turnError.message;
    this.freeTierRejected = freeTierRejected;
    this.partialReplyText = partial;
  }
}

/**
 * Re-shape any opencode failure that carries the free-tier rejection into the
 * readable hint (keeps other errors untouched). Used on paths where the
 * upstream text arrives inside a generic error (e.g. the ACP lane).
 */
export function withOpenCodeFreeTierHint(error: unknown): unknown {
  const text = typeof (error as any)?.message === "string" ? (error as any).message : String(error);
  if (!isOpenCodeFreeTierRejection(text) || error instanceof OpenCodeProviderError) return error;
  return Object.assign(new Error(`${OPENCODE_FREE_TIER_SAFE_PRESET_HINT} 上游原文 — ${text}`), { cause: error });
}
