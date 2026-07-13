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
  type OwnerLeaseId,
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
  /**
   * The currently-active owner lease, or `null` when no owner is
   * attached. Minted upstream (WS server side) on successful
   * capability check + owner-slot reservation. The coordinator stores
   * a reference so `attachTui(leaseId)` / `detachTui(leaseId)` can
   * verify that a detach call belongs to the incumbent.
   *
   * P0.2 fix (副指挥 7034c5ce item #11): a stale socket's async
   * `close` event arriving after a fresh owner attached MUST NOT
   * drain the incumbent's state.
   */
  private activeLease: OwnerLeaseId | null = null;

  /**
   * Side map from `tuiId` (the freshly-allocated reverse-namespace id)
   * to the lease that owned the socket at allocation time. Used by
   * `handleTuiResponseFrameWithLease` to verify the response is
   * arriving from the SAME lease that received the reverse request
   * — a fresh-lease reconnect cannot cross-answer.
   *
   * Frozen `ReverseRequestNamespace` is NOT modified. This side map
   * lives entirely inside the coordinator (副指挥 7034c5ce item #2).
   */
  private readonly tuiIdLeases = new Map<string, OwnerLeaseId>();

  constructor(opts: HumanOwnerCoordinatorOptions) {
    this.opts = opts;
  }

  // ─────────── TUI lifecycle ───────────

  /**
   * Called by the transport when a TUI socket completes admission and
   * the owner slot is reserved. `leaseId` is the newly-minted opaque
   * lease.
   *
   * If a lease is already active, this call is refused via a
   * diagnostics-only log (the caller is expected to have enforced
   * hard-1 via the owner-slot reserve before calling us; a
   * double-attach here is a defense-in-depth signal).
   */
  attachTui(leaseId: OwnerLeaseId): { kind: "ok" } | { kind: "refused"; reason: "already_held" } {
    if (this.activeLease !== null) {
      // Belt-and-braces: coordinator side won't clobber an incumbent
      // lease. Return a TYPED refusal so the caller can react
      // deterministically without probing internal state (副指挥
      // 3ed5c004 P1-4: lifecycle should not read raw lease).
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "attach_tui_when_already_held",
          error: new Error("attachTui called with lease already active"),
        });
      } catch { /* silent */ }
      return { kind: "refused", reason: "already_held" };
    }
    this.activeLease = leaseId;
    this.tuiAttached = true;
    return { kind: "ok" };
  }

  /**
   * Called by the transport when the TUI socket disconnects. `leaseId`
   * is the lease the disconnecting socket held. Only matching leases
   * drain state; a stale socket's late `close` event whose lease no
   * longer matches the incumbent is a NO-OP.
   *
   * On matching detach, drains BOTH the reverse namespace and the
   * proxied-TUI half of the mux, plus the internal `tuiIdLeases` side
   * map. Internal scheduler Promises are untouched — a TUI disconnect
   * MUST NOT lose long-running Agent work (Δ11).
   */
  detachTui(leaseId: OwnerLeaseId): void {
    if (this.activeLease === null || this.activeLease !== leaseId) {
      // Stale detach: no-op. Only diagnostics record it.
      try {
        this.opts.diagnostics.reportInternalError({
          correlationId: this.opts.diagnostics.newCorrelationId(),
          operation: "detach_tui_stale_lease",
          error: new Error("detachTui called with mismatched lease"),
        });
      } catch { /* silent */ }
      return;
    }
    this.activeLease = null;
    this.tuiAttached = false;
    this.opts.mux.drainProxiedTui();
    this.opts.reverseNs.drainAll();
    this.tuiIdLeases.clear();
  }

  isTuiAttached(): boolean {
    return this.tuiAttached;
  }

  /** Test-only + WS-server-only inspection of the current incumbent lease. */
  currentLease(): OwnerLeaseId | null {
    return this.activeLease;
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
    // Stamp the tuiId with the CURRENT lease. On response consume the
    // caller MUST present a matching lease.
    if (this.activeLease !== null) {
      this.tuiIdLeases.set(idKey(alloc.tuiId), this.activeLease);
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
   * P0.2 Commit 1 corrective (副指挥 a1ed1589 item #11): the
   * no-lease `handleTuiResponseFrame` overload has been REMOVED. The
   * only consume path is `handleTuiResponseFrameWithLease` below. A
   * caller that reaches here without a lease is a bug at the wire
   * layer — the WS server tags every inbound frame with the owning
   * socket's lease before delegation.
   */

  /**
   * P0.2 lease-aware consume path (副指挥 7034c5ce item #2 / #11).
   *
   * The WS server passes the lease that owned the socket the frame
   * arrived on. This method:
   *   1. Looks up the stored lease for `frame.id` in the internal
   *      side map.
   *   2. If the presented lease doesn't match the stored one, returns
   *      a `reject` outcome with `reason=lease_mismatch` — the frozen
   *      `ReverseRequestNamespace` is NEVER consumed.
   *   3. On match, consumes via the frozen namespace and clears the
   *      side-map entry.
   *
   * The frozen `handleTuiResponseFrame` from `protocol.ts` is called
   * exactly ONCE per successful lease match. Under mismatch (fresh
   * socket + fresh lease, stale reverse-id from a previous lease's
   * request), the frozen namespace entry stays live for whoever the
   * legitimate lease actually is — but since detach drains the whole
   * namespace, in practice mismatch means the previous lease already
   * closed. Either way, the frozen adapter runs on the SAME inputs it
   * would have with the untouched behavior, so freeze integrity is
   * preserved.
   */
  handleTuiResponseFrameWithLease(
    frame: JsonRpcResponseFrame,
    presentedLease: OwnerLeaseId,
  ): TuiResponseHandling {
    const storedLease = this.tuiIdLeases.get(idKey(frame.id));
    if (storedLease === undefined || storedLease !== presentedLease) {
      return {
        kind: "reject",
        tuiId: frame.id,
        code: GatewayErrorCode.InvalidArg,
        message: "reverse-response cross-lease refused",
        data: {
          code: GATEWAY_ERROR_DATA_CODE[GatewayErrorCode.InvalidArg],
          reason: "lease_mismatch",
        },
      };
    }
    // Legitimate consume path.
    this.tuiIdLeases.delete(idKey(frame.id));
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

/** Stable string key so the side map treats numeric `1` and string
 *  `"1"` as distinct — matches how the frozen namespace does it. */
function idKey(id: JsonRpcRequestId): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}
