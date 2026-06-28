// RFC-028 P1 §4.4 — probe path validators (pure, no I/O).
// Used by hub-side upsert_provider (validates base_url against vendor
// allowlist) + daemon-side get_probe_request (re-validates, defense in
// depth) + daemon-side safelyFetchProbe (DNS resolve → IP check →
// pin) + hub-side ack_probe_request (deriveErrorLabel + rejectIfSecretLeaked).

import { z } from "zod/v4";

// ── §4.4.1 per-vendor host allowlist (P1: anthropic only) ─────────
// P2 will extend: openai/zai/openrouter/deepseek/qwen. Each vendor
// has ONE OR MORE allowed hostnames (regex anchored). custom vendor
// requires admin to explicitly allowlist per-host (P3).

export const VENDOR_HOST_ALLOWLIST: Record<string, ReadonlyArray<RegExp>> = {
  anthropic:  [/^api\.anthropic\.com$/],
  // P2:
  // openai:     [/^api\.openai\.com$/],
  // zai:        [/^api\.z\.ai$/, /^open\.bigmodel\.cn$/],
  // openrouter: [/^openrouter\.ai$/],
  // deepseek:   [/^api\.deepseek\.com$/],
  // qwen:       [/^dashscope(-intl)?\.aliyuncs\.com$/],
};
export const SUPPORTED_VENDORS = Object.keys(VENDOR_HOST_ALLOWLIST);

export class ProbeValidationError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(`${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "ProbeValidationError";
  }
}

/** Boot-time / pre-fetch validation of provider base_url. Both hub
 *  (upsert_provider) and daemon (get_probe_request) run this. */
export function validateBaseUrl(vendor: string, baseUrl: string, opts: { allowLoopback?: boolean } = {}): void {
  let u: URL;
  try { u = new URL(baseUrl); }
  catch { throw new ProbeValidationError("probe_base_url_invalid", { reason: "not a valid URL", baseUrl: baseUrl.slice(0, 100) }); }

  if (u.protocol !== "https:") {
    // Loopback HTTP only allowed when explicit dev opt-in
    if (!opts.allowLoopback || !isLoopbackHost(u.hostname) || u.protocol !== "http:") {
      throw new ProbeValidationError("probe_base_url_invalid", { reason: "must be https (or http+loopback with dev opt-in)" });
    }
  }
  const allowed = VENDOR_HOST_ALLOWLIST[vendor];
  if (!allowed) {
    throw new ProbeValidationError("vendor_not_supported", { vendor, supported: SUPPORTED_VENDORS });
  }
  if (!allowed.some(re => re.test(u.hostname))) {
    throw new ProbeValidationError("probe_target_forbidden", {
      vendor, host: u.hostname, allowed: allowed.map(r => r.source),
    });
  }
}

// ── §4.4.2 private/reserved IP block (anti SSRF) ──────────────────
// Used by daemon's safelyFetchProbe after dns.lookup. Every resolved
// IP must NOT be in these ranges (else probe_resolve_unsafe_ip).
// Loopback exception requires ANET_DAEMON_PROBE_ALLOW_LOOPBACK=1.

const FORBIDDEN_IPV4_RE: ReadonlyArray<RegExp> = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,           // link-local + 169.254.169.254 cloud metadata
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // CGNAT
  /^0\./,
  /^22[4-9]\./, /^23[0-9]\./,  // multicast
  /^24[0-9]\./, /^25[0-5]\./,  // experimental
];
const FORBIDDEN_IPV6_RE: ReadonlyArray<RegExp> = [
  /^::1$/,
  /^::$/,
  /^fe80:/i, /^fc00:/i, /^fd00:/i,
];

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isForbiddenIp(ip: string): boolean {
  // IPv4-mapped IPv6: ::ffff:10.0.0.1 — recurse on inner v4
  if (ip.toLowerCase().startsWith("::ffff:")) {
    return isForbiddenIp(ip.slice(7));
  }
  // Simple v4/v6 distinction by presence of '.' / ':'
  if (ip.includes(":") && !ip.includes(".")) {
    return FORBIDDEN_IPV6_RE.some(re => re.test(ip));
  }
  return FORBIDDEN_IPV4_RE.some(re => re.test(ip));
}

// ── §4.4.3 boot-time TLS env guard (assert before any probe runs) ──

export function assertSecureTlsEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ProbeValidationError("probe_tls_insecure_disabled", {
      reason: "NODE_TLS_REJECT_UNAUTHORIZED=0 forbidden — TLS cert validation must be ON for SSRF defense",
    });
  }
}

// ── §4.4.4 ProbeAckPayload — STRICT whitelist (v3 R3) ─────────────
// Daemon ack returns ONLY these fields. Any extra string is dropped
// at the zod parse boundary. Hub additionally runs rejectIfSecretLeaked
// (defense in depth).

export const PROBE_STATUS_ENUM = [
  "ok",
  "auth_fail",
  "quota",
  "rate_limit",
  "network_error",
  "timeout",
  "redirect_forbidden",
  "vendor_5xx",
  "other_4xx",
  "tls_error",
  // SSRF guards surface their own statuses so dashboard can show the
  // exact reason; deriveErrorLabel maps to UI text.
  "probe_resolve_unsafe_ip",
  "probe_target_forbidden",
] as const;
export type ProbeStatus = typeof PROBE_STATUS_ENUM[number];

export const ProbeAckPayloadSchema = z.object({
  probe_id: z.string().min(1).max(200),
  status: z.enum(PROBE_STATUS_ENUM),
  raw_status_code: z.number().int().min(100).max(599).optional(),
  latency_ms: z.number().int().min(0).max(60_000),
}).strict();   // .strict() rejects ANY extra field — error_message / response_body / etc smuggled by attacker daemon
export type ProbeAckPayload = z.infer<typeof ProbeAckPayloadSchema>;

/** Hub-side: map (status, raw_status_code) → human label.
 *  daemon NEVER submits this; hub computes from enum + numeric. */
export function deriveErrorLabel(ack: ProbeAckPayload): string | null {
  switch (ack.status) {
    case "ok":                   return null;
    case "auth_fail":            return `API key 校验失败 (HTTP ${ack.raw_status_code ?? "?"})`;
    case "quota":                return "API 额度用尽 (429)";
    case "rate_limit":           return "我方 rate limit (60req/min/provider) 触发";
    case "network_error":        return "网络不可达 (connect/DNS fail)";
    case "timeout":              return "连通性测试超时 (>30s)";
    case "redirect_forbidden":   return "vendor 返回 30x redirect, P1 一律拒";
    case "vendor_5xx":           return `vendor 服务端错 (HTTP ${ack.raw_status_code ?? "5xx"})`;
    case "other_4xx":            return `vendor 客户端错 (HTTP ${ack.raw_status_code ?? "4xx"})`;
    case "tls_error":            return "TLS 证书校验失败";
    case "probe_resolve_unsafe_ip": return "SSRF 拒: base_url 解析到禁用 IP 段 (私网/metadata)";
    case "probe_target_forbidden":  return "SSRF 拒: base_url host 不在 vendor allowlist";
  }
}

// ── §4.4.4 hub-side belt: reject if daemon ack contains a secret ──
// Even though daemon ack schema (zod .strict()) blocks string fields,
// this guard catches a daemon impl bug that smuggles secrets via
// some other means (e.g. probe_id stuffed with key value).
// Checks plaintext + URL-encoded + 12-char sliding window substring.

export function rejectIfSecretLeaked(ackJson: string, knownSecrets: ReadonlyArray<string>): void {
  for (const s of knownSecrets) {
    if (!s || s.length < 8) continue;  // avoid false positive on tiny tokens
    if (ackJson.includes(s)) {
      throw new ProbeValidationError("ack_secret_leak", { reason: "plain", len: s.length });
    }
    const enc = encodeURIComponent(s);
    if (enc !== s && ackJson.includes(enc)) {
      throw new ProbeValidationError("ack_secret_leak", { reason: "url_encoded", len: s.length });
    }
    if (s.length >= 16) {
      for (let i = 0; i <= s.length - 12; i++) {
        if (ackJson.includes(s.slice(i, i + 12))) {
          throw new ProbeValidationError("ack_secret_leak", { reason: "substring_12", offset: i });
        }
      }
    }
  }
}
