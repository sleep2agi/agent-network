// RFC-030 Wave 1A Segment B — human-owner tests.
//
// Coverage:
//   - Phase 1 approvalMode="never": every reverse request refused
//     with NoOwner + stable data.code + reason="approval_mode_never",
//     regardless of TUI attachment. No allocation on reverseNs.
//   - Phase 2 approvalMode="passthrough":
//       no TUI → NoOwner reason=tui_not_attached
//       TUI attached → forward_tui with fresh tuiId; reverseNs holds
//                      one pending
//       reverse id collision → InvalidArg reason=reverse_id_collision
//   - TUI response frame:
//       known reverse id → forward_reverse_response with original codex id
//       unknown / duplicate consume → reject fail-closed
//   - detachTui drains proxied-TUI half of mux + reverseNs; internal
//     pending untouched.
//   - Reconnect after detach: prior reverse id can NOT be re-approved.

import { describe, expect, test } from "bun:test";
import {
  HumanOwnerCoordinator,
  type HumanOwnerCoordinatorOptions,
} from "./human-owner";
import {
  ReverseRequestNamespace,
  UpstreamRequestMux,
  type ProtocolDiagnostics,
  type JsonRpcRequestFrame,
} from "./protocol";
import { GATEWAY_ERROR_DATA_CODE, GatewayErrorCode, asOwnerLeaseId } from "./contract";

// Test-local lease helpers. `asOwnerLeaseId` is the frozen brand from
// contract.ts; we reuse it here rather than re-exporting a new brand.
const L1 = asOwnerLeaseId("lease-1-test-abc");
const L2 = asOwnerLeaseId("lease-2-test-xyz");

function makeCoord(opts?: Partial<HumanOwnerCoordinatorOptions>): {
  coord: HumanOwnerCoordinator;
  mux: UpstreamRequestMux<{ label: string }>;
  reverseNs: ReverseRequestNamespace;
} {
  const mux = new UpstreamRequestMux<{ label: string }>();
  const reverseNs = new ReverseRequestNamespace();
  const diagnostics: ProtocolDiagnostics = {
    newCorrelationId: () => "cid",
    reportInternalError: () => {},
  };
  const coord = new HumanOwnerCoordinator({
    mux: mux as unknown as UpstreamRequestMux<unknown>,
    reverseNs,
    diagnostics,
    approvalMode: opts?.approvalMode ?? "never",
    ...opts,
  });
  return { coord, mux, reverseNs };
}

const CODEX_REVERSE_REQUEST: JsonRpcRequestFrame = {
  jsonrpc: "2.0",
  id: "cx_1",
  method: "approval/request",
  params: { command: "rm -rf /" },
};

describe("HumanOwnerCoordinator — Phase 1 approvalMode='never' (default)", () => {
  test("reverse request refused even if TUI attached — defense in depth", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "never" });
    coord.attachTui(L1);
    const out = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (out.kind !== "reject_upstream") throw new Error(`expected reject, got ${out.kind}`);
    if (!("error" in out.upstreamError)) throw new Error("expected error frame");
    expect(out.upstreamError.id).toBe("cx_1");
    expect(out.upstreamError.error.code).toBe(GatewayErrorCode.NoOwner);
    const data = out.upstreamError.error.data as Record<string, unknown>;
    expect(data.code).toBe(GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.NoOwner]);
    expect(data.code).toBe("codex_gateway_no_owner");
    expect(data.reason).toBe("approval_mode_never");
    // reverseNs was NOT touched — no allocation, so no drain leak.
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("reverse request refused when TUI NOT attached — same code + reason", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "never" });
    const out = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (out.kind !== "reject_upstream") throw new Error("expected reject");
    if (!("error" in out.upstreamError)) throw new Error("expected error frame");
    const data = out.upstreamError.error.data as Record<string, unknown>;
    expect(data.reason).toBe("approval_mode_never");
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("approvalMode() reports 'never'; default is 'never' if not overridden", () => {
    const { coord } = makeCoord();
    expect(coord.approvalMode()).toBe("never");
  });
});

describe("HumanOwnerCoordinator — Phase 2 approvalMode='passthrough'", () => {
  test("no TUI attached → NoOwner reason=tui_not_attached", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    const out = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (out.kind !== "reject_upstream") throw new Error("expected reject");
    if (!("error" in out.upstreamError)) throw new Error("expected error");
    expect(out.upstreamError.error.code).toBe(GatewayErrorCode.NoOwner);
    expect((out.upstreamError.error.data as Record<string, unknown>).reason).toBe("tui_not_attached");
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("TUI attached → forward_tui with freshly allocated tuiId, reverseNs holds one pending", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const out = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (out.kind !== "forward_tui") throw new Error(`expected forward_tui, got ${out.kind}`);
    expect(out.tuiFrame.method).toBe("approval/request");
    expect(out.tuiFrame.params).toEqual({ command: "rm -rf /" });
    // tuiId is a number, freshly minted — MUST NOT equal the codex id "cx_1".
    expect(typeof out.tuiFrame.id).toBe("number");
    expect(out.tuiFrame.id).not.toBe("cx_1");
    expect(reverseNs.pendingCount()).toBe(1);
  });

  test("reverse id collision → InvalidArg reason=reverse_id_collision", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    reverseNs.allocateTuiIdForCodexReverseRequest("cx_1"); // pre-existing
    const out = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (out.kind !== "reject_upstream") throw new Error("expected reject");
    if (!("error" in out.upstreamError)) throw new Error("expected error");
    expect(out.upstreamError.error.code).toBe(GatewayErrorCode.InvalidArg);
    const data = out.upstreamError.error.data as Record<string, unknown>;
    expect(data.reason).toBe("reverse_id_collision");
    expect(data.code).toBe(GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.InvalidArg]);
  });

  test("params omitted on codex frame → omitted on tui frame (no false 'params: undefined' key)", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const paramless: JsonRpcRequestFrame = { jsonrpc: "2.0", id: "cx_x", method: "approval/ping" };
    const out = coord.handleUpstreamReverseRequest(paramless);
    if (out.kind !== "forward_tui") throw new Error("expected forward_tui");
    expect("params" in out.tuiFrame).toBe(false);
  });
});

describe("HumanOwnerCoordinator — TUI response frame (approval consumption)", () => {
  test("known tui id → forward_reverse_response with original codex id", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward_tui");
    const tuiId = fwd.tuiFrame.id;
    const resp = coord.handleTuiResponseFrameWithLease(
      { jsonrpc: "2.0", id: tuiId, result: { approved: true } },
      L1,
    );
    if (resp.kind !== "forward_reverse_response") throw new Error(`expected forward, got ${resp.kind}`);
    expect(resp.codexReverseId).toBe("cx_1");
    if ("result" in resp.frame) expect(resp.frame.result).toEqual({ approved: true });
    // Consumed → reverseNs pendingCount back to 0.
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("unknown tui id -> reject reason=lease_mismatch (lease side-map has no entry)", () => {
    // P0.2 corrective (副指挥 a1ed1589 item #11): the lease side-map
    // is checked BEFORE the frozen reverseNs consume. An unknown
    // tuiId therefore lands on `lease_mismatch` first — the frozen
    // namespace is never consulted (which is the point: no path
    // exists where a rogue lease could probe the frozen namespace).
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const resp = coord.handleTuiResponseFrameWithLease({ jsonrpc: "2.0", id: 999, result: {} }, L1);
    if (resp.kind !== "reject") throw new Error("expected reject");
    expect(resp.code).toBe(GatewayErrorCode.InvalidArg);
    expect(resp.data.reason).toBe("lease_mismatch");
  });

  test("duplicate consume -> reject reason=lease_mismatch (side-map cleared on first consume)", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const tuiId = fwd.tuiFrame.id;
    const first = coord.handleTuiResponseFrameWithLease({ jsonrpc: "2.0", id: tuiId, result: {} }, L1);
    if (first.kind !== "forward_reverse_response") throw new Error("first should succeed");
    // Replay: side-map entry was cleared during the first consume,
    // so the second call hits lease_mismatch and NEVER touches the
    // frozen namespace (whose count is already 0 too).
    const dup = coord.handleTuiResponseFrameWithLease({ jsonrpc: "2.0", id: tuiId, result: {} }, L1);
    if (dup.kind !== "reject") throw new Error("duplicate must reject");
    expect(dup.data.reason).toBe("lease_mismatch");
    expect(reverseNs.pendingCount()).toBe(0);
  });
});

describe("HumanOwnerCoordinator — TUI attach/detach lifecycle (Δ11 wiring)", () => {
  test("detachTui drains proxied-TUI mux + reverseNs; internal pending untouched", () => {
    const { coord, mux, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    // Set up: a proxied-TUI upstream request + an internal request +
    // a pending reverse request.
    mux.allocateForProxiedTui(1);
    mux.allocateForInternalScheduler({ label: "internal_a" });
    reverseNs.allocateTuiIdForCodexReverseRequest("cx_a");
    expect(mux.pendingCountByKind("proxied_tui")).toBe(1);
    expect(mux.pendingCountByKind("internal")).toBe(1);
    expect(reverseNs.pendingCount()).toBe(1);

    coord.detachTui(L1);

    expect(coord.isTuiAttached()).toBe(false);
    // proxied_tui + reverse namespace drained.
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
    expect(reverseNs.pendingCount()).toBe(0);
    // Internal scheduler pending untouched (Δ11).
    expect(mux.pendingCountByKind("internal")).toBe(1);
  });

  test("reconnect after detach cannot re-approve a drained reverse id", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const staleTuiId = fwd.tuiFrame.id;
    coord.detachTui(L1);
    // Reconnect.
    coord.attachTui(L1);
    // Old TUI id can't re-approve.
    const resp = coord.handleTuiResponseFrameWithLease({ jsonrpc: "2.0", id: staleTuiId, result: {} }, L1);
    if (resp.kind !== "reject") throw new Error("stale id must be rejected");
    // Side-map was cleared on detach; new attach starts empty.
    expect(resp.data.reason).toBe("lease_mismatch");
  });

  test("attachTui is idempotent (double attach doesn't leak state)", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    coord.attachTui(L1);
    expect(coord.isTuiAttached()).toBe(true);
    coord.detachTui(L1);
    expect(coord.isTuiAttached()).toBe(false);
  });

  test("detachTui without attach is a no-op (safe on cold path)", () => {
    const { coord, mux, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.detachTui(L1);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
    expect(reverseNs.pendingCount()).toBe(0);
  });
});

describe("HumanOwnerCoordinator — reverse namespace isolation", () => {
  test("Phase 1 refuse does NOT touch the mux upstream half — internal pending unchanged", () => {
    const { coord, mux } = makeCoord({ approvalMode: "never" });
    coord.attachTui(L1);
    mux.allocateForInternalScheduler({ label: "keep_me" });
    expect(mux.pendingCountByKind("internal")).toBe(1);
    coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    // Refusal doesn't touch the mux.
    expect(mux.pendingCountByKind("internal")).toBe(1);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
  });

  test("Phase 2 forward does NOT allocate anything on the mux upstream half", () => {
    const { coord, mux } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    // Reverse namespace only — the mux is untouched by reverse requests.
    expect(mux.pendingCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P0.2 lease binding (副指挥 7034c5ce items #2 + #11)
// ─────────────────────────────────────────────────────────────────────

describe("P0.2 lease binding — cross-lease refusal + stale-detach no-op", () => {
  test("handleTuiResponseFrameWithLease: matching lease → forward_reverse_response (frozen consume)", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const tuiId = fwd.tuiFrame.id;
    const resp = coord.handleTuiResponseFrameWithLease(
      { jsonrpc: "2.0", id: tuiId, result: { approved: true } },
      L1,
    );
    if (resp.kind !== "forward_reverse_response") throw new Error(`expected forward, got ${resp.kind}`);
    expect(resp.codexReverseId).toBe("cx_1");
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("handleTuiResponseFrameWithLease: MISMATCHED lease → reject lease_mismatch, frozen ReverseRequestNamespace UNTOUCHED", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const tuiId = fwd.tuiFrame.id;
    const before = reverseNs.pendingCount();
    // A second/impostor lease presenting the correct tuiId is refused.
    const resp = coord.handleTuiResponseFrameWithLease(
      { jsonrpc: "2.0", id: tuiId, result: { approved: true } },
      L2,
    );
    if (resp.kind !== "reject") throw new Error(`expected reject, got ${resp.kind}`);
    expect(resp.code).toBe(GatewayErrorCode.InvalidArg);
    expect(resp.data.reason).toBe("lease_mismatch");
    // Frozen namespace was NOT consumed.
    expect(reverseNs.pendingCount()).toBe(before);
  });

  test("detachTui with mismatched lease → no-op; incumbent state fully preserved", () => {
    const { coord, mux, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui(L1);
    mux.allocateForProxiedTui(1);
    coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(1);
    expect(reverseNs.pendingCount()).toBe(1);
    // Stale detach from a non-incumbent lease — must be a no-op.
    coord.detachTui(L2);
    expect(coord.isTuiAttached()).toBe(true);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(1);
    expect(reverseNs.pendingCount()).toBe(1);
    // Matching detach cleanly drains.
    coord.detachTui(L1);
    expect(coord.isTuiAttached()).toBe(false);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("attachTui with lease already active → typed refused; incumbent preserved", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    const first = coord.attachTui(L1);
    expect(first.kind).toBe("ok");
    expect(coord.attachSnapshot().attached).toBe(true);
    const second = coord.attachTui(L2);
    if (second.kind !== "refused") throw new Error("expected refused");
    expect(second.reason).toBe("already_held");
    // Verify the L2 lease didn't take over by consuming a reverse
    // response with L1 (must succeed) then trying with L2 (must
    // lease_mismatch).
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const tuiId = fwd.tuiFrame.id;
    const l2Resp = coord.handleTuiResponseFrameWithLease(
      { jsonrpc: "2.0", id: tuiId, result: {} }, L2,
    );
    expect(l2Resp.kind).toBe("reject");
    const l1Resp = coord.handleTuiResponseFrameWithLease(
      { jsonrpc: "2.0", id: tuiId, result: {} }, L1,
    );
    expect(l1Resp.kind).toBe("forward_reverse_response");
  });

  test("attach → detach → attach with fresh lease works normally after clean detach", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    expect(coord.attachTui(L1).kind).toBe("ok");
    coord.detachTui(L1);
    expect(coord.attachSnapshot().attached).toBe(false);
    expect(coord.attachTui(L2).kind).toBe("ok");
    expect(coord.attachSnapshot().attached).toBe(true);
  });
});
