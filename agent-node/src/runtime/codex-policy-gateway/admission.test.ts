// RFC-030 Wave 1A P0.2 — admission.ts tests.

import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import {
  ALLOWED_LOOPBACK,
  TUI_WS_PATH,
  TUI_WS_VERSION,
  decideAdmission,
} from "./admission";

// ─────────────────────────────────────────────────────────────────────
// Minimal request/socket shims. `decideAdmission` reads:
//   req.method, req.url, req.headers, req.rawHeaders
//   socket.remoteAddress
// ─────────────────────────────────────────────────────────────────────

function makeReq(overrides: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  rawHeaders?: string[];
}): IncomingMessage {
  const headers = overrides.headers ?? {};
  // If rawHeaders isn't explicitly set, build one entry per merged
  // header — exactly what Node would produce for a single-value case.
  const rawHeaders =
    overrides.rawHeaders ??
    Object.entries(headers).flatMap(([k, v]) => [k, v]);
  return {
    method: overrides.method ?? "GET",
    url: overrides.url ?? "/",
    headers,
    rawHeaders,
  } as unknown as IncomingMessage;
}

function makeSocket(remoteAddress: string | undefined): Socket {
  return { remoteAddress } as unknown as Socket;
}

const OK_HEADERS = (port: number, cap: string): Record<string, string> => ({
  host: `${ALLOWED_LOOPBACK}:${port}`,
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-version": TUI_WS_VERSION,
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  authorization: `Bearer ${cap}`,
});

// ─────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────

describe("decideAdmission — happy path", () => {
  test("all checks pass -> ok, bearer extracted verbatim", () => {
    const port = 45678;
    const bearer = "abcdefghijklmnopqrstuvwxyz-BEARER";
    const req = makeReq({ headers: OK_HEADERS(port, bearer) });
    const socket = makeSocket(ALLOWED_LOOPBACK);
    const out = decideAdmission(req, socket, port);
    if (out.kind !== "ok") throw new Error(`expected ok, got ${out.kind}`);
    expect(out.bearer).toBe(bearer);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Structural rejections (in the exact validation order)
// ─────────────────────────────────────────────────────────────────────

describe("decideAdmission — HTTP structural rejections (order-sensitive)", () => {
  test("non-GET -> 405 http_method_not_get", () => {
    const req = makeReq({ method: "POST", headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(405);
    expect(out.reason).toBe("http_method_not_get");
  });

  test("wrong path -> 404 http_path_not_root", () => {
    // The path fix from 副指挥 967a0010: `/rpc` is refused here (unix-only).
    const req = makeReq({ url: "/rpc", headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(404);
    expect(out.reason).toBe("http_path_not_root");
  });

  test("non-loopback remote address -> 400 remote_not_loopback", () => {
    const req = makeReq({ headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket("192.168.1.100"), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("remote_not_loopback");
  });

  test("localhost is NOT loopback under strict IPv4 policy", () => {
    // Guards against DNS rebinding.
    const req = makeReq({
      headers: { ...OK_HEADERS(1, "x"), host: "localhost:1" },
    });
    const out = decideAdmission(req, makeSocket("localhost"), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("remote_not_loopback");
  });

  test("::1 is NOT loopback under strict IPv4 policy", () => {
    const req = makeReq({ headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket("::1"), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("remote_not_loopback");
  });

  test("::ffff:127.0.0.1 (v4-mapped v6) is NOT accepted", () => {
    const req = makeReq({ headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket("::ffff:127.0.0.1"), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("remote_not_loopback");
  });

  test("host header missing -> 400 http_host_missing", () => {
    const h = OK_HEADERS(1, "x");
    delete (h as Record<string, unknown>).host;
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_host_missing");
  });

  test("host header != 127.0.0.1:<port> -> 400 http_host_wrong (guards against DNS rebinding)", () => {
    const h = OK_HEADERS(45678, "x");
    h.host = "attacker.example.com:45678";
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 45678);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_host_wrong");
  });

  test("host header with wrong port -> 400 http_host_wrong", () => {
    const h = OK_HEADERS(45679, "x");
    h.host = `${ALLOWED_LOOPBACK}:12345`;
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 45679);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_host_wrong");
  });

  test("Content-Length present -> 400 http_content_length_present (smuggling smell)", () => {
    const h = { ...OK_HEADERS(1, "x"), "content-length": "0" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_content_length_present");
  });

  test("Transfer-Encoding present -> 400 http_transfer_encoding_present", () => {
    const h = { ...OK_HEADERS(1, "x"), "transfer-encoding": "chunked" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_transfer_encoding_present");
  });

  test("Upgrade header missing -> 400 http_missing_upgrade_header", () => {
    const h = { ...OK_HEADERS(1, "x") };
    delete (h as Record<string, unknown>).upgrade;
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_missing_upgrade_header");
  });

  test("Connection: keep-alive without upgrade token -> 400", () => {
    const h = { ...OK_HEADERS(1, "x"), connection: "keep-alive" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_missing_connection_header");
  });

  test("Connection: keep-alive, Upgrade -> accepted (upgrade token present)", () => {
    const h = { ...OK_HEADERS(1, "x"), connection: "keep-alive, Upgrade" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    // Structural pass; may still reject downstream on auth-related checks
    // but not on connection header.
    if (out.kind === "reject") {
      expect(out.reason).not.toBe("http_missing_connection_header");
    }
  });

  test("Sec-WebSocket-Version != 13 -> 426 http_bad_ws_version", () => {
    const h = { ...OK_HEADERS(1, "x"), "sec-websocket-version": "8" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(426);
    expect(out.reason).toBe("http_bad_ws_version");
  });

  test("Sec-WebSocket-Protocol present -> 400 http_subprotocol_present", () => {
    const h = { ...OK_HEADERS(1, "x"), "sec-websocket-protocol": "chat" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_subprotocol_present");
  });

  test("Sec-WebSocket-Extensions present -> 400 http_extensions_present (blocks permessage-deflate)", () => {
    const h = { ...OK_HEADERS(1, "x"), "sec-websocket-extensions": "permessage-deflate" };
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("http_extensions_present");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bearer rejections (duplicates and scheme)
// ─────────────────────────────────────────────────────────────────────

describe("decideAdmission — bearer rejections", () => {
  test("Authorization missing -> 401 bearer_absent", () => {
    const h = OK_HEADERS(1, "x");
    delete (h as Record<string, unknown>).authorization;
    const req = makeReq({ headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(401);
    expect(out.reason).toBe("bearer_absent");
  });

  test("Authorization scheme not Bearer -> 401 bearer_scheme_wrong", () => {
    const req = makeReq({
      headers: { ...OK_HEADERS(1, "x"), authorization: "Basic dXNlcjpwYXNz" },
    });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.reason).toBe("bearer_scheme_wrong");
  });

  test("Authorization value empty -> 401 bearer_scheme_wrong (uniform 401 wire)", () => {
    const req = makeReq({
      headers: { ...OK_HEADERS(1, "x"), authorization: "Bearer " },
    });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(401);
  });

  test("multiple Authorization headers via rawHeaders -> 400 bearer_multi_header", () => {
    const req = makeReq({
      headers: { ...OK_HEADERS(1, "x") },
      rawHeaders: [
        "host", `${ALLOWED_LOOPBACK}:1`,
        "upgrade", "websocket",
        "connection", "Upgrade",
        "sec-websocket-version", TUI_WS_VERSION,
        "Authorization", "Bearer token-one-abcdef",
        "Authorization", "Bearer token-two-abcdef",
      ],
    });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    expect(out.status).toBe(400);
    expect(out.reason).toBe("bearer_multi_header");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Verification order — auth checks NEVER expose owner-slot state
// ─────────────────────────────────────────────────────────────────────

describe("decideAdmission — verification order (owner-slot NOT probed)", () => {
  test("no owner-slot check performed inside decideAdmission (design pin)", () => {
    // The module never accepts an owner-slot fixture. If a caller
    // wants owner-slot semantics they run their own check AFTER
    // bearer verify. This test locks the interface shape.
    const req = makeReq({ headers: OK_HEADERS(1, "x") });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    // Result never carries an owner-slot field.
    expect(Object.keys(out).sort()).not.toContain("owner_already_attached");
  });

  test("structural failure precedes bearer failure (unauth 401 CANNOT distinguish owner state)", () => {
    // Wrong-path failure returns 404 regardless of bearer state.
    const h = OK_HEADERS(1, "");
    delete (h as Record<string, unknown>).authorization; // missing bearer
    const req = makeReq({ url: "/rpc", headers: h });
    const out = decideAdmission(req, makeSocket(ALLOWED_LOOPBACK), 1);
    if (out.kind !== "reject") throw new Error("expected reject");
    // We see the PATH reject, not the bearer reject.
    expect(out.reason).toBe("http_path_not_root");
  });
});
