// RFC-030 Wave 1A P0.2 — Node-run integration harness.
//
// Runs under production Node (not bun test) so the real `node:http`
// upgrade path + `ws` server behave as they will in production.
// Bun's `node:http` upgrade shim currently drops bytes written to
// the upgrade socket (repro-ed 2026-07-12 on bun 1.3.14 vs Node
// 20.20); this harness exercises the wire path that bun-test can't.
//
// Reports:
//   real integration PASS: N/N
//
// on stdout. Non-zero exit on any failure.
//
// This script is TypeScript-free on purpose so it runs directly under
// `node` without any compile step. It imports the compiled bundle
// produced by `bun build` (see `bun run test:node-integration`).

import { WebSocket } from "ws";
import * as net from "node:net";

const BUNDLE = process.env.RFC030_BUNDLE ?? "./dist/rfc030-integration.mjs";
const mod = await import(BUNDLE);
const {
  TuiWsServer,
  TuiBearer,
  HumanOwnerCoordinator,
  UpstreamRequestMux,
  ReverseRequestNamespace,
  mintOwnerLeaseId,
  asOwnerLeaseId,
} = mod;

const ALLOWED_LOOPBACK = "127.0.0.1";
let passed = 0;
let failed = 0;
const failures = [];

function ok(name) { passed++; console.log(`  ok  ${name}`); }
function fail(name, why) { failed++; failures.push({ name, why }); console.log(`  FAIL ${name}: ${why}`); }

async function assertEq(name, actual, expected) {
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

async function harness() {
  const { coord, diag } = makeCoord();
  const bearer = TuiBearer.mint();
  const plaintext = bearer.takePlaintextForLauncher();
  const server = new TuiWsServer({
    bearer,
    humanOwner: coord,
    authorizer: { async authorize() { return { verdict: "deny", code: 0, reason: "default-deny" }; } },
    initProvider: { currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" } }) },
    diagnostics: {
      newCorrelationId: () => "cid",
      reportInternalError: (e) => { diag.entries.push(e); },
    },
  });
  await server.start();
  return { server, bearer, plaintext, coord, diag };
}

function rawHttp(port, lines) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ port, host: ALLOWED_LOOPBACK });
    let buf = "";
    s.on("data", (c) => { buf += c.toString("utf8"); });
    s.on("close", () => {
      const idx = buf.indexOf("\r\n\r\n");
      const head = idx === -1 ? buf : buf.slice(0, idx);
      const body = idx === -1 ? "" : buf.slice(idx + 4);
      const firstLine = head.split("\r\n")[0] ?? "";
      const m = firstLine.match(/^HTTP\/1\.1\s+(\d+)/);
      resolve({ status: m ? Number(m[1]) : 0, body });
    });
    s.on("error", reject);
    s.on("connect", () => s.write(lines.join("\r\n") + "\r\n"));
    setTimeout(() => { try { s.destroy(); } catch {} }, 1500);
  });
}

// ─────────────────────────────────────────────────────────────────────
// T1 happy path
// ─────────────────────────────────────────────────────────────────────

async function test_happy() {
  const { server, plaintext } = await harness();
  try {
    const ws = new WebSocket(`ws://${ALLOWED_LOOPBACK}:${server.boundPortActual()}/`, {
      headers: { Authorization: `Bearer ${plaintext}` },
      perMessageDeflate: false,
    });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    const reply = await new Promise((r, j) => {
      ws.once("message", (d) => r(JSON.parse(d.toString())));
      ws.once("error", j);
      // Real 0.144.0: no jsonrpc field on initialize.
      ws.send(JSON.stringify({ id: "initialize", method: "initialize", params: {} }));
    });
    await assertEq("T1 happy: reply.id === 'initialize'", reply.id, "initialize");
    await assertEq("T1 happy: server.name === 'codex'", reply.result.serverInfo.name, "codex");
    ws.close();
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T3 missing Authorization → uniform 401
// ─────────────────────────────────────────────────────────────────────

async function test_missing_bearer() {
  const { server } = await harness();
  try {
    const { status, body } = await rawHttp(server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
    ]);
    await assertEq("T3 missing bearer: status = 401", status, 401);
    await assertEq("T3 missing bearer: body = 'unauthorized'", body, "unauthorized");
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T4 wrong Bearer → uniform 401; secret not echoed
// ─────────────────────────────────────────────────────────────────────

async function test_wrong_bearer() {
  const { server } = await harness();
  try {
    const bogus = "not-the-real-bearer-abc123def456";
    const { status, body } = await rawHttp(server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${bogus}`,
      "",
    ]);
    await assertEq("T4 wrong bearer: status = 401", status, 401);
    await assertEq("T4 wrong bearer: body = 'unauthorized'", body, "unauthorized");
    if (body.includes(bogus)) fail("T4 wrong bearer: no echo", "bogus present in body");
    else ok("T4 wrong bearer: no echo");
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T5 duplicate Authorization → 400
// ─────────────────────────────────────────────────────────────────────

async function test_dup_bearer() {
  const { server, plaintext } = await harness();
  try {
    const { status, body } = await rawHttp(server.boundPortActual(), [
      "GET / HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${plaintext}`,
      `Authorization: Bearer smuggled-second-value-abc123`,
      "",
    ]);
    await assertEq("T5 dup Authorization: status = 400", status, 400);
    await assertEq("T5 dup Authorization: body = 'bad_request'", body, "bad_request");
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T12 wrong path → 404
// ─────────────────────────────────────────────────────────────────────

async function test_wrong_path() {
  const { server, plaintext } = await harness();
  try {
    const { status, body } = await rawHttp(server.boundPortActual(), [
      "GET /rpc HTTP/1.1",
      `Host: ${ALLOWED_LOOPBACK}:${server.boundPortActual()}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Authorization: Bearer ${plaintext}`,
      "",
    ]);
    await assertEq("T12 /rpc → 404", status, 404);
    await assertEq("T12 /rpc → body='not_found'", body, "not_found");
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T11 raw JSONL (no Upgrade) → no JSON layer reached
// ─────────────────────────────────────────────────────────────────────

async function test_raw_jsonl() {
  const { server } = await harness();
  try {
    const buf = await new Promise((resolve) => {
      const s = net.createConnection({ port: server.boundPortActual(), host: ALLOWED_LOOPBACK });
      let b = "";
      s.on("data", (c) => { b += c.toString("utf8"); });
      s.on("close", () => resolve(b));
      s.on("connect", () => s.write(JSON.stringify({ id: 1, method: "initialize" }) + "\n"));
      setTimeout(() => { try { s.destroy(); } catch {} }, 400);
    });
    if (buf.includes("serverInfo") || buf.includes("codex-policy-gateway")) {
      fail("T11 raw JSONL: no JSON layer reached", `unexpected body: ${buf}`);
    } else {
      ok("T11 raw JSONL: no JSON layer reached");
    }
  } finally { await server.stop(); }
}

// ─────────────────────────────────────────────────────────────────────
// T8 cross-lease refusal
// ─────────────────────────────────────────────────────────────────────

async function test_cross_lease() {
  const { coord } = (function () {
    const mux = new UpstreamRequestMux();
    const reverseNs = new ReverseRequestNamespace();
    const diag = { newCorrelationId: () => "cid", reportInternalError: () => {} };
    return { coord: new HumanOwnerCoordinator({ mux, reverseNs, diagnostics: diag, approvalMode: "passthrough" }), mux, reverseNs };
  })();
  const L1 = asOwnerLeaseId("L1-lease-integration-abc");
  const L2 = asOwnerLeaseId("L2-lease-integration-xyz");
  coord.attachTui(L1);
  const fwd = coord.handleUpstreamReverseRequest({
    jsonrpc: "2.0", id: "cx_ci", method: "approval/request",
  });
  if (fwd.kind !== "forward_tui") return fail("T8 setup", `expected forward_tui, got ${fwd.kind}`);
  const rej = coord.handleTuiResponseFrameWithLease(
    { jsonrpc: "2.0", id: fwd.tuiFrame.id, result: {} },
    L2,
  );
  await assertEq("T8 cross-lease: reject", rej.kind, "reject");
  await assertEq("T8 cross-lease: reason=lease_mismatch", rej.data.reason, "lease_mismatch");
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("RFC-030 Wave 1A P0.2 — Node-run real integration");
  await test_happy();
  await test_missing_bearer();
  await test_wrong_bearer();
  await test_dup_bearer();
  await test_wrong_path();
  await test_raw_jsonl();
  await test_cross_lease();
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
