// #552 — one log line for every non-2xx answer from REST POST /api/task.
//
// A restricted member's app sends were rejected and the hub log showed
// nothing, so "the request never arrived" and "the hub refused it" looked
// identical from the server side. Every rejection branch now goes through
// logTaskRejection().
//
// What is logged is deliberately narrow: status, error code, the
// authenticated username, and the *requested* alias / network_id /
// client_request_id. Never the bearer token, the task text, or attachment
// ids. Request-supplied values are clipped and stripped of control
// characters so a client cannot forge extra log lines.

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
  console.log(formatTaskRejection({ status: res.status, error: error ?? "unknown", username: username || "anon", body }));
  return res;
}
