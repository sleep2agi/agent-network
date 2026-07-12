// RFC-030 Wave 1A Segment C — lifecycle tests.
//
// Coverage (副指挥 1e52976d Segment C narrowing):
//   - Preflight succeeds → UDS servers bound; preflight throws → NO
//     socket path on disk, state=stopped.
//   - defaultDenyTuiAuthorizer: every method denied with Busy + reason;
//     allowlist is empty.
//   - makeNoThrowInitializeProvider: throw inside source → undefined
//     snapshot + diagnostics report; caller sees fail-closed Unavailable.
//   - makeNoThrowDiagnostics: throw inside sink is swallowed; throw
//     inside newCorrelationId returns stable fallback.
//   - Shutdown drains mux + reverse namespace, cleans sockets.
//   - sendInternal / sendProxiedTui rejected before start / after stop.
//   - Preflight runs BEFORE any socket touches disk (verify with a
//     runner that inspects the filesystem mid-run).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  GatewayLifecycle,
  type GatewayLifecycleOptions,
  type PreflightRunner,
  makeNoThrowInitializeProvider,
  makeNoThrowDiagnostics,
  defaultDenyTuiAuthorizer,
  DEFAULT_DENY_ALLOWLIST,
} from "./lifecycle";
import type { UpstreamTransport } from "./uds-server";
import type {
  ProtocolBackend,
  ProtocolDiagnostics,
  TuiInitializeProvider,
  JsonRpcRequestFrame,
  JsonRpcResponseFrame,
  JsonRpcNotificationFrame,
  InternalErrorEntry,
} from "./protocol";
import { GatewayErrorCode } from "./contract";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

class FakeUpstream implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closeCallCount = 0;
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
  async close(): Promise<void> {
    this.closeCallCount++;
    if (this.closeCallCount === 1) {
      for (const h of [...this.closeHandlers]) {
        try { h(); } catch { /* silent */ }
      }
    }
  }
  emitFrame(raw: unknown): void { for (const h of this.frameHandlers) h(raw); }
  emitClose(): void { for (const h of this.closeHandlers) h(); }
}

const TEST_BACKEND_CAP = "lifecycle-test-backend-cap-32ch-x";
const TEST_TUI_CAP = "lifecycle-test-tui-cap-abcdef-32c";

function pathsFor(): { socketDir: string; backendSocketPath: string; tuiSocketPath: string } {
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfc030-lifecycle-"));
  fs.rmdirSync(socketDir); // let ensureOwnerOnlyDir create it fresh
  return {
    socketDir,
    backendSocketPath: path.join(socketDir, "backend.sock"),
    tuiSocketPath: path.join(socketDir, "tui.sock"),
  };
}

function makeBackend(): ProtocolBackend {
  return {
    async enqueueTask(args) { return { outcome: "accepted", taskId: args.taskId, queuePosition: 0, duplicate: false }; },
    async getTaskState() { return { state: "unknown" }; },
    async cancelQueuedTask() { return { outcome: "refused_not_queued", currentState: "unknown" }; },
  };
}

function collectDiagnostics(): { diagnostics: ProtocolDiagnostics; entries: InternalErrorEntry[] } {
  const entries: InternalErrorEntry[] = [];
  let n = 0;
  return {
    entries,
    diagnostics: {
      newCorrelationId: () => `cid-${++n}`,
      reportInternalError: (e) => { entries.push(e); },
    },
  };
}

async function makeLifecycle(overrides?: Partial<GatewayLifecycleOptions>): Promise<{
  lifecycle: GatewayLifecycle;
  paths: ReturnType<typeof pathsFor>;
  upstream: FakeUpstream;
  entries: InternalErrorEntry[];
  cleanup: () => Promise<void>;
}> {
  const paths = pathsFor();
  const upstream = new FakeUpstream();
  const { diagnostics, entries } = collectDiagnostics();
  const initSnapshotSource: TuiInitializeProvider = {
    currentSnapshot: () => ({ serverInfo: { name: "codex", version: "0.144.0" }, capabilities: {} }),
  };
  const preflight: PreflightRunner = { async run() { /* ok */ } };
  const opts: GatewayLifecycleOptions = {
    backendSocketPath: paths.backendSocketPath,
    
    socketDir: paths.socketDir,
    preflight,
    backend: makeBackend(),
    upstreamTransport: upstream,
    initSnapshotSource,
    diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    ...(overrides ?? {}),
  };
  const lifecycle = new GatewayLifecycle(opts);
  return {
    lifecycle, paths, upstream, entries,
    async cleanup() {
      try { await lifecycle.stop(); } catch {}
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Preflight ordering
// ─────────────────────────────────────────────────────────────────────

describe("preflight ordering (副指挥 Segment C narrowing)", () => {
  test("preflight throws → state=stopped, NO sockets on disk", async () => {
    const paths = pathsFor();
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    const preflight: PreflightRunner = { async run() { throw new Error("baseline mismatch (fake)"); } };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => undefined },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    });
    await expect(lifecycle.start()).rejects.toThrow(/baseline mismatch/);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    expect(fs.existsSync(paths.tuiSocketPath)).toBe(false);
    expect(fs.existsSync(paths.socketDir)).toBe(false);
  });

  test("preflight runs BEFORE any socket touches disk (mid-run inspection)", async () => {
    const paths = pathsFor();
    let sawSocketsDuringPreflight = { backend: false, tui: false, dir: false };
    const preflight: PreflightRunner = {
      async run() {
        sawSocketsDuringPreflight = {
          backend: fs.existsSync(paths.backendSocketPath),
          tui: fs.existsSync(paths.tuiSocketPath),
          dir: fs.existsSync(paths.socketDir),
        };
      },
    };
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({ ok: true }) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    });
    await lifecycle.start();
    try {
      // During preflight, none of the socket paths existed.
      expect(sawSocketsDuringPreflight.backend).toBe(false);
      expect(sawSocketsDuringPreflight.tui).toBe(false);
      expect(sawSocketsDuringPreflight.dir).toBe(false);
      // After start, they do exist.
      expect(fs.existsSync(paths.backendSocketPath)).toBe(true);
      
    } finally {
      await lifecycle.stop();
      fs.rmSync(paths.socketDir, { recursive: true, force: true });
    }
  });

  test("preflight resolves → state transitions created→running", async () => {
    const h = await makeLifecycle();
    try {
      expect(h.lifecycle.currentState()).toBe("created");
      await h.lifecycle.start();
      expect(h.lifecycle.currentState()).toBe("running");
    } finally { await h.cleanup(); }
  });

  test("second start after running throws (no double-start)", async () => {
    const h = await makeLifecycle();
    try {
      await h.lifecycle.start();
      await expect(h.lifecycle.start()).rejects.toThrow(/cannot start/);
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Default-deny fake authorizer
// ─────────────────────────────────────────────────────────────────────

describe("defaultDenyTuiAuthorizer (Phase 1 stand-in)", () => {
  test("allowlist is explicitly empty (副指挥 no default-allow)", () => {
    expect(DEFAULT_DENY_ALLOWLIST.size).toBe(0);
  });

  test("every method denied with Busy + explicit reason", async () => {
    for (const method of ["turn/start", "turn/steer", "turn/interrupt", "thread/resume", "thread/read", "some/random/method"]) {
      const frame: JsonRpcRequestFrame = { jsonrpc: "2.0", id: 1, method };
      const dec = await defaultDenyTuiAuthorizer.authorize(frame);
      if (dec.verdict !== "deny") throw new Error(`method=${method} unexpectedly allowed`);
      expect(dec.code).toBe(GatewayErrorCode.Busy);
      expect(dec.reason).toContain("default-deny");
      expect(dec.extra?.source).toBe("default_deny_fake_authorizer");
      expect(dec.extra?.method).toBe(method);
    }
  });

  test("even bootstrap-looking methods are denied (bootstrap is handled by dispatch, not authorizer)", async () => {
    // If B's real authorizer ever needs to see initialize, this would
    // be the smoke test. Phase 1: still denied here.
    const frame: JsonRpcRequestFrame = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const dec = await defaultDenyTuiAuthorizer.authorize(frame);
    expect(dec.verdict).toBe("deny");
  });
});

// ─────────────────────────────────────────────────────────────────────
// No-throw wrappers
// ─────────────────────────────────────────────────────────────────────

describe("makeNoThrowInitializeProvider", () => {
  test("source throws → undefined + diagnostics report", () => {
    const { diagnostics, entries } = collectDiagnostics();
    const wrapped = makeNoThrowInitializeProvider(
      { currentSnapshot: () => { throw new Error("provider explode"); } },
      diagnostics,
    );
    const snap = wrapped.currentSnapshot();
    expect(snap).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].operation).toBe("tui_initialize_provider");
    expect((entries[0].error as Error).message).toBe("provider explode");
  });

  test("source returns snapshot → passthrough verbatim (no wrapper mutation)", () => {
    const { diagnostics } = collectDiagnostics();
    const snap = Object.freeze({ serverInfo: { name: "codex", version: "0.144.0" } });
    const wrapped = makeNoThrowInitializeProvider(
      { currentSnapshot: () => snap },
      diagnostics,
    );
    expect(wrapped.currentSnapshot()).toBe(snap);
  });

  test("diagnostics sink also throws → still returns undefined (no cascade)", () => {
    const wrapped = makeNoThrowInitializeProvider(
      { currentSnapshot: () => { throw new Error("provider"); } },
      {
        newCorrelationId: () => { throw new Error("cid boom"); },
        reportInternalError: () => { throw new Error("sink boom"); },
      },
    );
    // Must not throw despite BOTH source and sink throwing.
    expect(wrapped.currentSnapshot()).toBeUndefined();
  });
});

describe("makeNoThrowDiagnostics", () => {
  test("newCorrelationId throw → stable fallback string", () => {
    const wrapped = makeNoThrowDiagnostics({
      newCorrelationId: () => { throw new Error("boom"); },
      reportInternalError: () => {},
    });
    expect(wrapped.newCorrelationId()).toBe("cid-fallback");
  });

  test("newCorrelationId returns non-string → coerced to fallback", () => {
    const wrapped = makeNoThrowDiagnostics({
      newCorrelationId: () => 42 as unknown as string,
      reportInternalError: () => {},
    });
    expect(wrapped.newCorrelationId()).toBe("cid-fallback");
  });

  test("reportInternalError throw → swallowed silently", () => {
    const wrapped = makeNoThrowDiagnostics({
      newCorrelationId: () => "cid",
      reportInternalError: () => { throw new Error("sink boom"); },
    });
    // Must NOT throw.
    wrapped.reportInternalError({ correlationId: "cid", operation: "op", error: new Error("x") });
  });

  test("clean source passthrough (no false interference)", () => {
    const entries: InternalErrorEntry[] = [];
    const wrapped = makeNoThrowDiagnostics({
      newCorrelationId: () => "cid-real",
      reportInternalError: (e) => { entries.push(e); },
    });
    expect(wrapped.newCorrelationId()).toBe("cid-real");
    wrapped.reportInternalError({ correlationId: "x", operation: "op", error: new Error("y") });
    expect(entries).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// sendInternal / sendProxiedTui state gating
// ─────────────────────────────────────────────────────────────────────

describe("transport pass-throughs — state gating", () => {
  test("sendInternal rejected before start", async () => {
    const h = await makeLifecycle();
    try {
      await expect(h.lifecycle.sendInternal("thread/status", {})).rejects.toThrow(/state 'created'/);
    } finally { await h.cleanup(); }
  });

  test("sendInternal rejected after stop", async () => {
    const h = await makeLifecycle();
    await h.lifecycle.start();
    await h.lifecycle.stop();
    await expect(h.lifecycle.sendInternal("thread/status", {})).rejects.toThrow(/state 'stopped'/);
    try { fs.rmSync(h.paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("sendInternal works while running", async () => {
    const h = await makeLifecycle();
    try {
      await h.lifecycle.start();
      const p = h.lifecycle.sendInternal<{ ok: boolean }>("thread/status", { threadId: "t_1" });
      // Response arrives from upstream fake.
      await new Promise((r) => setTimeout(r, 10));
      const uid = (h.upstream.written[0] as JsonRpcRequestFrame).id;
      h.upstream.emitFrame({ jsonrpc: "2.0", id: uid, result: { ok: true } });
      const res = await p;
      expect(res.ok).toBe(true);
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Shutdown drain semantics
// ─────────────────────────────────────────────────────────────────────

describe("shutdown drain semantics", () => {
  test("stop drains mux + reverseNs + cleans created paths", async () => {
    const h = await makeLifecycle();
    await h.lifecycle.start();
    // Kick off an internal request; leave it pending.
    void h.lifecycle.sendInternal("thread/status", {}).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(h.lifecycle.pendingUpstreamCount("internal")).toBe(1);
    await h.lifecycle.stop();
    expect(h.lifecycle.currentState()).toBe("stopped");
    expect(h.lifecycle.pendingUpstreamCount()).toBe(0);
    expect(h.lifecycle.pendingReverseCount()).toBe(0);
    // Socket paths gone (server owned their creation).
    expect(fs.existsSync(h.paths.backendSocketPath)).toBe(false);
    expect(fs.existsSync(h.paths.tuiSocketPath)).toBe(false);
    try { fs.rmSync(h.paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("stop before start is a safe no-op", async () => {
    const paths = pathsFor();
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => undefined },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    });
    await lifecycle.stop();
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase A-P0 lifecycle integration coverage (副指挥 9936fe24)
// ─────────────────────────────────────────────────────────────────────

describe("P0#5 upstreamTransport.close is awaited on stop", () => {
  test("stop() invokes upstream.close() exactly once", async () => {
    const h = await makeLifecycle();
    try {
      await h.lifecycle.start();
      expect(h.upstream.closeCallCount).toBe(0);
      await h.lifecycle.stop();
      expect(h.upstream.closeCallCount).toBe(1);
    } finally { await h.cleanup(); }
  });

  test("stop() with pending sendInternal → Promise rejects (via upstream close fired by lifecycle)", async () => {
    const h = await makeLifecycle();
    try {
      await h.lifecycle.start();
      // Attach a rejection handler EAGERLY so bun's unhandled-
      // rejection detection doesn't fire between the reject call
      // (inside stop()) and the later `await p` in the test body.
      let reason = "";
      const p = h.lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.catch((e: Error) => { reason = e.message; });
      await new Promise((r) => setTimeout(r, 10));
      await h.lifecycle.stop();
      // Give the microtask queue a beat for the .catch handler to fire.
      await new Promise((r) => setTimeout(r, 5));
      // Fake upstream.close() fires onClose → server.onUpstreamClose
      // rejects internal pending with "upstream_closed". Belt-and-
      // braces on server.stop uses "gateway_stopping".
      expect(["upstream_closed", "gateway_stopping"]).toContain(reason);
    } finally { await h.cleanup(); }
  });
});

describe("P0#6 stop-during-preflight epoch fence", () => {
  test("stop() while preflight is still awaiting → state=stopped, NO sockets bound, NO revive", async () => {
    const paths = pathsFor();
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    let releasePreflight: () => void = () => {};
    const preflight: PreflightRunner = {
      async run() {
        await new Promise<void>((r) => { releasePreflight = r; });
      },
    };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({ ok: true }) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    });
    // Kick off start; it blocks on preflight.
    const startP = lifecycle.start();
    // Give the async chain a tick to enter preflight.
    await new Promise((r) => setTimeout(r, 20));
    expect(lifecycle.currentState()).toBe("starting");
    // Request stop. This waits for the in-flight start to settle.
    const stopP = lifecycle.stop();
    // Now release preflight — the fence check MUST short-circuit.
    releasePreflight();
    let startErr = "";
    try { await startP; } catch (e) { startErr = (e as Error).message; }
    await stopP;
    expect(lifecycle.currentState()).toBe("stopped");
    expect(startErr).toContain("start aborted by concurrent stop");
    // NO sockets on disk.
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    expect(fs.existsSync(paths.tuiSocketPath)).toBe(false);
    // The dir wasn't created either (ensureOwnerOnlyDir runs after
    // preflight? Actually before, in server.start. Since server
    // wasn't reached, dir wasn't created).
    expect(fs.existsSync(paths.socketDir)).toBe(false);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("subsequent start after aborted start throws (no revival)", async () => {
    const paths = pathsFor();
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    let releasePreflight: () => void = () => {};
    const preflight: PreflightRunner = {
      async run() { await new Promise<void>((r) => { releasePreflight = r; }); },
    };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({ ok: true }) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,

    });
    const p1 = lifecycle.start();
    await new Promise((r) => setTimeout(r, 20));
    const p2 = lifecycle.stop();
    releasePreflight();
    try { await p1; } catch {}
    await p2;
    // Try to restart from stopped — must throw (state guard).
    await expect(lifecycle.start()).rejects.toThrow(/cannot start from state 'stopped'/);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});
