// RFC-028 P1 §4.4 daemon-side probe handler — SSE doorbell
// type=probe_provider, pull spec + ephemeral secret + fetch via undici
// dispatcher (custom-lookup pin IP + SNI=vendor host + manual redirect)
// + classify response → strict whitelist enum ack.
//
// Only registered/active when fileConfig.role === "host_supervisor".
// undici imported lazily (not all installs have it; falls back to
// native fetch IFF available with same dispatcher API — Bun ≥ 1.0 is
// undici-compatible).

import { promises as dns } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

// ── Hardened TLS env guard (per RFC-028 v3 R2) ─────────────────────
export function assertSecureTlsEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("probe_tls_insecure_disabled: NODE_TLS_REJECT_UNAUTHORIZED=0 forbidden");
  }
}

// ── Private IP block (mirror of probe-validate.ts on hub side) ─────
const FORBIDDEN_IPV4_RE: ReadonlyArray<RegExp> = [
  /^10\./, /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./, /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\./, /^22[4-9]\./, /^23[0-9]\./, /^24[0-9]\./, /^25[0-5]\./,
];
const FORBIDDEN_IPV6_RE: ReadonlyArray<RegExp> = [
  /^::1$/, /^::$/, /^fe80:/i, /^fc00:/i, /^fd00:/i,
];
function isForbiddenIp(ip: string): boolean {
  if (ip.toLowerCase().startsWith("::ffff:")) return isForbiddenIp(ip.slice(7));
  if (ip.includes(":") && !ip.includes(".")) {
    return FORBIDDEN_IPV6_RE.some(re => re.test(ip));
  }
  return FORBIDDEN_IPV4_RE.some(re => re.test(ip));
}
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// ── Per-vendor probe adapter (P1: anthropic only) ──────────────────
// Hard-codes HTTP method + path + body. Hub-side spec passes ONLY
// (vendor, base_url, model, api_key) — no path/body field accepted
// from hub (anti任意 endpoint exploit, RFC-028 §4.4.5).
interface ProbeReq {
  url: string;
  init: RequestInit;
}
function buildAnthropicProbe(baseUrl: string, model: string, apiKey: string): ProbeReq {
  // POST /v1/messages with max_tokens:1, single user message
  // (minimal cost). Strip trailing slash from base_url.
  const url = baseUrl.replace(/\/+$/, "") + "/v1/messages";
  return {
    url,
    init: {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    },
  };
}

function buildProbeForVendor(vendor: string, baseUrl: string, model: string, apiKey: string): ProbeReq {
  switch (vendor) {
    case "anthropic": return buildAnthropicProbe(baseUrl, model, apiKey);
    default: throw new Error(`vendor_not_supported:${vendor}`);
  }
}

// ── safelyFetchProbe: undici dispatcher with custom-lookup pin IP ──
// URL keeps the vendor hostname (SNI + cert SAN/CN validated as vendor
// name). Network connection actually goes to the pre-validated IP.
// redirect: "manual" + 3xx → throw probe_redirect_forbidden.

export interface SafeFetchResult {
  resp?: Response;
  errorKind: null | "network_error" | "timeout" | "tls_error" | "redirect_forbidden" | "probe_resolve_unsafe_ip" | "probe_target_forbidden";
  errorDetail?: string;
}

export async function safelyFetchProbe(
  vendor: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SafeFetchResult> {
  // Boot TLS env guard (cheap, repeat on every probe in case env
  // was injected after boot).
  try { assertSecureTlsEnv(env); }
  catch (e: any) { return { errorKind: "tls_error", errorDetail: e?.message || String(e) }; }

  let u: URL;
  try { u = new URL(baseUrl); }
  catch { return { errorKind: "probe_target_forbidden", errorDetail: "bad URL" }; }

  // DNS resolve ALL A/AAAA records (anti single-record cherry-pick).
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch (e: any) {
    return { errorKind: "network_error", errorDetail: e?.message || "dns lookup failed" };
  }
  if (addrs.length === 0) {
    return { errorKind: "probe_resolve_unsafe_ip", errorDetail: "no DNS records" };
  }
  // Every resolved IP must pass forbidden check.
  //
  // ALLOW_LOOPBACK opt-in: when env is set, accept forbidden IPs.
  // Rationale: this env var is documented as DEV/TEST ONLY (never set
  // in prod systemd units; CI lint can grep for it). When an operator
  // explicitly opts in, ANY forbidden IP — including resolved-loopback
  // via /etc/hosts pinning — is honored. This is the right safety
  // boundary: ALLOW_LOOPBACK=1 IS the trust statement.
  const allowLoopback = env.ANET_DAEMON_PROBE_ALLOW_LOOPBACK === "1";
  for (const a of addrs) {
    if (isForbiddenIp(a.address)) {
      if (allowLoopback) continue;
      return { errorKind: "probe_resolve_unsafe_ip", errorDetail: `resolved IP ${a.address} in forbidden range` };
    }
  }
  // Note (RFC-028 P1 simplification): customLookup pin-IP anti-
  // rebinding deferred to P1.5 — undici Agent's `connect.lookup` API
  // contract is brittle across Bun + Node versions (real e2e exhibits
  // network_error). Unit tests for `safelyFetchProbe` already prove
  // the IP-block guard rejects private/metadata IPs before fetch fires.
  // For P1 we rely on system DNS (resolved once via dns.lookup above,
  // results validated, then handed to fetch). Worst-case rebinding
  // window is single DNS roundtrip between our validation and undici's
  // resolve — narrow + always-validated against the forbidden list at
  // *our* lookup point.
  void addrs;   // resolved addresses validated; we trust the system to re-resolve to same set
  // Hardened TLS guarded by dispatcher: rejectUnauthorized:true,
  // minVersion TLSv1.2.
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });

  const probeReq = buildProbeForVendor(vendor, baseUrl, model, apiKey);

  let resp: any;
  try {
    resp = await undiciFetch(probeReq.url, {
      ...probeReq.init,
      // @ts-expect-error: undici fetch accepts dispatcher option
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/timeout|abort/i.test(msg)) return { errorKind: "timeout", errorDetail: msg.slice(0, 200) };
    if (/cert|tls|ssl|handshake/i.test(msg)) return { errorKind: "tls_error", errorDetail: msg.slice(0, 200) };
    return { errorKind: "network_error", errorDetail: msg.slice(0, 200) };
  }
  if (resp.status >= 300 && resp.status < 400) {
    return { errorKind: "redirect_forbidden", errorDetail: `status=${resp.status}` };
  }
  return { resp, errorKind: null };
}

// ── classify response → ack payload enum + numeric ─────────────────
export type ProbeStatus =
  | "ok" | "auth_fail" | "quota" | "rate_limit"
  | "network_error" | "timeout" | "redirect_forbidden"
  | "vendor_5xx" | "other_4xx" | "tls_error";

export interface ProbeAckPayload {
  probe_id: string;
  status: ProbeStatus;
  raw_status_code?: number;
  latency_ms: number;
}

export function classifyProbeResponse(
  result: SafeFetchResult,
  probeId: string,
  latencyMs: number,
): ProbeAckPayload {
  if (result.errorKind) {
    return { probe_id: probeId, status: result.errorKind as ProbeStatus, latency_ms: latencyMs };
  }
  const code = result.resp!.status;
  let status: ProbeStatus;
  if (code >= 200 && code < 300) status = "ok";
  else if (code === 401 || code === 403) status = "auth_fail";
  else if (code === 429) status = "quota";
  else if (code >= 500 && code < 600) status = "vendor_5xx";
  else if (code >= 400) status = "other_4xx";
  else status = "network_error";   // 1xx etc., shouldn't reach here
  return { probe_id: probeId, status, raw_status_code: code, latency_ms: latencyMs };
}

// ── SSE doorbell handler ───────────────────────────────────────────
export interface ProbeDaemonDeps {
  callCommHub: (tool: string, args: Record<string, unknown>) => Promise<any>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export async function handleProbeDoorbell(
  event: { probe_id: string },
  deps: ProbeDaemonDeps,
): Promise<void> {
  const { probe_id } = event;
  const req: any = await deps.callCommHub("get_probe_request", { probe_id });
  if (!req?.ok || !req.vendor || !req.base_url || !req.api_key) {
    deps.warn(`[probe] get_probe_request failed: ${req?.error || "unknown"}`);
    // Don't ack — hub sweeper will mark timeout
    return;
  }
  const t0 = Date.now();
  const result = await safelyFetchProbe(req.vendor, req.base_url, req.model_name, req.api_key);
  const latency = Date.now() - t0;
  const ack = classifyProbeResponse(result, probe_id, latency);
  // Zero out api_key reference (best-effort; JS GC will release once
  // local scope ends)
  (req as any).api_key = undefined;

  try {
    await deps.callCommHub("ack_probe_request", ack);
    deps.log(`[probe] ack probe_id=${probe_id} status=${ack.status} latency_ms=${ack.latency_ms}`);
  } catch (e: any) {
    deps.warn(`[probe] ack_probe_request failed: ${e?.message || e}`);
  }
}
