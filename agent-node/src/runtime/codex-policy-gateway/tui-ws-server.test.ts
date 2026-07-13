// RFC-030 Wave 1A P0.2 — tui-ws-server.ts class-level tests.
//
// These are bun-test (unit) tests. Real HTTP + WebSocket wire behavior
// lives in `tui-ws-server.node-integration.mjs`, which runs under
// production Node — this is because Bun's `node:http` upgrade shim
// currently silently drops bytes written to the upgrade socket
// (verified via two-side repro on Bun 1.3.14 vs Node 20.20), and the
// production runtime target is Node.
//
// The bun-test suite covers:
//   - the constants export shape
//   - `mintOwnerLeaseId` (branded string, correct length, distinct per
//     call, produced from the frozen `asOwnerLeaseId` brand)
//   - `TuiWsServer` construction with the required option surface
//   - bind assertion (start + boundPortActual + stop)
//   - owner-slot state accessor before any wire traffic
//
// Real-wire evidence (401/400/404/handshake round-trip) is produced by
// the Node-run integration script and reported as a separate line in
// the ship report per 副指挥 7034c5ce item #13.

import { describe, expect, test } from "bun:test";
import {
  TUI_HTTP_HEADER_TIMEOUT_MS,
  TUI_MAX_PREAUTH_SOCKETS,
  TUI_WS_MAX_PAYLOAD,
  TuiWsServer,
  type TuiWsServerOptions,
  mintOwnerLeaseId,
} from "./tui-ws-server";
import { TuiBearer } from "./bearer";
import { HumanOwnerCoordinator } from "./human-owner";
import {
  ReverseRequestNamespace,
  UpstreamRequestMux,
  type ProtocolDiagnostics,
  type TuiInitializeProvider,
  type TuiRequestAuthorizer,
} from "./protocol";
import { asOwnerLeaseId } from "./contract";

// ─────────────────────────────────────────────────────────────────────
// Constants pin
// ─────────────────────────────────────────────────────────────────────

describe("constants export shape", () => {
  test("payload cap + timeout / preauth cap pin (no 128 KiB semantic cap on TUI face)", () => {
    // WS payload cap is 1 MiB. Corrective (副指挥 a1ed1589 self-
    // check): TUI wire is NOT subject to the frozen Agent-side
    // 128 KiB semantic cap. The prior *8 estimator gate has been
    // removed; there is no `TUI_WS_SEMANTIC_TEXT_CAP` export.
    expect(TUI_WS_MAX_PAYLOAD).toBe(1 * 1024 * 1024);
    expect(TUI_HTTP_HEADER_TIMEOUT_MS).toBe(3_000);
    expect(TUI_MAX_PREAUTH_SOCKETS).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────
// mintOwnerLeaseId
// ─────────────────────────────────────────────────────────────────────

describe("mintOwnerLeaseId — brand + entropy", () => {
  test("returns a 43-char base64url string branded as OwnerLeaseId", () => {
    const lease = mintOwnerLeaseId();
    expect(typeof lease).toBe("string");
    expect((lease as unknown as string)).toHaveLength(43);
    expect((lease as unknown as string)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("two mints produce distinct leases", () => {
    const a = mintOwnerLeaseId();
    const b = mintOwnerLeaseId();
    expect(a).not.toBe(b);
  });

  test("frozen brand `asOwnerLeaseId` is REUSED (no duplicate brand)", () => {
    // The mint helper produces values assignable to the frozen brand.
    const lease = mintOwnerLeaseId();
    // If we wanted to widen the brand at will we'd need `asOwnerLeaseId`;
    // asserting the round-trip proves the brand is the SAME identity.
    const reBranded = asOwnerLeaseId(lease as unknown as string);
    expect(reBranded).toBe(lease);
  });
});

// ─────────────────────────────────────────────────────────────────────
// TuiWsServer construction + bind + stop
// ─────────────────────────────────────────────────────────────────────

function makeMinimalOpts(): TuiWsServerOptions & { bearerPlaintext: string } {
  const bearer = TuiBearer.mint();
  const bearerPlaintext = bearer.takePlaintextForLauncher()!;
  const diagnostics: ProtocolDiagnostics = {
    newCorrelationId: () => "cid",
    reportInternalError: () => {},
  };
  const mux = new UpstreamRequestMux<{ label: string }>();
  const reverseNs = new ReverseRequestNamespace();
  const humanOwner = new HumanOwnerCoordinator({
    mux: mux as unknown as UpstreamRequestMux<unknown>,
    reverseNs,
    diagnostics,
    approvalMode: "never",
  });
  const initProvider: TuiInitializeProvider = {
    currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" } }),
  };
  const authorizer: TuiRequestAuthorizer = {
    async authorize() {
      return {
        verdict: "deny",
        code: 0 as unknown as never,
        reason: "default-deny",
      };
    },
  };
  // Minimal fake upstream — no-op transport (unit tests here don't
  // drive reverse-request wire behaviour; that's the Node integration).
  const upstreamTransport = {
    async writeFrame() { return; },
    onFrame(_h: (raw: unknown) => void) { return () => {}; },
    onClose(_h: () => void) { return () => {}; },
    async close() { return; },
  };
  return {
    bearer, humanOwner, authorizer, initProvider, diagnostics,
    upstreamTransport,
    bearerPlaintext,
  } as unknown as TuiWsServerOptions & { bearerPlaintext: string };
}

describe("TuiWsServer — construction + bind + stop", () => {
  test("start binds a nonzero ephemeral port; ownerSlotState=empty pre-attach", async () => {
    const opts = makeMinimalOpts();
    const server = new TuiWsServer(opts);
    try {
      await server.start();
      const port = server.boundPortActual();
      expect(port).toBeGreaterThan(0);
      expect(server.ownerSlotState()).toBe("empty");
      // 副指挥 3ed5c004 P1-4: currentLease() accessor removed; owner
      // state is observable only via ownerSlotState().
    } finally {
      await server.stop();
    }
  });

  test("second start throws until stop resets", async () => {
    const opts = makeMinimalOpts();
    const server = new TuiWsServer(opts);
    await server.start();
    try {
      await expect(server.start()).rejects.toThrow(/already running/);
    } finally { await server.stop(); }
  });

  test("stop is idempotent (safe on cold path)", async () => {
    const opts = makeMinimalOpts();
    const server = new TuiWsServer(opts);
    // Never started — stop should be a safe no-op.
    await server.stop();
    // Also safe post-start.
    await server.start();
    await server.stop();
    await server.stop();
  });

  test("two independent servers bind distinct ports on 127.0.0.1", async () => {
    const optsA = makeMinimalOpts();
    const optsB = makeMinimalOpts();
    const a = new TuiWsServer(optsA);
    const b = new TuiWsServer(optsB);
    try {
      await a.start();
      await b.start();
      expect(a.boundPortActual()).not.toBe(b.boundPortActual());
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
