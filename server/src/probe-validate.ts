// RFC-028 P1 §4.4 — probe path validators (pure, no I/O).
// Host allowlist + IP block + validateBaseUrl extracted into
// shared/probe-host-allowlist.ts (mirror of agent-node/src/shared/, G9
// drift guard enforces byte-identical). This module re-exports them so
// existing hub call sites keep working, and adds hub-only bits:
// PROBE_STATUS_ENUM + ProbeAckPayloadSchema + deriveErrorLabel +
// rejectIfSecretLeaked + assertSecureTlsEnv.

import { z } from "zod/v4";
export {
  VENDOR_HOST_ALLOWLIST,
  SUPPORTED_VENDORS,
  ProbeValidationError,
  validateBaseUrl,
  isLoopbackHost,
  isForbiddenIp,
} from "./shared/probe-host-allowlist.js";
import { ProbeValidationError } from "./shared/probe-host-allowlist.js";

// ── §4.4.5 boot-time TLS env guard (assert before any probe runs) ──

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
