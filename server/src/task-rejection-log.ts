// #552 — one log line for every non-2xx answer from REST POST /api/task.
//
// A restricted member's app sends were rejected and the hub log showed
// nothing, so "the request never arrived" and "the hub refused it" looked
// identical from the server side. Every rejection branch now goes through
// logTaskRejection().
//
// 2026-10-31 —— 同一位置**顺带计数**（reason 分桶，见 rejection-counters.ts）。
// 为什么不只记日志：「今天拒了多少、分别为什么」要能随时读到，
// 而日志轮转后 grep 压缩文件是**静默 0**（读不到会被当成没发生）。
//
// What is logged is deliberately narrow: status, error code, the
// authenticated username, and the *requested* alias / network_id /
// client_request_id. Never the bearer token, the task text, or attachment
// ids. Request-supplied values are clipped and stripped of control
// characters so a client cannot forge extra log lines.

import { recordTaskRejection } from "./rejection-counters.js";

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function clip(value: unknown, max = 64): string {
  if (typeof value !== "string" || !value) return "-";
  const clean = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (!clean) return "-";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export interface TaskRejectionContext {
  status: number;
  error: unknown;
  username: string | null | undefined;
  /** The raw request body (or null when it did not parse). Only alias, network_id and meta.client_request_id are read. */
  body: unknown;
}

export function formatTaskRejection(ctx: TaskRejectionContext): string {
  const b = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, any>) : {};
  const meta = b.meta && typeof b.meta === "object" ? b.meta : {};
  const crid = typeof meta.client_request_id === "string" ? ` crid=${clip(meta.client_request_id)}` : "";
  return `[${ts()}] ${clip(ctx.username ?? "anon")} → /api/task → ${clip(b.alias)}: REJECTED ${ctx.status} ${clip(ctx.error)} (net=${clip(b.network_id)}${crid})`;
}

/** Logs one line for a non-2xx response and returns the response unchanged. */
export async function logTaskRejection(res: Response, username: string | null | undefined, body: unknown): Promise<Response> {
  if (res.status >= 200 && res.status < 300) return res;
  let error: unknown = null;
  try {
    error = ((await res.clone().json()) as any)?.error;
  } catch {}
  const code = error ?? "unknown";
  // 计数与日志在**同一个位置**发生 ⇒ 不会出现“记了日志没计数”或反之。
  recordTaskRejection(res.status, code);
  console.log(formatTaskRejection({ status: res.status, error: code, username: username || "anon", body }));
  return res;
}
