import type { Dispatcher } from "undici";

function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

// Preserve transport causes and the bridge's original deadline error.
function explainFetchFailure(error: any, method: string, path: string): unknown {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return error;
  const cause = error?.cause;
  const code = cause?.code;
  if (!code) return error;
  const detail = cause?.message && cause.message !== code ? `: ${cause.message}` : "";
  return new Error(`OpenCode ${method} ${path} ${error?.message ?? "fetch failed"} (${code}${detail})`, { cause: error });
}

export async function fetchOpenCodeJson(
  url: string,
  password: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
  dispatcher?: Dispatcher,
): Promise<any> {
  const method = init.method ?? "GET";
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: basicAuthorization(password),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      // `timeoutMs <= 0` = no deadline here: the operator disabled it, or the
      // caller passed its own `init.signal` (kept by the spread above).
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      // Neither key is in the DOM RequestInit type. Node's fetch honours
      // `dispatcher` and ignores `timeout`; Bun is the other way round.
      ...(dispatcher ? { dispatcher, timeout: false } : {}),
    } as RequestInit);
    text = await response.text();
  } catch (error) {
    throw explainFetchFailure(error, method, path);
  }
  if (!response.ok) {
    throw new Error(`OpenCode ${method} ${path} returned HTTP ${response.status}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Control lane only: preserve caller cancellation alongside its own deadline. */
export function fetchOpenCodeSessionControlJson(url: string, password: string, path: string, init: RequestInit = {}): Promise<any> {
  const deadline = AbortSignal.timeout(5_000);
  const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
  // The generic helper deliberately owns its timeout unless timeoutMs <= 0.
  return fetchOpenCodeJson(url, password, path, { ...init, redirect: "error", signal }, 0);
}
