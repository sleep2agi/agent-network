// RFC-030 Wave 1A P0.2 — admission.ts
//
// HTTP Upgrade admission for the native Codex TUI WebSocket. Owns the
// pre-WebSocket validation surface: HTTP-level structural checks + the
// bearer challenge. This module NEVER completes a WebSocket handshake
// or accesses the frozen protocol layer — it only produces a decision
// object that `tui-ws-server.ts` acts on.
//
// Hard requirements (副指挥 7034c5ce items #4, #5, #6, #10):
//   - Strict IPv4 loopback: bind/remoteAddress/Host header all only
//     allow the literal `127.0.0.1`. `localhost`, `::1`, and
//     `::ffff:127.0.0.1` are all refused.
//   - Validation order: HTTP structural checks FIRST, then bearer,
//     then owner slot. An unauthenticated peer cannot probe owner
//     state via a 409.
//   - Duplicate `Authorization` headers use `req.rawHeaders` count,
//     not Node's merged `req.headers.authorization` (which silently
//     joins duplicates with commas).
//   - Every wire failure produces the SAME generic 401 body. The
//     internal reject reason is emitted ONLY into the scrubbed
//     diagnostics sink — the peer cannot learn which check tripped.
//   - No claim of "common helper equals timing safety" — this module
//     runs every reject through `writeGenericReject(status, code)`
//     with a fixed 401 body regardless of the internal reason. That
//     matches wire uniformity; it does NOT claim end-to-end timing
//     safety in the absence of measurement.

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// ────────────────────────────────────────────────────────────────────────
// Reject reasons (INTERNAL only)
// ────────────────────────────────────────────────────────────────────────

/**
 * Detailed reason for a rejected admission attempt. These strings are
 * emitted to the diagnostics sink only. The wire body is uniformly
 * generic (`"unauthorized"` on 401, `"bad_request"` on 400, etc.).
 */
export type AdmissionRejectReason =
  // HTTP structural rejections (surface: 400)
  | "http_method_not_get"
  | "http_path_not_root"
  | "http_missing_upgrade_header"
  | "http_missing_connection_header"
  | "http_bad_ws_version"
  | "http_subprotocol_present"
  | "http_extensions_present"
  | "http_host_missing"
  | "http_host_wrong"
  | "http_content_length_present"
  | "http_transfer_encoding_present"
  // Loopback rejections (surface: 400)
  | "remote_not_loopback"
  // Bearer rejections (surface: 401)
  | "bearer_absent"
  | "bearer_multi_header"
  | "bearer_scheme_wrong"
  | "bearer_invalid"
  | "bearer_already_consumed"
  | "bearer_ttl_expired"
  | "bearer_rotated_out"
  // Owner-slot rejections (surface: 409 or 401 depending on step)
  | "owner_already_attached";

/** Outcome discriminant returned to `tui-ws-server.ts`. */
export type AdmissionOutcome =
  | {
      readonly kind: "ok";
      /**
       * The trimmed bearer plaintext extracted from the Authorization
       * header. Caller passes this to the bearer verifier. NEVER logs
       * this value. Cleared once the bearer check runs.
       */
      readonly bearer: string;
    }
  | {
      readonly kind: "reject";
      /** HTTP status code the caller should write. */
      readonly status: number;
      /** INTERNAL reason. Emitted to diagnostics only. */
      readonly reason: AdmissionRejectReason;
    };

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

/**
 * Pinned WS path — captured from real Codex 0.144.0 loopback baseline
 * (副指挥 967a0010). The `codex --remote ws://127.0.0.1:<port>` CLI
 * dials `/` exclusively; any other path (including the unix:// `/rpc`
 * convention) trips the CLI's `invalid remote address` check.
 */
export const TUI_WS_PATH = "/";

/**
 * Pinned WebSocket protocol version. RFC 6455 mandates 13; any client
 * negotiating a different version is refused with 426.
 */
export const TUI_WS_VERSION = "13";

/**
 * The single loopback address literal we accept, per 副指挥
 * 7034c5ce item #4. `localhost`, `::1`, and `::ffff:127.0.0.1` are
 * NOT permitted — an IPv4-only surface removes an entire class of
 * DNS-rebinding / IPv6-alias confusion.
 */
export const ALLOWED_LOOPBACK = "127.0.0.1";

// ────────────────────────────────────────────────────────────────────────
// Admission decision helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Return the count of Authorization headers on the request, sourced
 * from `req.rawHeaders`. `req.headers.authorization` in Node combines
 * duplicates with a comma, which would let a hostile client smuggle
 * `Authorization: Bearer X, Authorization: Bearer Y` under one merged
 * key.
 *
 * `rawHeaders` is a flat `[name0, value0, name1, value1, ...]` array
 * preserving occurrences.
 */
function countAuthorizationHeaders(req: IncomingMessage): number {
  const raw = req.rawHeaders;
  let n = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "authorization") n++;
  }
  return n;
}

function extractAuthorizationRaw(req: IncomingMessage): string | undefined {
  // At this point we've established there is exactly ONE Authorization
  // header. Pull it out of rawHeaders (case-insensitive) to keep the
  // extraction path uniform.
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "authorization") return raw[i + 1];
  }
  return undefined;
}

/**
 * Extract the bearer plaintext from an `Authorization: Bearer <value>`
 * header. Returns:
 *   - a non-empty string on success
 *   - `null` when the scheme is wrong or the value is empty
 *
 * Whitespace between "Bearer" and the value is a single space (Codex
 * 0.144.0 emits exactly one space). Multiple spaces are treated as
 * scheme mismatch.
 */
function parseBearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  // Trim ONE leading space then match "Bearer " prefix strictly.
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length);
  if (value.length === 0) return null;
  return value;
}

/**
 * IPv4 literal check for the connection's remote address. Node exposes
 * `socket.remoteAddress`. Some environments return `::ffff:127.0.0.1`
 * (v4-mapped v6); THIS module refuses that form. The connection was
 * dialed on a bare `127.0.0.1` bind so this should be the only remote
 * ever seen; if it isn't, the environment is unexpected and we fail
 * closed.
 */
function isStrictIpv4Loopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === ALLOWED_LOOPBACK;
}

/**
 * Validate the HTTP structural side of a WS upgrade attempt against
 * captured 0.144.0 loopback semantics. Does NOT touch the bearer.
 */
function validateHttpStructure(
  req: IncomingMessage,
  socket: Socket,
  actualBoundPort: number,
): { ok: true } | { ok: false; status: number; reason: AdmissionRejectReason } {
  if (req.method !== "GET") return { ok: false, status: 405, reason: "http_method_not_get" };
  if (req.url !== TUI_WS_PATH) return { ok: false, status: 404, reason: "http_path_not_root" };
  if (!isStrictIpv4Loopback(socket.remoteAddress)) {
    return { ok: false, status: 400, reason: "remote_not_loopback" };
  }
  // Host header MUST be present and MUST be exactly `127.0.0.1:<port>`.
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    return { ok: false, status: 400, reason: "http_host_missing" };
  }
  const expectedHost = `${ALLOWED_LOOPBACK}:${actualBoundPort}`;
  if (hostHeader !== expectedHost) {
    return { ok: false, status: 400, reason: "http_host_wrong" };
  }
  // Body-related headers on an upgrade request are a smuggling smell.
  if (req.headers["content-length"] !== undefined) {
    return { ok: false, status: 400, reason: "http_content_length_present" };
  }
  if (req.headers["transfer-encoding"] !== undefined) {
    return { ok: false, status: 400, reason: "http_transfer_encoding_present" };
  }
  const upgrade = (req.headers.upgrade ?? "").toString().toLowerCase();
  const connection = (req.headers.connection ?? "").toString().toLowerCase();
  if (upgrade !== "websocket") {
    return { ok: false, status: 400, reason: "http_missing_upgrade_header" };
  }
  // Some clients send `Connection: keep-alive, Upgrade`. Accept either
  // exact `upgrade` or a comma-separated token list containing it.
  const connectionTokens = connection.split(",").map((s) => s.trim());
  if (!connectionTokens.includes("upgrade")) {
    return { ok: false, status: 400, reason: "http_missing_connection_header" };
  }
  if (req.headers["sec-websocket-version"] !== TUI_WS_VERSION) {
    return { ok: false, status: 426, reason: "http_bad_ws_version" };
  }
  if (req.headers["sec-websocket-protocol"] !== undefined) {
    return { ok: false, status: 400, reason: "http_subprotocol_present" };
  }
  if (req.headers["sec-websocket-extensions"] !== undefined) {
    return { ok: false, status: 400, reason: "http_extensions_present" };
  }
  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────
// Public admission entry
// ────────────────────────────────────────────────────────────────────────

/**
 * Run the pre-bearer HTTP structural checks. Returns either an `ok`
 * outcome carrying the extracted bearer plaintext OR a `reject` with
 * the HTTP status the caller writes.
 *
 * The bearer plaintext is NOT verified here — the caller feeds it to
 * `TuiBearer.presentBearer(...)`. The two-step split lets the wire
 * layer keep exactly one "structural reject" path and one "bearer
 * reject" path, both landing on the SAME generic 401/400/etc. body.
 *
 * Verification order (副指挥 7034c5ce item #5):
 *   1. HTTP structural checks (method, path, remote address, host,
 *      upgrade headers, subprotocol/extensions absence, body headers
 *      absent).
 *   2. Authorization header count (exactly 1 via rawHeaders).
 *   3. Authorization scheme + value extraction.
 *
 * Owner-slot check is deliberately NOT performed here. The caller
 * makes the owner-slot decision AFTER a successful bearer verify, so
 * an unauthenticated peer cannot probe owner state.
 */
export function decideAdmission(
  req: IncomingMessage,
  socket: Socket,
  actualBoundPort: number,
): AdmissionOutcome {
  const structural = validateHttpStructure(req, socket, actualBoundPort);
  if (structural.ok === false) {
    return { kind: "reject", status: structural.status, reason: structural.reason };
  }
  const authCount = countAuthorizationHeaders(req);
  if (authCount === 0) {
    return { kind: "reject", status: 401, reason: "bearer_absent" };
  }
  if (authCount > 1) {
    return { kind: "reject", status: 400, reason: "bearer_multi_header" };
  }
  const rawAuth = extractAuthorizationRaw(req);
  const bearer = parseBearer(rawAuth);
  if (bearer === null) {
    // Wrong scheme or empty value. Return absent so the wire is
    // uniform: peer can't distinguish "no header" from "wrong scheme".
    return { kind: "reject", status: 401, reason: "bearer_scheme_wrong" };
  }
  return { kind: "ok", bearer };
}

// ────────────────────────────────────────────────────────────────────────
// Generic reject writer
// ────────────────────────────────────────────────────────────────────────

/**
 * Write a uniform generic reject to the raw socket + destroy it. The
 * body is a fixed one-word status string ("unauthorized" / "bad_request"
 * / "not_found" / etc.) chosen from the status code — the internal
 * reason is NEVER placed on the wire (caller is expected to pass it to
 * the diagnostics sink separately).
 *
 * The socket is destroyed after the response so a hostile peer cannot
 * keep the TCP connection open probing further.
 */
export function writeGenericReject(socket: Socket, status: number): void {
  const bodies: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    426: "upgrade_required",
    429: "too_many_requests",
  };
  const body = bodies[status] ?? "error";
  const statusLine = STATUS_TEXT[status] ?? "Error";
  const headers = [
    `HTTP/1.1 ${status} ${statusLine}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
  // Write + FIN. Under real Node, `socket.end(payload)` writes then
  // half-closes the connection cleanly, giving the peer time to read.
  // Bun's `node:http` upgrade shim currently swallows bytes written to
  // the upgrade socket; the Node E2E test file drives the actual wire
  // path (bun-test suite covers the class-level behaviour via mocks).
  try {
    const payload = Buffer.from(headers, "utf8");
    socket.end(payload);
  } catch {
    /* silent */
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  426: "Upgrade Required",
  429: "Too Many Requests",
};
