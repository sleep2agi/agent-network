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
import { GATEWAY_ERROR_DATA_CODE, GatewayErrorCode } from "./contract";

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
    coord.attachTui();
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
    coord.attachTui();
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
    coord.attachTui();
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
    coord.attachTui();
    const paramless: JsonRpcRequestFrame = { jsonrpc: "2.0", id: "cx_x", method: "approval/ping" };
    const out = coord.handleUpstreamReverseRequest(paramless);
    if (out.kind !== "forward_tui") throw new Error("expected forward_tui");
    expect("params" in out.tuiFrame).toBe(false);
  });
});

describe("HumanOwnerCoordinator — TUI response frame (approval consumption)", () => {
  test("known tui id → forward_reverse_response with original codex id", () => {
    const { coord, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward_tui");
    const tuiId = fwd.tuiFrame.id;
    const resp = coord.handleTuiResponseFrame({
      jsonrpc: "2.0", id: tuiId, result: { approved: true },
    });
    if (resp.kind !== "forward_reverse_response") throw new Error(`expected forward, got ${resp.kind}`);
    expect(resp.codexReverseId).toBe("cx_1");
    if ("result" in resp.frame) expect(resp.frame.result).toEqual({ approved: true });
    // Consumed → reverseNs pendingCount back to 0.
    expect(reverseNs.pendingCount()).toBe(0);
  });

  test("unknown tui id → reject reason=reverse_id_unknown_or_duplicate", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    const resp = coord.handleTuiResponseFrame({ jsonrpc: "2.0", id: 999, result: {} });
    if (resp.kind !== "reject") throw new Error("expected reject");
    expect(resp.code).toBe(GatewayErrorCode.InvalidArg);
    expect(resp.data.reason).toBe("reverse_id_unknown_or_duplicate");
  });

  test("duplicate consume → reject (approval spoof / replay protection)", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const tuiId = fwd.tuiFrame.id;
    // First — succeeds.
    const first = coord.handleTuiResponseFrame({ jsonrpc: "2.0", id: tuiId, result: {} });
    if (first.kind !== "forward_reverse_response") throw new Error("first should succeed");
    // Replay — refused.
    const dup = coord.handleTuiResponseFrame({ jsonrpc: "2.0", id: tuiId, result: {} });
    if (dup.kind !== "reject") throw new Error("duplicate must reject");
    expect(dup.data.reason).toBe("reverse_id_unknown_or_duplicate");
  });
});

describe("HumanOwnerCoordinator — TUI attach/detach lifecycle (Δ11 wiring)", () => {
  test("detachTui drains proxied-TUI mux + reverseNs; internal pending untouched", () => {
    const { coord, mux, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    // Set up: a proxied-TUI upstream request + an internal request +
    // a pending reverse request.
    mux.allocateForProxiedTui(1);
    mux.allocateForInternalScheduler({ label: "internal_a" });
    reverseNs.allocateTuiIdForCodexReverseRequest("cx_a");
    expect(mux.pendingCountByKind("proxied_tui")).toBe(1);
    expect(mux.pendingCountByKind("internal")).toBe(1);
    expect(reverseNs.pendingCount()).toBe(1);

    coord.detachTui();

    expect(coord.isTuiAttached()).toBe(false);
    // proxied_tui + reverse namespace drained.
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
    expect(reverseNs.pendingCount()).toBe(0);
    // Internal scheduler pending untouched (Δ11).
    expect(mux.pendingCountByKind("internal")).toBe(1);
  });

  test("reconnect after detach cannot re-approve a drained reverse id", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    const fwd = coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    if (fwd.kind !== "forward_tui") throw new Error("expected forward");
    const staleTuiId = fwd.tuiFrame.id;
    coord.detachTui();
    // Reconnect.
    coord.attachTui();
    // Old TUI id can't re-approve.
    const resp = coord.handleTuiResponseFrame({ jsonrpc: "2.0", id: staleTuiId, result: {} });
    if (resp.kind !== "reject") throw new Error("stale id must be rejected");
    expect(resp.data.reason).toBe("reverse_id_unknown_or_duplicate");
  });

  test("attachTui is idempotent (double attach doesn't leak state)", () => {
    const { coord } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    coord.attachTui();
    expect(coord.isTuiAttached()).toBe(true);
    coord.detachTui();
    expect(coord.isTuiAttached()).toBe(false);
  });

  test("detachTui without attach is a no-op (safe on cold path)", () => {
    const { coord, mux, reverseNs } = makeCoord({ approvalMode: "passthrough" });
    coord.detachTui();
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
    expect(reverseNs.pendingCount()).toBe(0);
  });
});

describe("HumanOwnerCoordinator — reverse namespace isolation", () => {
  test("Phase 1 refuse does NOT touch the mux upstream half — internal pending unchanged", () => {
    const { coord, mux } = makeCoord({ approvalMode: "never" });
    coord.attachTui();
    mux.allocateForInternalScheduler({ label: "keep_me" });
    expect(mux.pendingCountByKind("internal")).toBe(1);
    coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    // Refusal doesn't touch the mux.
    expect(mux.pendingCountByKind("internal")).toBe(1);
    expect(mux.pendingCountByKind("proxied_tui")).toBe(0);
  });

  test("Phase 2 forward does NOT allocate anything on the mux upstream half", () => {
    const { coord, mux } = makeCoord({ approvalMode: "passthrough" });
    coord.attachTui();
    coord.handleUpstreamReverseRequest(CODEX_REVERSE_REQUEST);
    // Reverse namespace only — the mux is untouched by reverse requests.
    expect(mux.pendingCount()).toBe(0);
  });
});
