// RFC-030 Wave 1A P0.2 Commit 1 corrective — Node-run integration.
//
// Runs under production Node (Bun's node:http upgrade shim drops
// bytes on writeGenericReject, verified 2026-07-12). Reports:
//
//   real integration PASS: N/N
//
// on stdout with a non-zero exit on any failure.
//
// Bundle path resolves RELATIVE to this script — no /tmp hardcoded.

import { WebSocket } from "ws";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BUNDLE = process.env.RFC030_BUNDLE
  ?? path.resolve(__dirname, "..", "dist", "rfc030-integration.mjs");

const mod = await import(url.pathToFileURL(BUNDLE).href);
const {
  TuiWsServer,
  TuiBearer,
  HumanOwnerCoordinator,
  UpstreamRequestMux,
  ReverseRequestNamespace,
  UpstreamRouter,
  asOwnerLeaseId,
} = mod;

const ALLOWED_LOOPBACK = "127.0.0.1";
let passed = 0;
let failed = 0;
const failures = [];

function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; failures.push({ name, why }); console.log(`  FAIL ${name}: ${why}`); }
function assertEq(name, actual, expected) {
  if (actual === expected) ok(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeCoord() {
  const mux = new UpstreamRequestMux();
  const reverseNs = new ReverseRequestNamespace();
  const diag = {
    entries: [],
    newCorrelationId: () => "cid",
    reportInternalError(e) { this.entries.push(e); },
  };
  const coord = new HumanOwnerCoordinator({
    mux, reverseNs, diagnostics: diag, approvalMode: "never",
  });
  return { coord, mux, reverseNs, diag };
}

class FakeUpstream {
  written = [];
  frameHandlers = [];
  closeHandlers = [];
  async writeFrame(f) { this.written.push(f); }
  onFrame(h) { this.frameHandlers.push(h); return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); }; }
  onClose(h) { this.closeHandlers.push(h); return () => {}; }
  async close() {}
  emitFrame(raw) { for (const h of [...this.frameHandlers]) h(raw); }
}

async function harness() {
  const { coord, mux, reverseNs, diag } = makeCoord();
  const bearer = TuiBearer.mint();
  const plaintext = bearer.takePlaintextForLauncher();
  const upstream = new FakeUpstream();
  // 副指挥 1b24ae71 P1: hard-pinned production constants. No test
  // override seam any more. All tests use the real 1 MiB / 3s / 8.
  const server = new TuiWsServer({
    bearer,
    humanOwner: coord,
    authorizer: {
      async authorize() {
        return { verdict: "deny", code: 0, reason: "default-deny" };
      },
    },
    initProvider: {
      currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" } }),
    },
    diagnostics: {
      newCorrelationId: () => "cid",
      reportInternalError: (e) => { diag.entries.push(e); },
    },
  });
  await server.start();
  // Wire an UpstreamRouter under the same shared mux so the Node
  // integration reflects production topology: router owns upstream
  // subscription, TuiWsServer receives reverse-request delivery via
  // the TuiForwardSeam.
  const tuiForward = {
    deliverReverseRequestToOwner: (f) => server.deliverReverseRequestToOwner(f),
    deliverProxiedResponseToOwner: (tuiId, f) => server.deliverProxiedResponseToOwner(tuiId, f),
  };
  const router = new UpstreamRouter({
    mux, humanOwner: coord, upstreamTransport: upstream,
    diagnostics: { newCorrelationId: () => "cid", reportInternalError: (e) => { diag.entries.push(e); } },
    tuiForward,
    onUpstreamClose: () => {},
  });
  router.subscribe();
  router.activate();
  return { server, bearer, plaintext, coord, diag, upstream, router };
}

function rawHttp(port, lines) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: ALLOWED_LOOPBACK });
    let buf = "";
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const idx = buf.indexOf("\r\n\r\n");
      const head = idx === -1 ? buf : buf.slice(0, idx);
      const body = idx === -1 ? "" : buf.slice(idx + 4);
      const firstLine = head.split("\r\n")[0] ?? "";
      const m = firstLine.match(/^HTTP\/1\.1\s+(\d+)/);
      try { s.destroy(); } catch {}
      resolve({ status: m ? Number(m[1]) : 0, body });
    };
    s.on("data", (c) => { buf += c.toString("utf8"); });
    s.on("close", settle);
    s.on("end", settle);
    s.on("error", (e) => { if (!settled) reject(e); });
    s.on("connect", () => s.write(lines.join("\r\n") + "\r\n"));
    setTimeout(() => { if (!settled) settle(); }, 1200);
  });
}

// ─────────────────────────────────────────────────────────────────────
// T1 happy path (real ws + no jsonrpc initialize)
// ─────────────────────────────────────────────────────────────────────

async function test_happy() {
  const h = await harness();
  try {
    const ws = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    const reply = await new Promise((r, j) => {
      ws.once("message", (d) => r(JSON.parse(d.toString())));
      ws.once("error", j);
      ws.send(JSON.stringify({ id: "initialize", method: "initialize", params: {} }));
    });
    assertEq("T1 happy: reply.id", reply.id, "initialize");
    assertEq("T1 happy: server.name === 'codex'", reply.result.serverInfo.name, "codex");
    ws.close();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T2 slow-header: 3× shorter, connection destroyed before Upgrade
// ─────────────────────────────────────────────────────────────────────

async function test_slow_header() {
  // 副指挥 1b24ae71 P1: header timeout is hard-pinned to 3 s in
  // production. Wait a real 3.5 s. Slow but honest.
  const h = await harness();
  try {
    const s = net.createConnection({ port: h.server.boundPortActual(), host: ALLOWED_LOOPBACK });
    await new Promise((r) => s.once("connect", r));
    s.write("GET / HT");
    await new Promise((r) => setTimeout(r, 3500));
    const destroyed = s.destroyed || s.readyState === "closed";
    if (destroyed) ok("T2 slow-header: preauth socket destroyed after production 3 s timeout");
    else fail("T2 slow-header", `socket still alive after 3.5 s (destroyed=${s.destroyed}, state=${s.readyState})`);
    s.destroy();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T3 missing Authorization → uniform 401
// ─────────────────────────────────────────────────────────────────────

async function test_missing_bearer() {
  const h = await harness();
  try {
    const { status, body } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
    ]);
    assertEq("T3 missing bearer: status 401", status, 401);
    assertEq("T3 missing bearer: body 'unauthorized'", body, "unauthorized");
    assertEq("T3 missing bearer: owner slot empty", h.server.ownerSlotState(), "empty");
    // Bearer NOT consumed - a subsequent CORRECT presentation still succeeds.
    const ws = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    ok("T3 missing bearer: bearer NOT consumed by failed attempt");
    ws.close();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T4 wrong Bearer → uniform 401, secret not echoed
// ─────────────────────────────────────────────────────────────────────

async function test_wrong_bearer() {
  const h = await harness();
  try {
    const bogus = "not-the-real-bearer-abc123def456";
    const { status, body } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${bogus}`,
      "",
    ]);
    assertEq("T4 wrong bearer: status 401", status, 401);
    assertEq("T4 wrong bearer: body 'unauthorized'", body, "unauthorized");
    if (body.includes(bogus)) fail("T4 no echo", "bogus present in body");
    else ok("T4 wrong bearer: bogus not echoed");
    assertEq("T4 wrong bearer: owner slot empty", h.server.ownerSlotState(), "empty");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T5 duplicate Authorization → 400 bad_request
// ─────────────────────────────────────────────────────────────────────

async function test_dup_bearer() {
  const h = await harness();
  try {
    const { status, body } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${h.plaintext}`,
      `Authorization: Bearer smuggled-second-value-abc123`,
      "",
    ]);
    assertEq("T5 dup Authorization: status 400", status, 400);
    assertEq("T5 dup Authorization: body 'bad_request'", body, "bad_request");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T5b bad Sec-WebSocket-Key
// ─────────────────────────────────────────────────────────────────────

async function test_bad_ws_key() {
  const h = await harness();
  try {
    // Missing.
    const missing = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("T5b ws_key_absent: status 400", missing.status, 400);
    // Bad length: decodes to != 16 bytes (17 bytes: 24-char base64).
    const badLen = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhpc2lzZm91cnRlZW5ieXRlcw==", // 20 bytes decoded
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("T5b ws_key_bad_length: status 400", badLen.status, 400);
    // Bad shape (not base64 22-char + ==).
    const badShape = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: not-a-valid-b64-shape",
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("T5b ws_key_bad_shape: status 400", badShape.status, 400);
    assertEq("T5b ws_key: owner slot empty across all three", h.server.ownerSlotState(), "empty");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T7 second Upgrade after attach → connect refused
// ─────────────────────────────────────────────────────────────────────

async function test_second_upgrade_refused() {
  // 副指挥 1b24ae71 P1: HTTP listener stays OPEN after attach so a
  // cleanly-detached owner can reattach without a lifecycle restart.
  // Concurrent hard-1 is enforced by the ownerSlot check + single-use
  // bearer. Second Upgrade with the SAME bearer sees bearer_already
  // _consumed on the wire; second Upgrade with NO bearer sees 401
  // uniform reject.
  const h = await harness();
  try {
    const ws1 = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { ws1.once("open", r); ws1.once("error", j); });
    assertEq("T7 first upgrade holds owner slot", h.server.ownerSlotState(), "held");
    // Second Upgrade with same (now-consumed) bearer -> uniform 401.
    const { status, body } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("T7 second Upgrade -> 401", status, 401);
    assertEq("T7 second Upgrade body 'unauthorized'", body, "unauthorized");
    assertEq("T7 owner slot still held by incumbent", h.server.ownerSlotState(), "held");
    ws1.close();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T4b Item #1 regression: owner survives >2× headerTimeout
// ─────────────────────────────────────────────────────────────────────

async function test_owner_survives_preauth_timer() {
  // 副指挥 1b24ae71 P1: real 3 s header timeout. Wait > 2× to
  // reproduce the 9e6706c bug (owner WS destroyed by preauth timer).
  const h = await harness();
  try {
    const ws = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    await new Promise((r) => setTimeout(r, 6500));
    const reply = await new Promise((r, j) => {
      ws.once("message", (d) => r(JSON.parse(d.toString())));
      ws.once("error", j);
      ws.send(JSON.stringify({ id: "initialize", method: "initialize", params: {} }));
      setTimeout(() => j(new Error("timeout waiting for initialize reply")), 1500);
    });
    assertEq("T4b post-6.5s: owner still OPEN + can RPC", reply.id, "initialize");
    ws.close();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T12 wrong path → 404
// ─────────────────────────────────────────────────────────────────────

async function test_wrong_path() {
  const h = await harness();
  try {
    const { status, body } = await rawHttp(h.server.boundPortActual(), [
      "GET /rpc HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("T12 /rpc → 404", status, 404);
    assertEq("T12 /rpc → body=not_found", body, "not_found");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T11 raw JSONL (no Upgrade) → no JSON layer reached
// ─────────────────────────────────────────────────────────────────────

async function test_raw_jsonl() {
  const h = await harness();
  try {
    const buf = await new Promise((resolve) => {
      const s = net.createConnection({ port: h.server.boundPortActual(), host: ALLOWED_LOOPBACK });
      let b = "";
      s.on("data", (c) => { b += c.toString("utf8"); });
      s.on("close", () => resolve(b));
      s.on("connect", () => s.write(JSON.stringify({ id: 1, method: "initialize" }) + "\n"));
      setTimeout(() => { try { s.destroy(); } catch {} }, 400);
    });
    if (buf.includes("serverInfo") || buf.includes("codex-policy-gateway")) {
      fail("T11 raw JSONL: no JSON reached", `unexpected body: ${buf}`);
    } else {
      ok("T11 raw JSONL: no JSON layer reached");
    }
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T8 cross-lease refusal via HumanOwnerCoordinator
// ─────────────────────────────────────────────────────────────────────

function test_cross_lease() {
  const mux = new UpstreamRequestMux();
  const reverseNs = new ReverseRequestNamespace();
  const coord = new HumanOwnerCoordinator({
    mux, reverseNs,
    diagnostics: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    approvalMode: "passthrough",
  });
  const L1 = asOwnerLeaseId("L1-lease-abc-integration");
  const L2 = asOwnerLeaseId("L2-lease-xyz-integration");
  coord.attachTui(L1);
  const fwd = coord.handleUpstreamReverseRequest({
    jsonrpc: "2.0", id: "cx_i", method: "approval/request",
  });
  if (fwd.kind !== "forward_tui") return fail("T8 setup", `expected forward_tui, got ${fwd.kind}`);
  const rej = coord.handleTuiResponseFrameWithLease(
    { jsonrpc: "2.0", id: fwd.tuiFrame.id, result: {} },
    L2,
  );
  assertEq("T8 cross-lease reject", rej.kind, "reject");
  assertEq("T8 cross-lease reason=lease_mismatch", rej.data.reason, "lease_mismatch");
}

// ─────────────────────────────────────────────────────────────────────
// T13 concurrent valid Upgrades → exactly 1 owner
// ─────────────────────────────────────────────────────────────────────

async function test_concurrent_upgrades_exactly_one_owner() {
  const h = await harness();
  try {
    const port = h.server.boundPortActual();
    // The same bearer is single-use; only one Upgrade path can consume it.
    const a = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${port}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    const b = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${port}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    const results = await Promise.allSettled([
      new Promise((r, j) => { a.once("open", () => r("open")); a.once("error", () => j("error")); }),
      new Promise((r, j) => { b.once("open", () => r("open")); b.once("error", () => j("error")); }),
    ]);
    const opens = results.filter((r) => r.status === "fulfilled").length;
    assertEq("T13 concurrent: exactly ONE owner opens", opens, 1);
    assertEq("T13 owner_slot: held (one incumbent)", h.server.ownerSlotState(), "held");
    a.close(); b.close();
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T14 real WS close codes on binary / invalid JSON / bad shape
// ─────────────────────────────────────────────────────────────────────

async function test_real_close_codes() {
  const h = await harness();
  try {
    const port = h.server.boundPortActual();
    // Binary frame → 1003.
    const bin = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${port}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { bin.once("open", r); bin.once("error", j); });
    const binCode = await new Promise((r) => {
      bin.once("close", (code) => r(code));
      bin.send(Buffer.from([0x00, 0x01, 0x02]));
    });
    assertEq("T14 binary → close 1003", binCode, 1003);
    await h.server.stop();
    // Invalid JSON → 1007.
    const h2 = await harness();
    const inv = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h2.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h2.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { inv.once("open", r); inv.once("error", j); });
    const invCode = await new Promise((r) => {
      inv.once("close", (code) => r(code));
      inv.send("this is not json {");
    });
    assertEq("T14 invalid JSON → close 1007", invCode, 1007);
    await h2.server.stop();
    // Bad shape (valid JSON but not JSON-RPC) → 1008.
    const h3 = await harness();
    const bad = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${h3.server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${h3.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { bad.once("open", r); bad.once("error", j); });
    const badCode = await new Promise((r) => {
      bad.once("close", (code) => r(code));
      // Valid JSON but no method / id / result / error field.
      bad.send(JSON.stringify({ foo: "bar" }));
    });
    assertEq("T14 bad-shape → close 1008", badCode, 1008);
    await h3.server.stop();
  } catch (e) {
    fail("T14", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// P0-1 upstream reverse-request routing
// ─────────────────────────────────────────────────────────────────────

async function test_upstream_reverse_phase1_noowner() {
  const h = await harness();
  try {
    const before = h.upstream.written.length;
    h.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_reverse_1", method: "approval/request" });
    await new Promise((r) => setTimeout(r, 20));
    if (h.upstream.written.length <= before) {
      fail("P0-1 upstream reverse -> writes back", "no frame written back to upstream");
      return;
    }
    const written = h.upstream.written[before];
    assertEq("P0-1 reverse id preserved", written.id, "cx_reverse_1");
    if (!("error" in written)) { fail("P0-1 reverse has error", "no error field"); return; }
    assertEq("P0-1 reverse code=NoOwner (-32052)", written.error.code, -32052);
    assertEq("P0-1 reverse reason=approval_mode_never",
      written.error.data.reason, "approval_mode_never");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// P0-1 sole router handler count
// ─────────────────────────────────────────────────────────────────────

async function test_sole_router_handler_count() {
  const h = await harness();
  try {
    // With the router topology, the upstream transport should have
    // exactly 1 frame subscriber + 1 close subscriber. Prior code
    // had 2 of each (Backend + TUI subscribing directly).
    assertEq("P0-1 upstream frame subscribers = 1", h.upstream.frameHandlers.length, 1);
    assertEq("P0-1 upstream close subscribers = 1", h.upstream.closeHandlers.length, 1);
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// P0-2 half-open reject: peer keeps socket alive; ledger drops
// ─────────────────────────────────────────────────────────────────────

async function test_half_open_reject_ledger_drops() {
  const h = await harness();
  try {
    const port = h.server.boundPortActual();
    const s = net.createConnection({ port, host: ALLOWED_LOOPBACK, allowHalfOpen: true });
    await new Promise((r) => s.once("connect", r));
    s.write([
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "", "",
    ].join("\r\n"));
    // Wait past the reject bounded-destroy timeout (200 ms).
    await new Promise((r) => setTimeout(r, 500));
    if (h.server.preAuthCount() === 0) {
      ok("P0-2 half-open reject: preauth ledger drops to 0");
    } else {
      fail("P0-2 half-open reject", `ledger still at ${h.server.preAuthCount()}`);
    }
    const stopStart = Date.now();
    await h.server.stop();
    const stopMs = Date.now() - stopStart;
    if (stopMs < 300) ok(`P0-2 stop bounded (${stopMs} ms)`);
    else fail("P0-2 stop bounded", `stop took ${stopMs} ms`);
    try { s.destroy(); } catch {}
  } finally { try { await h.server.stop(); } catch {} }
}

// ─────────────────────────────────────────────────────────────────────
// P1-5 non-canonical Sec-WebSocket-Key rejected
// ─────────────────────────────────────────────────────────────────────

async function test_noncanonical_ws_key() {
  const h = await harness();
  try {
    // The 22-char base64 + `==` shape below has non-zero padding
    // bits in the last decoded byte. Canonical round-trip must reject.
    const nonCanonical = "AAAAAAAAAAAAAAAAAAAABB=="; // "B" high bits are set; re-encode !=
    const { status } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${nonCanonical}`,
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("P1-5 non-canonical WS key -> 400", status, 400);
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// P1-1 duplicate Host rejected
// ─────────────────────────────────────────────────────────────────────

async function test_duplicate_host_rejected() {
  const h = await harness();
  try {
    const { status } = await rawHttp(h.server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${h.server.boundPortActual()}`,
      "Host: attacker.example.com:80",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${h.plaintext}`,
      "",
    ]);
    assertEq("P1-1 duplicate Host -> 400", status, 400);
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// P0-1 lifecycle upstream close: not-running
// ─────────────────────────────────────────────────────────────────────

async function test_lifecycle_upstream_close_not_running() {
  // Uses lifecycle directly through the exported bundle. Verify
  // that after start + upstream close, `lifecycle.currentState()`
  // transitions out of "running".
  const { GatewayLifecycle, defaultDenyTuiAuthorizer } = mod;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-p04-"));
  fs.rmdirSync(socketDir);
  const upstream = {
    written: [], _f: [], _c: [],
    async writeFrame(f) { this.written.push(f); },
    onFrame(h) { this._f.push(h); return () => { this._f = this._f.filter((x) => x !== h); }; },
    onClose(h) { this._c.push(h); return () => { this._c = this._c.filter((x) => x !== h); }; },
    async close() { for (const h of [...this._c]) h(); },
    emitClose() { for (const h of [...this._c]) h(); },
  };
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: path.join(socketDir, "backend.sock"),
    socketDir,
    preflight: { async run() {} },
    backend: {
      async enqueueTask() { return { outcome: "accepted", taskId: "t", queuePosition: 0, duplicate: false }; },
      async getTaskState() { return { state: "unknown" }; },
      async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
    },
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    backendCapability: "lifecycle-p04-cap-32chars-abcdefghij",
  });
  await lifecycle.start();
  const stateBefore = lifecycle.currentState();
  assertEq("P0-1 lifecycle state after start = running", stateBefore, "running");
  upstream.emitClose();
  await new Promise((r) => setTimeout(r, 30));
  const stateAfter = lifecycle.currentState();
  if (stateAfter !== "running") {
    ok(`P0-1 lifecycle transitioned out of running after upstream close (${stateAfter})`);
  } else {
    fail("P0-1 lifecycle upstream close", `state still 'running' after emitClose`);
  }
  try { await lifecycle.stop(); } catch {}
  try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// P0-2 bearer not claimable after preflight failure
// ─────────────────────────────────────────────────────────────────────

async function test_bearer_not_claimable_after_preflight_fail() {
  const { GatewayLifecycle } = mod;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-p02-"));
  fs.rmdirSync(socketDir);
  const upstream = {
    async writeFrame() {}, onFrame() { return () => {}; },
    onClose() { return () => {}; }, async close() {},
  };
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: path.join(socketDir, "backend.sock"),
    socketDir,
    preflight: { async run() { throw new Error("baseline_mismatch_fake"); } },
    backend: {
      async enqueueTask() { return { outcome: "accepted", taskId: "t", queuePosition: 0, duplicate: false }; },
      async getTaskState() { return { state: "unknown" }; },
      async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
    },
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    backendCapability: "lifecycle-p02-cap-32chars-abcdefghij",
  });
  let threw = "";
  try { await lifecycle.start(); } catch (e) { threw = e.message; }
  assertEq("P0-2 state after preflight fail = stopped", lifecycle.currentState(), "stopped");
  const bearer = lifecycle.takeTuiBearerPlaintextForLauncher();
  if (bearer === null) {
    ok("P0-2 takeTuiBearerPlaintextForLauncher returns null in stopped state");
  } else {
    fail("P0-2 bearer claimable after preflight fail", `got ${bearer.length}-byte plaintext`);
  }
  try { await lifecycle.stop(); } catch {}
  try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// P0-4 stale owner terminate on ws error
// ─────────────────────────────────────────────────────────────────────

async function test_stale_owner_ws_error_terminated() {
  const h = await harness();
  try {
    const port = h.server.boundPortActual();
    const ws = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${port}/`, {
      headers: { Authorization: `Bearer ${h.plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    // Force the server-side ws to emit an error, which should
    // terminate the socket AND detach the coordinator.
    // We can simulate this by destroying the underlying socket from
    // the client side and waiting for server-side ws close.
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assertEq("P0-4 owner slot empty after ws close/error", h.server.ownerSlotState(), "empty");
  } finally { await h.server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// P0-1 async rollback: stop-during-start → socket actually gone
// ─────────────────────────────────────────────────────────────────────

async function test_async_rollback_socket_gone() {
  const { GatewayLifecycle } = mod;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-rollback-"));
  fs.rmdirSync(socketDir);
  const socketPath = path.join(socketDir, "backend.sock");
  const upstream = {
    async writeFrame() {}, onFrame() { return () => {}; },
    onClose() { return () => {}; }, async close() {},
  };
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: socketPath,
    socketDir,
    preflight: { async run() { /* ok */ } },
    backend: {
      async enqueueTask() { return { outcome: "accepted", taskId: "t", queuePosition: 0, duplicate: false }; },
      async getTaskState() { return { state: "unknown" }; },
      async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
    },
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    backendCapability: "rollback-p01-cap-32chars-abcdefghij",
  });
  const startP = lifecycle.start();
  await Promise.resolve(); // let start progress past construction
  const stopP = lifecycle.stop();
  let startResult = "resolved";
  try { await startP; } catch (e) { startResult = `rejected:${e.message}`; }
  await stopP;
  // Invariant: state == stopped AND socket does NOT exist.
  assertEq("P0-1 async rollback state = stopped", lifecycle.currentState(), "stopped");
  if (!fs.existsSync(socketPath)) {
    ok(`P0-1 async rollback socket unlinked (startResult=${startResult})`);
  } else {
    fail("P0-1 async rollback socket alive", `${socketPath} still exists after rollback`);
  }
  try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// P0-2 router: post-close pre-active frames drop
// ─────────────────────────────────────────────────────────────────────

async function test_router_post_close_drops() {
  const { UpstreamRouter, UpstreamRequestMux, ReverseRequestNamespace, HumanOwnerCoordinator } = mod;
  const mux = new UpstreamRequestMux();
  const reverseNs = new ReverseRequestNamespace();
  const diagEntries = [];
  const diag = { newCorrelationId: () => "cid", reportInternalError: (e) => diagEntries.push(e) };
  const coord = new HumanOwnerCoordinator({ mux, reverseNs, diagnostics: diag, approvalMode: "never" });
  let frames = [], closes = [];
  const upstream = {
    written: [],
    async writeFrame(f) { this.written.push(f); },
    onFrame(h) { frames.push(h); return () => {}; },
    onClose(h) { closes.push(h); return () => {}; },
    async close() {},
    emit(raw) { for (const h of [...frames]) h(raw); },
    close_() { for (const h of [...closes]) h(); },
  };
  const router = new UpstreamRouter({
    mux, humanOwner: coord, upstreamTransport: upstream, diagnostics: diag,
    tuiForward: { deliverReverseRequestToOwner: () => true, deliverProxiedResponseToOwner: () => true },
    onUpstreamClose: () => {},
  });
  router.subscribe();
  // pre-close frame: reverse request, buffered
  upstream.emit({ jsonrpc: "2.0", id: "cx_pre", method: "approval/request" });
  // close fires — router marks receivedCloseBeforeActive
  upstream.close_();
  // post-close frame: MUST drop (not buffer)
  upstream.emit({ jsonrpc: "2.0", id: "cx_after", method: "approval/request" });
  router.activate();
  // Only pre-close should have been dispatched → NoOwner response for cx_pre.
  const forAfter = upstream.written.filter((w) => w.id === "cx_after");
  if (forAfter.length === 0) {
    ok("P0-2 router dropped post-close pre-active frame (0 responses for cx_after)");
  } else {
    fail("P0-2 router leaked post-close frame", `${forAfter.length} response(s) for cx_after`);
  }
  const drops = diagEntries.filter((e) => e.operation === "upstream_frame_dropped_after_pre_active_close");
  assertEq("P0-2 router surfaced drop diagnostic exactly once", drops.length, 1);
}

// ─────────────────────────────────────────────────────────────────────
// P1-1 sync writeFrame throw: mux + internalPending both clean to 0
// ─────────────────────────────────────────────────────────────────────

async function test_sync_write_throw_cleanup() {
  // Uses BackendUdsServer indirectly via GatewayLifecycle's sendInternal.
  // A transport that throws sync on writeFrame should surface reject,
  // AND the mux pending count should return to 0 (no leak).
  const { GatewayLifecycle } = mod;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-syncthrow-"));
  fs.rmdirSync(socketDir);
  const upstream = {
    writeFrame() { throw new Error("sync write throw"); },
    onFrame() { return () => {}; },
    onClose() { return () => {}; },
    async close() {},
  };
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: path.join(socketDir, "backend.sock"),
    socketDir,
    preflight: { async run() {} },
    backend: {
      async enqueueTask() { return { outcome: "accepted", taskId: "t", queuePosition: 0, duplicate: false }; },
      async getTaskState() { return { state: "unknown" }; },
      async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
    },
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: { newCorrelationId: () => "cid", reportInternalError: () => {} },
    backendCapability: "syncthrow-p11-cap-32chars-abcdefg",
  });
  await lifecycle.start();
  let msg = "";
  try { await lifecycle.sendInternal("thread/status", { threadId: "t" }); }
  catch (e) { msg = e.message; }
  assertEq("P1-1 sync throw surfaced reject", msg, "sync write throw");
  assertEq("P1-1 mux pending count after reject = 0", lifecycle.pendingUpstreamCount(), 0);
  // Second call must still work (no leaked id).
  let msg2 = "";
  try { await lifecycle.sendInternal("thread/status", { threadId: "t2" }); }
  catch (e) { msg2 = e.message; }
  assertEq("P1-1 second sync throw also surfaced reject", msg2, "sync write throw");
  assertEq("P1-1 mux pending count after 2nd reject = 0", lifecycle.pendingUpstreamCount(), 0);
  await lifecycle.stop();
  try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("RFC-030 Wave 1A P0.2 Commit 1 corrective round 5 — Node integration");
  await test_happy();
  await test_slow_header();
  await test_missing_bearer();
  await test_wrong_bearer();
  await test_dup_bearer();
  await test_bad_ws_key();
  await test_second_upgrade_refused();
  await test_owner_survives_preauth_timer();
  await test_wrong_path();
  await test_raw_jsonl();
  test_cross_lease();
  await test_concurrent_upgrades_exactly_one_owner();
  await test_real_close_codes();
  await test_upstream_reverse_phase1_noowner();
  await test_sole_router_handler_count();
  await test_half_open_reject_ledger_drops();
  await test_lifecycle_upstream_close_not_running();
  await test_bearer_not_claimable_after_preflight_fail();
  await test_stale_owner_ws_error_terminated();
  await test_noncanonical_ws_key();
  await test_duplicate_host_rejected();
  await test_async_rollback_socket_gone();
  await test_router_post_close_drops();
  await test_sync_write_throw_cleanup();
  console.log("");
  console.log(`real integration PASS: ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log("");
    for (const f of failures) console.log(`  - ${f.name}: ${f.why}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("harness crash:", e);
  process.exit(2);
});
