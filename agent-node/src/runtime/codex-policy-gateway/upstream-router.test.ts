// RFC-030 Wave 1A P0.2 Commit 1 corrective round 5 — upstream-router tests.

import { describe, expect, test } from "bun:test";
import { UpstreamRouter, type TuiForwardSeam } from "./upstream-router";
import {
  ReverseRequestNamespace,
  UpstreamRequestMux,
  type InternalErrorEntry,
  type JsonRpcRequestFrame,
  type JsonRpcResponseFrame,
  type JsonRpcNotificationFrame,
  type ProtocolDiagnostics,
} from "./protocol";
import { HumanOwnerCoordinator } from "./human-owner";
import type { InternalOrigin, UpstreamTransport } from "./uds-server";

class FakeUpstream implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  frameHandlerCount(): number { return this.frameHandlers.length; }
  closeHandlerCount(): number { return this.closeHandlers.length; }
  async writeFrame(f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
    this.written.push(f);
  }
  onFrame(h: (raw: unknown) => void): () => void {
    this.frameHandlers.push(h);
    return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
  }
  onClose(h: () => void): () => void {
    this.closeHandlers.push(h);
    return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
  }
  async close(): Promise<void> {}
  abortCalls = 0;
  async abort(): Promise<void> { this.abortCalls++; }
  emitFrame(raw: unknown): void { for (const h of [...this.frameHandlers]) h(raw); }
  emitClose(): void { for (const h of [...this.closeHandlers]) h(); }
}

function makeFixture(overrides?: { approvalMode?: "never" | "passthrough" }) {
  const mux = new UpstreamRequestMux<InternalOrigin>();
  const reverseNs = new ReverseRequestNamespace();
  const diagnosticsEntries: InternalErrorEntry[] = [];
  const diagnostics: ProtocolDiagnostics = {
    newCorrelationId: () => "cid",
    reportInternalError: (e) => { diagnosticsEntries.push(e); },
  };
  const humanOwner = new HumanOwnerCoordinator({
    mux: mux as unknown as UpstreamRequestMux<unknown>,
    reverseNs,
    diagnostics,
    approvalMode: overrides?.approvalMode ?? "never",
  });
  const upstream = new FakeUpstream();
  const reverseAccepted: unknown[] = [];
  const proxiedAccepted: Array<{ tuiId: number | string; frame: JsonRpcResponseFrame }> = [];
  const tuiForward: TuiForwardSeam = {
    acceptReverseRequestForSend(frame) { reverseAccepted.push(frame); return true; },
    acceptProxiedResponseForSend(tuiId, frame) { proxiedAccepted.push({ tuiId, frame }); return true; },
  };
  let closeCallCount = 0;
  const router = new UpstreamRouter({
    mux, humanOwner, upstreamTransport: upstream,
    diagnostics, tuiForward,
    onUpstreamClose: () => { closeCallCount++; },
  });
  return {
    router, mux, reverseNs, humanOwner, upstream, diagnosticsEntries,
    reverseAccepted, proxiedAccepted,
    closeCallCount: () => closeCallCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Sole router — handler counts
// ─────────────────────────────────────────────────────────────────────

describe("UpstreamRouter — sole subscriber (副指挥 1b24ae71 P0-1)", () => {
  test("subscribe() adds exactly one frame + close handler", () => {
    const f = makeFixture();
    expect(f.upstream.frameHandlerCount()).toBe(0);
    expect(f.upstream.closeHandlerCount()).toBe(0);
    f.router.subscribe();
    expect(f.upstream.frameHandlerCount()).toBe(1);
    expect(f.upstream.closeHandlerCount()).toBe(1);
  });

  test("subscribe() twice throws (defensive)", () => {
    const f = makeFixture();
    f.router.subscribe();
    expect(() => f.router.subscribe()).toThrow(/twice/);
  });

  test("unsubscribe() returns handler counts to 0", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.unsubscribe();
    expect(f.upstream.frameHandlerCount()).toBe(0);
    expect(f.upstream.closeHandlerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pre-active buffering
// ─────────────────────────────────────────────────────────────────────

describe("UpstreamRouter — pre-active buffering", () => {
  test("frames received before activate() are buffered, drained on activate()", () => {
    const f = makeFixture();
    f.router.subscribe();
    // Two reverse-request frames arrive during "preflight window".
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_1", method: "approval/request" });
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_2", method: "approval/request" });
    expect(f.router.currentState()).toBe("subscribed");
    expect(f.router.bufferedCount()).toBe(2);
    // Activate — buffer drains, both reverse requests get NoOwner
    // upstream writes back on original ids.
    f.router.activate();
    expect(f.router.currentState()).toBe("active");
    expect(f.upstream.written).toHaveLength(2);
    const w0 = f.upstream.written[0] as JsonRpcResponseFrame;
    const w1 = f.upstream.written[1] as JsonRpcResponseFrame;
    expect(w0.id).toBe("cx_1");
    expect(w1.id).toBe("cx_2");
    if ("error" in w0) expect((w0.error.data as Record<string, unknown>).reason).toBe("approval_mode_never");
  });

  test("close received before activate() puts router in terminal; wasCloseBeforeActive true", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.upstream.emitClose();
    expect(f.router.wasCloseBeforeActive()).toBe(true);
    // Frames arriving AFTER close are ignored.
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_late", method: "approval/request" });
    expect(f.upstream.written).toHaveLength(0);
    expect(f.router.currentState()).toBe("subscribed"); // still subscribed until activate
  });

  test("activate() after close-before-active fires onUpstreamClose once", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.upstream.emitClose();
    f.router.activate();
    expect(f.router.currentState()).toBe("terminal");
    expect(f.closeCallCount()).toBe(1);
  });

  // 副指挥 e85ade40 P0-2 regression: prior to round 5, a frame that
  // arrived AFTER emitClose but BEFORE activate() was still buffered
  // and then dispatched on activate() — producing a NoOwner
  // response for an id that arrived after the transport was gone.
  test("post-close pre-active frames drop; activate() never dispatches them", () => {
    const f = makeFixture();
    f.router.subscribe();
    // (A) pre-close frame — legal to buffer.
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_before_close", method: "approval/request" });
    // Close arrives.
    f.upstream.emitClose();
    // (B) post-close frame — MUST drop.
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_after_close", method: "approval/request" });
    // Nothing dispatched yet (still pre-active).
    expect(f.upstream.written).toHaveLength(0);
    // Activate — pre-close frame drains; post-close frame is gone.
    f.router.activate();
    const forAfter = f.upstream.written.filter(
      (w) => "id" in w && (w as JsonRpcResponseFrame).id === "cx_after_close",
    );
    expect(forAfter).toHaveLength(0);
    // The router did surface a diagnostic for the dropped post-close frame.
    const dropDiag = f.diagnosticsEntries.filter(
      (e) => e.operation === "upstream_frame_dropped_after_pre_active_close",
    );
    expect(dropDiag).toHaveLength(1);
    expect(f.router.currentState()).toBe("terminal");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Active dispatch
// ─────────────────────────────────────────────────────────────────────

describe("UpstreamRouter — active dispatch", () => {
  test("reverse request under Phase 1 → NoOwner+approval_mode_never on original id", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_r", method: "approval/request" });
    expect(f.upstream.written).toHaveLength(1);
    const w = f.upstream.written[0] as JsonRpcResponseFrame;
    expect(w.id).toBe("cx_r");
    if (!("error" in w)) throw new Error("expected error frame");
    expect(w.error.code).toBe(-32052); // NoOwner
    expect((w.error.data as Record<string, unknown>).reason).toBe("approval_mode_never");
  });

  test("internal response → consumes mux, resolves InternalOrigin (no ws diagnostic false-positive)", async () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    let resolvedValue: unknown = null;
    const origin: InternalOrigin = {
      kind: "internal", label: "test",
      resolve: (v) => { resolvedValue = v; },
      reject: () => {},
    };
    const alloc = f.mux.allocateForInternalScheduler(origin);
    f.upstream.emitFrame({ jsonrpc: "2.0", id: alloc.upstreamId, result: { v: "ok" } });
    expect(resolvedValue).toEqual({ v: "ok" });
    // No "upstream_response_on_ws_face" false-positive diagnostic.
    const bad = f.diagnosticsEntries.find((e) => e.operation === "upstream_response_on_ws_face");
    expect(bad).toBeUndefined();
  });

  test("proxied_tui response → acceptedForSend exactly ONCE via TuiForwardSeam (accept != wire delivery)", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    const alloc = f.mux.allocateForProxiedTui(42);
    f.upstream.emitFrame({ jsonrpc: "2.0", id: alloc.upstreamId, result: { ok: true } });
    expect(f.proxiedAccepted).toHaveLength(1);
    expect(f.proxiedAccepted[0].tuiId).toBe(42);
    // Rewritten to TUI id.
    const frame = f.proxiedAccepted[0].frame as { id: number };
    expect(frame.id).toBe(42);
  });

  test("orphan response → single diagnostic, no accept", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    f.upstream.emitFrame({ jsonrpc: "2.0", id: 9999, result: {} });
    expect(f.proxiedAccepted).toHaveLength(0);
    const orphan = f.diagnosticsEntries.find((e) => e.operation === "upstream_response_orphan");
    expect(orphan).toBeDefined();
  });

  test("notification → single explicit diagnostic; not silent", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    f.upstream.emitFrame({ jsonrpc: "2.0", method: "some/event", params: {} });
    const d = f.diagnosticsEntries.find((e) => e.operation === "upstream_notification_dropped_phase1");
    expect(d).toBeDefined();
  });

  test("upstream close during active → onUpstreamClose fires exactly once; further frames dropped", () => {
    const f = makeFixture();
    f.router.subscribe();
    f.router.activate();
    f.upstream.emitClose();
    expect(f.closeCallCount()).toBe(1);
    expect(f.router.currentState()).toBe("terminal");
    // Late frame doesn't dispatch.
    f.upstream.emitFrame({ jsonrpc: "2.0", id: "cx_late", method: "approval/request" });
    expect(f.upstream.written).toHaveLength(0);
    // Second close is a no-op.
    f.upstream.emitClose();
    expect(f.closeCallCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 10 corrective — router entry-site coverage + overflow×close
// ordering via onPreActiveClose callback count (副指挥 fb2ec49a)
// ─────────────────────────────────────────────────────────────────────

describe("UpstreamRouter — round 10 corrective (副指挥 fb2ec49a)", () => {
  test("dispatchReverseRequest writeFrame returns poisoned-.then Promise → safeAdoptConsume swallows; upstream_reject_write_failed exactly 1; NO unhandled", async () => {
    // Router entry-site coverage: `dispatchReverseRequest`
    // routes the transport.writeFrame return through
    // safeAdoptConsume. A caller-provided Promise with an OWN
    // poisoned `.then` getter must NOT surface as unhandled;
    // the diagnostic fires exactly once regardless of failure
    // mode.
    let unhandled = 0;
    const listener = (): void => { unhandled++; };
    process.on("unhandledRejection", listener);
    try {
      let poisonedRejecter: ((reason?: unknown) => void) | null = null;
      const poisonedP = new Promise<void>((_res, rej) => { poisonedRejecter = rej; });
      Object.defineProperty(poisonedP, "then", {
        get() { throw new Error("router_writeFrame_poisoned_then_getter"); },
        configurable: true,
      });
      const f = makeFixture();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f.upstream as unknown as any).writeFrame = (_frame: unknown): Promise<void> => poisonedP;
      f.router.subscribe();
      f.router.activate();
      // Fire a reverse request under approvalMode=never → router
      // calls transport.writeFrame(rejectFrame).
      const requestFrame: JsonRpcRequestFrame = {
        jsonrpc: "2.0", id: "cx_1", method: "approval/request",
      };
      f.upstream.emitFrame(requestFrame);
      // Reject the underlying promise late — safeAdoptConsume
      // route consumes it via captured intrinsic attach.
      setTimeout(() => poisonedRejecter?.(new Error("underlying_write_reject")), 20);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toBe(0);
      // Diagnostic emitted exactly once for the write failure.
      const writeFailDiags = f.diagnosticsEntries.filter(
        (e) => e.operation === "upstream_reject_write_failed",
      );
      expect(writeFailDiags.length).toBe(1);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("firePreActiveTerminal exactly-once: overflow then close → onPreActiveClose callback count = 1", async () => {
    // 副指挥 fb2ec49a Round 10 corrective: overflow→close
    // ordering via CALLBACK COUNT (not private cast). Confirms
    // the unified helper fires exactly once when overflow is
    // observed first and a subsequent close arrives.
    let onPreActiveCloseCalls = 0;
    const f = makeFixture();
    // Rebuild router with our callback.
    const router = new UpstreamRouter({
      mux: f.mux, humanOwner: f.humanOwner,
      upstreamTransport: f.upstream, diagnostics: {
        newCorrelationId: () => "cid", reportInternalError: () => {},
      },
      tuiForward: {
        acceptReverseRequestForSend: () => false,
        acceptProxiedResponseForSend: () => false,
      },
      onUpstreamClose: () => {},
      onPreActiveClose: () => { onPreActiveCloseCalls++; },
    });
    router.subscribe();
    // 257 frames → overflow → helper fires.
    for (let i = 0; i < 257; i++) {
      f.upstream.emitFrame({ jsonrpc: "2.0", method: "notif", params: { i } });
    }
    expect(onPreActiveCloseCalls).toBe(1);
    // Now emit close — helper MUST NOT fire again.
    f.upstream.emitClose();
    expect(onPreActiveCloseCalls).toBe(1);
    router.unsubscribe();
  });

  test("firePreActiveTerminal exactly-once: close, then POST-CLOSE flood → guard drops frames without entering overflow", async () => {
    // 副指挥 7535c7cb corrective: the earlier title
    // "close then overflow" over-claimed. In this ordering,
    // subsequent frames NEVER enter the overflow branch — they
    // hit the pre-active `receivedCloseBeforeActive` guard and
    // are dropped immediately. Rename to "POST-CLOSE flood" and
    // assert `bufferOverflowedFlag() === false` so the honest
    // invariant is locked: after close, a subsequent flood does
    // NOT overflow AND onPreActiveClose does NOT re-fire.
    let onPreActiveCloseCalls = 0;
    const f = makeFixture();
    const router = new UpstreamRouter({
      mux: f.mux, humanOwner: f.humanOwner,
      upstreamTransport: f.upstream, diagnostics: {
        newCorrelationId: () => "cid", reportInternalError: () => {},
      },
      tuiForward: {
        acceptReverseRequestForSend: () => false,
        acceptProxiedResponseForSend: () => false,
      },
      onUpstreamClose: () => {},
      onPreActiveClose: () => { onPreActiveCloseCalls++; },
    });
    router.subscribe();
    // Close first.
    f.upstream.emitClose();
    expect(onPreActiveCloseCalls).toBe(1);
    expect(router.bufferOverflowedFlag()).toBe(false);
    // Post-close flood: guard drops frames. NO overflow, NO
    // second onPreActiveClose call.
    for (let i = 0; i < 300; i++) {
      f.upstream.emitFrame({ jsonrpc: "2.0", method: "notif", params: { i } });
    }
    expect(onPreActiveCloseCalls).toBe(1);
    expect(router.bufferOverflowedFlag()).toBe(false);
    router.unsubscribe();
  });
});
