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

function logicalRequestMeta(value: string | null): unknown {
  const parsed = parsedMeta(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  // auth_origin is a Hub-derived audit fact, not part of the client request.
  // Ignore it for replay equality so a request first accepted by the old Hub
  // (without the stamp) remains idempotent across a rolling upgrade.
  //
  // #669 —— parent_source 同理：它是 Hub 记录的「parent_task_id 是怎么来的」
  // （explicit / inferred），由派发时的推断结果决定，**不是客户端请求的一部分**。
  // 不排除它会让幂等重放失败：第一次调用可能没有可推断的父任务（不带该字段），
  // 重放时上一条已经是 delivered（推断命中 ⇒ 带 parent_source:"inferred"），
  // 于是同一请求被判成 idempotency_conflict。test1210 抓到的就是这个。
  const { auth_origin: _authOrigin, parent_source: _parentSource, ...logical } = parsed as Record<string, unknown>;
  return logical;
}

export function idempotentTaskMatches(row: StoredIdempotentTask, expected: ExpectedIdempotentTask): boolean {
  return row.from_name === expected.fromName
    && row.to_name === expected.toName
    && row.priority === expected.priority
    && row.content === expected.content
    && (row.network_id ?? null) === (expected.networkId ?? null)
    && canonicalJson(logicalRequestMeta(row.meta_json)) === canonicalJson(logicalRequestMeta(expected.metaJson));
}
