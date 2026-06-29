// RFC-028 P1 §4.4 — shared probe SSRF guards.
// Host allowlist + private IP block + validateBaseUrl.
//
// MUST be byte-identical between hub (server/src/shared/) and daemon
// (agent-node/src/shared/). Enforced by probe-host-allowlist-drift.test.ts
// (same pattern as reserved-env.ts G9 drift guard, RFC-026 §4.4.7).
//
// Why mirror not symlink: hub and daemon are separate npm packages
// installed independently on different machines. A drift-checked source
// copy survives `npm pack` + global install; a symlink does not.
//
// Threat model the daemon re-check defends against:
//   - Compromised hub records a malicious base_url in providers/spec
//   - Hub bypassed validateBaseUrl (regression / different code path)
//   - On-wire injection between hub→daemon SSE
// Daemon trusts process.execPath + this file's content, NOT what
// `get_probe_request` claims. If hub-side check is identical, daemon
// re-check is a no-op; if hub-side ever loosens, daemon stays strict.

export class ProbeValidationError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(`${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "ProbeValidationError";
  }
}

// ── §4.4.1 per-vendor host allowlist ──────────────────────────────
// `anthropic` vendor accepts Anthropic + curated 3rd-party Anthropic-
// compatible endpoints that Vincent / N站马 ship live providers
// against (DeepSeek + MiniMax both expose `/v1/messages` with the
// Anthropic protocol surface). Whitelist semantics preserved — NOT
// allow-any. New entries land here via PR with security review
// (network-admin-configurable allowlist is backlog: needs strong
// IP-range / shape guard before admins can edit).
//
// Per 通信龙 (RFC-028 P1.5+): the host whitelist is defense layer 1;
// layer 2 is the DNS-resolved IP block (FORBIDDEN_IPV{4,6}_RE below),
// applied AFTER allowlist passes. Any new host gets BOTH layers
// automatically — host in allowlist + DNS resolves to private/metadata
// IP still surfaces `probe_resolve_unsafe_ip`.
//
// P2 will add vendors (openai/zai/openrouter/qwen) as separate keys.
export const VENDOR_HOST_ALLOWLIST: Record<string, ReadonlyArray<RegExp>> = {
  anthropic:  [
    /^api\.anthropic\.com$/,
    /^api\.deepseek\.com$/,     // Anthropic-compatible /v1/messages
    /^api\.minimax\.chat$/,     // MiniMax legacy domain
    /^api\.minimax\.io$/,       // MiniMax new domain (Vincent live use)
  ],
  // P2:
  // openai:     [/^api\.openai\.com$/],
  // zai:        [/^api\.z\.ai$/, /^open\.bigmodel\.cn$/],
  // openrouter: [/^openrouter\.ai$/],
  // qwen:       [/^dashscope(-intl)?\.aliyuncs\.com$/],
};
export const SUPPORTED_VENDORS = Object.keys(VENDOR_HOST_ALLOWLIST);

// ── §4.4.2 private/reserved IP block (anti SSRF) ──────────────────
export const FORBIDDEN_IPV4_RE: ReadonlyArray<RegExp> = [
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
export const FORBIDDEN_IPV6_RE: ReadonlyArray<RegExp> = [
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

// ── §4.4.3 validateBaseUrl — boot/pre-fetch URL+host+vendor check ─
/** Pure, no I/O. Called by hub (upsert_provider write path) AND
 *  daemon (handleProbeDoorbell re-check after get_probe_request).
 *  allowLoopback: dev-only opt-in honoring http://localhost / 127.0.0.1.
 *  Production daemon MUST NOT set allowLoopback=true. */
export function validateBaseUrl(
  vendor: string,
  baseUrl: string,
  opts: { allowLoopback?: boolean } = {},
): void {
  let u: URL;
  try { u = new URL(baseUrl); }
  catch {
    throw new ProbeValidationError("probe_base_url_invalid", {
      reason: "not a valid URL", baseUrl: baseUrl.slice(0, 100),
    });
  }

  if (u.protocol !== "https:") {
    if (!opts.allowLoopback || !isLoopbackHost(u.hostname) || u.protocol !== "http:") {
      throw new ProbeValidationError("probe_base_url_invalid", {
        reason: "must be https (or http+loopback with dev opt-in)",
      });
    }
  }
  const allowed = VENDOR_HOST_ALLOWLIST[vendor];
  if (!allowed) {
    throw new ProbeValidationError("vendor_not_supported", {
      vendor, supported: SUPPORTED_VENDORS,
    });
  }
  if (!allowed.some(re => re.test(u.hostname))) {
    throw new ProbeValidationError("probe_target_forbidden", {
      vendor, host: u.hostname, allowed: allowed.map(r => r.source),
    });
  }
}
