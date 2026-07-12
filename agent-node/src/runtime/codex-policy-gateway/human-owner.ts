// RFC-030 Wave 1A Segment B — human-owner.ts
//
// The HumanOwnerCoordinator is the SOLE holder of the reverse-request
// namespace and the sole arbiter of TUI-side approval routing. The
// Agent socket never has a handle to any of this — the Agent typed
// contract carries no request ids, no reverse-request state, and no
// way to construct approval frames (see contract.ts).
//
// Segment B split from uds-server (per 副指挥 2b40d91e plan):
//   - Reverse-request namespace + attach/detach lifecycle live here.
//   - uds-server delegates every "codex reverse request arrived" and
//     "tui response frame arrived" event through this coordinator.
//   - Phase 1 (approval=never) config gate: the coordinator refuses
//     to forward reverse requests to the TUI even if one is attached,
//     unless the Phase 2 config bit is explicitly set. The dispatch
//     STRUCTURE is preserved so Phase 2 turn-on is a config flip.
//   - TUI disconnect: drain the reverse namespace + drain the
//     proxied-TUI half of the frozen mux. Internal scheduler
//     Promises are UNAFFECTED.
//   - Reconnect never replays a drained reverse request; no re-
//     approval can occur.

import {
  handleTuiResponseFrame,
  ReverseRequestNamespace,
  UpstreamRequestMux,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcRequestId,
  type ProtocolDiagnostics,
  type TuiResponseOutcome,
} from "./protocol";
import {
  GATEWAY_ERROR_DATA_CODE,
  GatewayErrorCode,
  type GatewayErrorData,
} from "./contract";

// ────────────────────────────────────────────────────────────────────────
// Approval mode — Phase 1 pins "never"
// ────────────────────────────────────────────────────────────────────────

/**
 * Approval mode governs whether the coordinator is willing to forward
 * a Codex reverse request to the TUI at all.
 *
 * `"never"` (Phase 1 default): the gateway refuses to relay any
 * reverse request; the caller writes a fail-closed error back upstream.
 * Upstream Codex is configured with approval=never so this path
 * shouldn't fire in practice; the guard is defense-in-depth.
 *
 * `"passthrough"` (Phase 2): the gateway allocates a fresh TUI-side
 * id via the reverse namespace and hands the frame back for
 * transport to the TUI socket. Enabling this is a config change,
 * NOT a code change.
 */
export type ApprovalMode = "never" | "passthrough";

// ────────────────────────────────────────────────────────────────────────
// Outcome types — pure data, transport writes them
// ────────────────────────────────────────────────────────────────────────

/**
 * Result of asking the coordinator what to do with an upstream reverse
 * request. `forward_tui` includes the allocated TUI-side id via the
 * rewritten frame; the transport writes it on the TUI socket.
 * `reject_upstream` includes a complete JSON-RPC error frame keyed on
 * the ORIGINAL codex reverse id so the transport can send it back to
 * upstream Codex verbatim.
 */
export type ReverseRequestOutcome =
  | {
    readonly kind: "forward_tui";
    readonly tuiFrame: JsonRpcRequestFrame;
  }
  | {
    readonly kind: "reject_upstream";
    readonly upstreamError: JsonRpcResponseFrame;
  };

/**
 * Result of consuming a TUI response frame. Wraps
 * `handleTuiResponseFrame` output verbatim so callers don't have to
 * re-import `TuiResponseOutcome` from the protocol layer.
 */
export type TuiResponseHandling = TuiResponseOutcome;

// ────────────────────────────────────────────────────────────────────────
// HumanOwnerCoordinator
// ────────────────────────────────────────────────────────────────────────

export interface HumanOwnerCoordinatorOptions {
  readonly mux: UpstreamRequestMux<unknown>;
  readonly reverseNs: ReverseRequestNamespace;
  readonly diagnostics: ProtocolDiagnostics;
  /**
   * Phase 1: `"never"`. Phase 2 turn-on flips this to `"passthrough"`.
   * Injected by lifecycle.ts / config so a Phase 2 rollout doesn't
   * need a rebuild of this module.
   */
  readonly approvalMode: ApprovalMode;
}

export class HumanOwnerCoordinator {
  private readonly opts: HumanOwnerCoordinatorOptions;
  private tuiAttached = false;

  constructor(opts: HumanOwnerCoordinatorOptions) {
    this.opts = opts;
  }

  // ─────────── TUI lifecycle ───────────

  /**
   * Called by the transport when a TUI socket connects. Idempotent —
   * repeat calls do not leak state. Enforcement of at-most-one-TUI
   * is the transport layer's job (uds-server rejects the second
   * connection at accept time via the connection cap).
   */
  attachTui(): void {
    this.tuiAttached = true;
  }

  /**
   * Called by the transport when the TUI socket disconnects. Drains
   * BOTH the reverse namespace and the proxied-TUI half of the mux.
   * Internal scheduler Promises are untouched — a TUI disconnect
   * MUST NOT lose long-running Agent work (Δ11).
   *
   * Reconnect does not replay any prior reverse request; drained
   * ids can never be re-approved (see the reverse namespace's
   * drainAll contract).
   */
  detachTui(): void {
    this.tuiAttached = false;
    this.opts.mux.drainProxiedTui();
    this.opts.reverseNs.drainAll();
  }

  isTuiAttached(): boolean {
    return this.tuiAttached;
  }

  // ─────────── Upstream reverse request → decision ───────────

  /**
   * Decide what to do with an upstream Codex reverse request.
   *
   * Phase 1 (`approvalMode === "never"`):
   *   Refuse unconditionally with `NoOwner`, regardless of TUI
   *   presence. This is defense-in-depth: upstream Codex is
   *   configured with approval=never; if a reverse request still
   *   arrives it is either a misconfiguration or a bug.
   *
   * Phase 2 (`approvalMode === "passthrough"`):
   *   If no TUI is attached, refuse upstream with `NoOwner`.
   *   Otherwise allocate a fresh TUI-side id via the reverse
   *   namespace and return the rewritten frame for the transport
   *   to write on the TUI socket. Reverse-id collision returns an
   *   InvalidArg error upstream.
   *
   * This function never touches sockets and never throws. All
   * outcomes are transport-writable data.
   */
  handleUpstreamReverseRequest(codexFrame: JsonRpcRequestFrame): ReverseRequestOutcome {
    if (this.opts.approvalMode === "never") {
      return {
        kind: "reject_upstream",
        upstreamError: this.upstreamErrorFrame(
          codexFrame.id,
          GatewayErrorCode.NoOwner,
          "approval mode is 'never'; no reverse-request forwarding in Phase 1",
          { reason: "approval_mode_never" },
        ),
      };
    }
    // approvalMode === "passthrough"
    if (!this.tuiAttached) {
      return {
        kind: "reject_upstream",
        upstreamError: this.upstreamErrorFrame(
          codexFrame.id,
          GatewayErrorCode.NoOwner,
          "no human owner attached",
          { reason: "tui_not_attached" },
        ),
      };
    }
    const alloc = this.opts.reverseNs.allocateTuiIdForCodexReverseRequest(codexFrame.id);
    if ("collision" in alloc) {
      return {
        kind: "reject_upstream",
        upstreamError: this.upstreamErrorFrame(
          codexFrame.id,
          GatewayErrorCode.InvalidArg,
          "reverse-request id collision",
          { reason: "reverse_id_collision" },
        ),
      };
    }
    const tuiFrame: JsonRpcRequestFrame = {
      jsonrpc: "2.0",
      id: alloc.tuiId,
      method: codexFrame.method,
      ...(codexFrame.params !== undefined ? { params: codexFrame.params } : {}),
    };
    return { kind: "forward_tui", tuiFrame };
  }

  // ─────────── TUI response frame → decision ───────────

  /**
   * Consume a TUI response frame — this is the approval-response
   * path. Delegates to the frozen `handleTuiResponseFrame` in
   * protocol.ts. Unknown / duplicate reverse id fails closed with
   * a stable rejection; approval-spoof cannot re-approve.
   */
  handleTuiResponseFrame(frame: JsonRpcResponseFrame): TuiResponseHandling {
    return handleTuiResponseFrame(frame, this.opts.reverseNs);
  }

  // ─────────── Diagnostics / inspectors ───────────

  pendingReverseCount(): number {
    return this.opts.reverseNs.pendingCount();
  }

  approvalMode(): ApprovalMode {
    return this.opts.approvalMode;
  }

  // ─────────── Helpers ───────────

  private upstreamErrorFrame(
    id: JsonRpcRequestId,
    code: GatewayErrorCode,
    message: string,
    extra: Record<string, unknown>,
  ): JsonRpcResponseFrame {
    const data: GatewayErrorData = { code: GATEWAY_ERROR_DATA_CODE[code], ...extra };
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    };
  }
}
