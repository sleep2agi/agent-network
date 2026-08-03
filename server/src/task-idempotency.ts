import { createHash } from "crypto";

const CLIENT_REQUEST_ID_RE = /^dreq_[A-Za-z0-9_-]{16,96}$/;

export interface StoredIdempotentTask {
  task_id: string;
  from_name: string;
  to_name: string;
  priority: string;
  content: string;
  network_id: string | null;
  meta_json: string | null;
  status: string;
}

export interface ExpectedIdempotentTask {
  fromName: string;
  toName: string;
  priority: string;
  content: string;
  networkId: string | null;
  metaJson: string | null;
}

export function clientRequestIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).client_request_id;
  return typeof value === "string" && CLIENT_REQUEST_ID_RE.test(value) ? value : null;
}

export function idempotentTaskId(networkId: string | null, fromName: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(networkId ?? "<legacy-global>")
    .update("\0")
    .update(fromName)
    .update("\0")
    .update(requestId)
    .digest("hex");
  return `idem_${digest.slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parsedMeta(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function idempotentTaskMatches(row: StoredIdempotentTask, expected: ExpectedIdempotentTask): boolean {
  return row.from_name === expected.fromName
    && row.to_name === expected.toName
    && row.priority === expected.priority
    && row.content === expected.content
    && (row.network_id ?? null) === (expected.networkId ?? null)
    && canonicalJson(parsedMeta(row.meta_json)) === canonicalJson(parsedMeta(expected.metaJson));
}
