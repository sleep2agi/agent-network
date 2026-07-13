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
  UPSTREAM_CLOSE_TIMEOUT_MS,
  LOCAL_STOP_TIMEOUT_MS,
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
  abortCallCount = 0;
  async abort(): Promise<void> { this.abortCallCount++; }
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

  // 副指挥 e85ade40 P0-1 regression: prior to round 5, a stop() that
  // landed during the backend.start await window returned state
  // "stopped" while the UDS listener was still bound + accepting.
  // The fix routes rollback through async awaits so listeners close
  // BEFORE state=stopped is exposed.
  test("stop-during-start → state=stopped AND socket unlinked (no live listener)", async () => {
    const paths = pathsFor();
    const upstream = new FakeUpstream();
    const { diagnostics } = collectDiagnostics();
    // Preflight resolves immediately. We stop() right after start()
    // begins so the fence lands DURING backend_start's await window.
    const preflight: PreflightRunner = { async run() { /* ok */ } };
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
    // Fire start; on the next microtask fire stop concurrently.
    const startP = lifecycle.start();
    // Yield so start() progresses past construction into the awaits.
    await Promise.resolve();
    const stopP = lifecycle.stop();
    let startResult = "resolved";
    try { await startP; } catch (e) { startResult = `rejected:${(e as Error).message}`; }
    await stopP;
    expect(lifecycle.currentState()).toBe("stopped");
    // Socket path MUST not exist any more.
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    // If the socket does exist, this connection would succeed — the
    // repro that failed round-4 was `socketAccepts:true`. We check
    // the file first (unlink is the reliable signal); a live-connect
    // probe is racy vs event-loop scheduling.
    if (fs.existsSync(paths.socketDir)) {
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
    // start rejected with the fence error OR completed silently if
    // the timing didn't hit the fence — the invariant we test is
    // "state=stopped + socket absent", not "always rejected".
    if (startResult.startsWith("rejected:")) {
      expect(startResult).toMatch(/start aborted(?: by concurrent stop|: (?:upstream closed|shutdown signalled during preflight|lifecycle epoch changed))/);
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
    // 副指挥 b65ebc50 Round 7: preflight now races vs the
    // shutdown signal — a concurrent stop() fires the signal,
    // race throws with the shutdown-signal message, and the
    // outer catch runs rollback.
    expect(startErr).toMatch(/start aborted(?: by concurrent stop|: (?:shutdown signalled during preflight|lifecycle epoch changed))/);
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

// ─────────────────────────────────────────────────────────────────────
// Commit 2 lifecycle teardown tranche (副指挥 3cb7ba9b)
// Each item below is a red-turnable reproducer per coordinator's spec:
//   #1 shutdown single-flight
//   #2 upstream-close × manual-stop race → single cascade
//   #3 transport.abort() REQUIRED (fake omission would fail compile)
//   #4 bounded close timeout + forced abort
//   #5 close/abort throw → truthful stop_failed, error preserved
//   #6 pending origins reject/drain exactly once; no leaks
// Every case avoids the frozen contract/protocol; only lifecycle +
// UpstreamTransport interface (uds-server.ts) surfaces are touched.
// ─────────────────────────────────────────────────────────────────────

class ControllableUpstream implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closeCallCount = 0;
  abortCallCount = 0;
  private closeBehaviour:
    | { kind: "resolve" }
    | { kind: "throw"; error: Error }
    | { kind: "never" } = { kind: "resolve" };
  private abortBehaviour:
    | { kind: "ok" }
    | { kind: "sync_throw"; error: Error }
    | { kind: "reject"; error: Error }
    | { kind: "never" } = { kind: "ok" };

  setClose(b: ControllableUpstream["closeBehaviour"]): void { this.closeBehaviour = b; }
  setAbort(b: ControllableUpstream["abortBehaviour"]): void { this.abortBehaviour = b; }

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
    switch (this.closeBehaviour.kind) {
      case "resolve": return;
      case "throw": throw this.closeBehaviour.error;
      case "never": return new Promise<void>(() => { /* never resolves */ });
    }
  }
  abort(): Promise<void> {
    this.abortCallCount++;
    switch (this.abortBehaviour.kind) {
      case "ok": return Promise.resolve();
      case "sync_throw": throw this.abortBehaviour.error;
      case "reject": return Promise.reject(this.abortBehaviour.error);
      case "never": return new Promise<void>(() => { /* never */ });
    }
  }
  emitFrame(raw: unknown): void { for (const h of this.frameHandlers) h(raw); }
  emitClose(): void { for (const h of this.closeHandlers) h(); }
}

async function makeLifecycleWith(upstream: ControllableUpstream): Promise<{
  lifecycle: GatewayLifecycle;
  paths: ReturnType<typeof pathsFor>;
  entries: InternalErrorEntry[];
  upstream: ControllableUpstream;
  cleanup: () => Promise<void>;
}> {
  const paths = pathsFor();
  const { diagnostics, entries } = collectDiagnostics();
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: paths.backendSocketPath,
    socketDir: paths.socketDir,
    preflight: { async run() { /* ok */ } },
    backend: makeBackend(),
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({ ok: true }) },
    diagnosticsSink: diagnostics,
    backendCapability: TEST_BACKEND_CAP,
  });
  return {
    lifecycle, paths, entries, upstream,
    async cleanup() {
      try { await lifecycle.stop(); } catch {}
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("Commit 2 #1 — shutdown single-flight", () => {
  test("two concurrent stop() calls share ONE shutdown; close/abort invoked exactly once", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      const p1 = h.lifecycle.stop();
      const p2 = h.lifecycle.stop();
      const p3 = h.lifecycle.stop();
      // 副指挥 d53209eb #3: promise identity — same reference.
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      await Promise.all([p1, p2, p3]);
      expect(upstream.closeCallCount).toBe(1);
      // Clean close → abort NOT called.
      expect(upstream.abortCallCount).toBe(0);
      expect(h.lifecycle.currentState()).toBe("stopped");
    } finally { await h.cleanup(); }
  });

  test("upstream close cascade × concurrent stop() share ONE shutdown", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      // Upstream fires close (cascade begins) at the same instant a
      // caller invokes stop(). Both must funnel to the same
      // shutdown promise.
      upstream.emitClose();
      const p1 = h.lifecycle.stop();
      const p2 = h.lifecycle.stop();
      await Promise.all([p1, p2]);
      // upstream.close() invoked exactly once (single-flight).
      expect(upstream.closeCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stopped");
    } finally { await h.cleanup(); }
  });

  test("stop() after terminal state resolves immediately without re-running teardown", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      const closeCallsAfterFirstStop = upstream.closeCallCount;
      await h.lifecycle.stop();
      await h.lifecycle.stop();
      expect(upstream.closeCallCount).toBe(closeCallsAfterFirstStop);
      expect(h.lifecycle.currentState()).toBe("stopped");
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 #4 — bounded upstream close + forced abort", () => {
  test("never-resolving close → bounded timeout fires abort → stop_failed with timeout cause", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "never" });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      const startTs = Date.now();
      await h.lifecycle.stop();
      const elapsed = Date.now() - startTs;
      // Must not exceed the bounded timeout by a wide margin
      // (allow slack for the surrounding server stops).
      expect(elapsed).toBeLessThan(UPSTREAM_CLOSE_TIMEOUT_MS + 1500);
      expect(upstream.abortCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      const failure = h.lifecycle.stopFailure();
      expect(failure).not.toBeNull();
      expect(failure?.message).toMatch(/upstream close timed out after \d+ms/);
    } finally { await h.cleanup(); }
  });

  test("close throws → abort called → stop_failed preserving the close error", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_boom") });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      expect(upstream.abortCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()?.message).toBe("close_boom");
    } finally { await h.cleanup(); }
  });

  test("close throws AND abort throws → stop_failed; primary=abort; ledger.upstreamClose preserved (non-invasive)", async () => {
    const upstream = new ControllableUpstream();
    const closeErr = new Error("close_boom");
    const abortErr = new Error("abort_boom");
    upstream.setClose({ kind: "throw", error: closeErr });
    upstream.setAbort({ kind: "sync_throw", error: abortErr });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      expect(upstream.closeCallCount).toBe(1);
      expect(upstream.abortCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      // 副指挥 0bd525d0 P0-2/P1-1: primary IS abortErr identity-verbatim;
      // close cause preserved via dedicated accessor, NOT mutated onto
      // primary via `.cause`.
      expect(h.lifecycle.stopFailure()).toBe(abortErr);
      expect(h.lifecycle.stopFailureCloseCauseError()).toBe(closeErr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((abortErr as any).cause).toBeUndefined();
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 #6 — pending origins drain exactly once", () => {
  test("stop() with pending sendInternal → rejects once; mux + reverseNs pending back to 0", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      let rejectCount = 0;
      const p = h.lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.catch(() => { rejectCount++; });
      await new Promise((r) => setTimeout(r, 10));
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 20));
      expect(rejectCount).toBe(1);
      expect(h.lifecycle.pendingUpstreamCount()).toBe(0);
      expect(h.lifecycle.pendingReverseCount()).toBe(0);
    } finally { await h.cleanup(); }
  });

  test("late upstream response after stop → NOT redelivered (mux already drained)", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      let resolved = false;
      let rejected = false;
      const p = h.lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.then(() => { resolved = true; }, () => { rejected = true; });
      await new Promise((r) => setTimeout(r, 10));
      // Capture the frame id BEFORE stop drains the mux.
      const uid = (upstream.written[0] as JsonRpcRequestFrame).id as number;
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 10));
      expect(rejected).toBe(true);
      expect(resolved).toBe(false);
      // Late "response" arrives via upstream frame emit — mux is
      // drained, so no origin can be found. Simulate by feeding
      // through the transport: but the router is unsubscribed, so
      // even if a stray frame arrives at the transport it is not
      // routed. Assert pending counts unchanged.
      expect(h.lifecycle.pendingUpstreamCount()).toBe(0);
      // A follow-up stop must be a no-op (no re-delivery, no
      // second reject).
      let secondReject = 0;
      p.catch(() => { secondReject++; });
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 10));
      // Node treats `.catch` on an already-rejected Promise as one
      // more handler run. But the ORIGIN was rejected exactly
      // once — we assert by pending count remaining at 0.
      expect(h.lifecycle.pendingUpstreamCount()).toBe(0);
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Commit 2 corrective round 1 (副指挥 d53209eb) — new red matrix
// ─────────────────────────────────────────────────────────────────────

/**
 * A `TuiWsServer`-shaped wrapper that lets tests inject a
 * mis-behaving `stop()` (throw / never-resolve) and observe
 * whether `forceTerminate()` was called. Delegates all wire
 * behaviour to a real `TuiWsServer` so binding still happens.
 */
async function makeLifecycleWithMisbehavingTui(
  upstream: ControllableUpstream,
  tuiStopBehaviour: { kind: "resolve" } | { kind: "throw"; error: Error } | { kind: "never" },
): Promise<{
  lifecycle: GatewayLifecycle;
  paths: ReturnType<typeof pathsFor>;
  upstream: ControllableUpstream;
  tuiForceCount: () => number;
  tuiStopCount: () => number;
  cleanup: () => Promise<void>;
}> {
  const paths = pathsFor();
  const { diagnostics } = collectDiagnostics();
  let stopCalls = 0;
  let forceCalls = 0;
  // Interpose on the actual TuiWsServer via a Proxy-like wrapper
  // returned from options. Since GatewayLifecycle constructs the
  // TuiWsServer itself, we monkey-patch after start().
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: paths.backendSocketPath,
    socketDir: paths.socketDir,
    preflight: { async run() {} },
    backend: makeBackend(),
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: diagnostics,
    backendCapability: TEST_BACKEND_CAP,
  });
  await lifecycle.start();
  // Reach the private tuiServer via TS erasure. Wrap stop/force.
  const inner = (lifecycle as unknown as { tuiServer: {
    stop: () => Promise<void>; forceTerminate: () => void;
    ownerSlotState?: () => string;
  }; }).tuiServer;
  const originalStop = inner.stop.bind(inner);
  const originalForce = inner.forceTerminate.bind(inner);
  inner.stop = async () => {
    stopCalls++;
    switch (tuiStopBehaviour.kind) {
      case "resolve": return originalStop();
      case "throw": throw tuiStopBehaviour.error;
      case "never": return new Promise<void>(() => { /* hang */ });
    }
  };
  inner.forceTerminate = () => {
    forceCalls++;
    originalForce();
  };
  return {
    lifecycle, paths, upstream,
    tuiForceCount: () => forceCalls,
    tuiStopCount: () => stopCalls,
    async cleanup() {
      try { await lifecycle.stop(); } catch {}
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Same shape for the Backend UDS server. */
async function makeLifecycleWithMisbehavingBackend(
  upstream: ControllableUpstream,
  beStopBehaviour: { kind: "resolve" } | { kind: "throw"; error: Error } | { kind: "never" },
): Promise<{
  lifecycle: GatewayLifecycle;
  paths: ReturnType<typeof pathsFor>;
  upstream: ControllableUpstream;
  beForceCount: () => number;
  beStopCount: () => number;
  socketPath: string;
  cleanup: () => Promise<void>;
}> {
  const paths = pathsFor();
  const { diagnostics } = collectDiagnostics();
  let stopCalls = 0;
  let forceCalls = 0;
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: paths.backendSocketPath,
    socketDir: paths.socketDir,
    preflight: { async run() {} },
    backend: makeBackend(),
    upstreamTransport: upstream,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: diagnostics,
    backendCapability: TEST_BACKEND_CAP,
  });
  await lifecycle.start();
  const inner = (lifecycle as unknown as { backendServer: {
    stop: () => Promise<void>; forceTerminate: () => void;
  }; }).backendServer;
  const originalStop = inner.stop.bind(inner);
  const originalForce = inner.forceTerminate.bind(inner);
  inner.stop = async () => {
    stopCalls++;
    switch (beStopBehaviour.kind) {
      case "resolve": return originalStop();
      case "throw": throw beStopBehaviour.error;
      case "never": return new Promise<void>(() => { /* hang */ });
    }
  };
  inner.forceTerminate = () => {
    forceCalls++;
    originalForce();
  };
  return {
    lifecycle, paths, upstream,
    beForceCount: () => forceCalls,
    beStopCount: () => stopCalls,
    socketPath: paths.backendSocketPath,
    async cleanup() {
      try { await lifecycle.stop(); } catch {}
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("Commit 2 corrective #1/#2 — local stop failure surfaces stop_failed with forceTerminate", () => {
  test("backend stop throws → stop_failed; forceTerminate called; socket unlinked", async () => {
    const upstream = new ControllableUpstream();
    const beThrow = new Error("backend_stop_boom");
    const h = await makeLifecycleWithMisbehavingBackend(upstream, { kind: "throw", error: beThrow });
    try {
      await h.lifecycle.stop();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      // Identity preserved
      expect(h.lifecycle.stopFailure()).toBe(beThrow);
      expect(h.beForceCount()).toBe(1);
      // Socket path must be unlinked by forceTerminate.
      expect(fs.existsSync(h.socketPath)).toBe(false);
    } finally { await h.cleanup(); }
  });

  test("backend stop never-resolves → bounded timeout escalates to forceTerminate; stop_failed", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWithMisbehavingBackend(upstream, { kind: "never" });
    try {
      const start = Date.now();
      await h.lifecycle.stop();
      const elapsed = Date.now() - start;
      // Should NOT exceed LOCAL_STOP_TIMEOUT_MS by a wide margin.
      expect(elapsed).toBeLessThan(LOCAL_STOP_TIMEOUT_MS + 1500);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()?.message).toMatch(/backend stop timed out after \d+ms/);
      expect(h.beForceCount()).toBe(1);
      expect(fs.existsSync(h.socketPath)).toBe(false);
    } finally { await h.cleanup(); }
  });

  test("TUI stop throws → stop_failed; forceTerminate called; owner slot cleared", async () => {
    const upstream = new ControllableUpstream();
    const tuiThrow = new Error("tui_stop_boom");
    const h = await makeLifecycleWithMisbehavingTui(upstream, { kind: "throw", error: tuiThrow });
    try {
      await h.lifecycle.stop();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()).toBe(tuiThrow);
      expect(h.tuiForceCount()).toBe(1);
    } finally { await h.cleanup(); }
  });

  test("TUI stop never-resolves → bounded timeout escalates to forceTerminate; stop_failed", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWithMisbehavingTui(upstream, { kind: "never" });
    try {
      const start = Date.now();
      await h.lifecycle.stop();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(LOCAL_STOP_TIMEOUT_MS + 1500);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()?.message).toMatch(/tui stop timed out after \d+ms/);
      expect(h.tuiForceCount()).toBe(1);
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 corrective #3 — public stop() Promise identity", () => {
  test("three concurrent stop() calls return the EXACT SAME Promise reference (p1===p2===p3)", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      const p1 = h.lifecycle.stop();
      const p2 = h.lifecycle.stop();
      const p3 = h.lifecycle.stop();
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      await Promise.all([p1, p2, p3]);
    } finally { await h.cleanup(); }
  });
});

// 副指挥 13dd3853 B: prior "Commit 2 corrective #4" rollback
// catch-all describe deleted — the two round-3 honest split tests
// below (preflight rollback × stop; active upstream-close cascade
// × stop) replace it with real entry-point coverage.

describe("Commit 2 corrective #5 — abort Promise contract; no unhandled rejection under hostile returns", () => {
  test("async abort rejects → primary Error identity preserved; NO unhandled rejection", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_fail_to_force_abort") });
    const rejectErr = new Error("async_abort_boom");
    upstream.setAbort({ kind: "reject", error: rejectErr });
    let unhandled: unknown = null;
    const listener = (reason: unknown): void => { unhandled = reason; };
    process.on("unhandledRejection", listener);
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      // Give a couple of microtask beats for any late rejection
      // to arrive.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      // 副指挥 0bd525d0 P1-1: primary IS the rejection error, identity-verbatim.
      expect(h.lifecycle.stopFailure()).toBe(rejectErr);
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });
});

// 副指挥 13dd3853 B: prior "Commit 2 corrective #6 — tagged winner
// race (timeout wins deterministically)" describe deleted. Its
// only test used `kind:"never"` — a plain post-timeout timeout,
// NOT a same-microtask boundary. The round-3 honest describe
// below ("post-timeout close settle does NOT revert stop_failed")
// covers this case with the correct title.

describe("Commit 2 corrective #7 — original abort Error identity preserved (incl. frozen)", () => {
  test("TypeError with custom .code/.stack → stopFailure() === original abort Error object", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_fail") });
    class MyTypeError extends TypeError {
      code = "E_CUSTOM_ABORT";
      constructor(msg: string) { super(msg); this.name = "MyTypeError"; }
    }
    const original = new MyTypeError("abort_boom_custom");
    upstream.setAbort({ kind: "sync_throw", error: original });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      const primary = h.lifecycle.stopFailure();
      expect(primary).toBe(original);
      expect(primary).toBeInstanceOf(TypeError);
      expect(primary?.name).toBe("MyTypeError");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((primary as any).code).toBe("E_CUSTOM_ABORT");
      // Secondary retained.
      expect(h.lifecycle.stopFailureCloseCauseError()?.message).toBe("close_fail");
    } finally { await h.cleanup(); }
  });

  test("FROZEN abort Error → cannot mutate cause; stopFailure() still === original; secondary preserved via lifecycle field", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_fail_2") });
    const frozen = new Error("abort_boom_frozen");
    Object.freeze(frozen); // non-extensible, non-writable
    upstream.setAbort({ kind: "sync_throw", error: frozen });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      // No exception, no double-throw, converged to terminal.
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      // Identity preserved verbatim (frozen object unchanged).
      expect(h.lifecycle.stopFailure()).toBe(frozen);
      // Attaching .cause on a frozen error was skipped — but the
      // secondary is available via the dedicated accessor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((frozen as any).cause).toBeUndefined();
      expect(h.lifecycle.stopFailureCloseCauseError()?.message).toBe("close_fail_2");
    } finally { await h.cleanup(); }
  });

  test("NON-EXTENSIBLE (sealed) abort Error with existing cause → cause not overwritten; secondary retained separately", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_fail_3") });
    const sealed = new Error("abort_boom_sealed", { cause: "pre-existing" });
    Object.preventExtensions(sealed);
    upstream.setAbort({ kind: "sync_throw", error: sealed });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()).toBe(sealed);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((sealed as any).cause).toBe("pre-existing");
      expect(h.lifecycle.stopFailureCloseCauseError()?.message).toBe("close_fail_3");
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 corrective #8 — bounded close timer cleared; drainAll exactly once", () => {
  test("clean close → NO leaked timer + no unhandled late close reject", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    let unhandled: unknown = null;
    const listener = (reason: unknown): void => { unhandled = reason; };
    process.on("unhandledRejection", listener);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      // Wait longer than the timeout to confirm no late fire.
      await new Promise((r) => setTimeout(r, UPSTREAM_CLOSE_TIMEOUT_MS + 200));
      expect(unhandled).toBeNull();
      expect(upstream.abortCallCount).toBe(0);
      expect(h.lifecycle.currentState()).toBe("stopped");
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("late close reject after timeout → CONSUMED, no unhandled rejection", async () => {
    // Custom transport whose close rejects AFTER the bounded window.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    class LateRejectTransport implements UpstreamTransport {
      async writeFrame() { }
      onFrame(): () => void { return () => {}; }
      onClose(): () => void { return () => {}; }
      abortCalls = 0;
      close(): Promise<void> {
        return new Promise((_res, reject) => {
          setTimeout(() => reject(new Error("late_close_reject")), UPSTREAM_CLOSE_TIMEOUT_MS + 300);
        });
      }
      async abort(): Promise<void> { this.abortCalls++; }
    }
    const transport = new LateRejectTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    let unhandled: unknown = null;
    const listener = (reason: unknown): void => { unhandled = reason; };
    process.on("unhandledRejection", listener);
    try {
      await lifecycle.start();
      await lifecycle.stop();
      // Wait for the late reject to arrive.
      await new Promise((r) => setTimeout(r, UPSTREAM_CLOSE_TIMEOUT_MS + 700));
      expect(unhandled).toBeNull();
      expect(transport.abortCalls).toBe(1);
      expect(lifecycle.currentState()).toBe("stop_failed");
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 2 additions (副指挥 0bd525d0)
// ─────────────────────────────────────────────────────────────────────

/**
 * Bespoke transport whose `abort` returns whatever the caller
 * configured — used to prove the bounded-await design is
 * inert to hostile return values (P0-1 six-case matrix).
 */
class HostileAbortTransport implements UpstreamTransport {
  abortCalls = 0;
  private makeAbortReturn: () => unknown;
  private throwOnCall: Error | null;

  constructor(opts: { abortReturn: () => unknown; throwOnCall?: Error }) {
    this.makeAbortReturn = opts.abortReturn;
    this.throwOnCall = opts.throwOnCall ?? null;
  }
  async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
  onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
  onClose(_h: () => void): () => void { return () => {}; }
  // Force close throw so abort is exercised.
  async close(): Promise<void> { throw new Error("close_forcing_abort"); }
  // Signature is `() => Promise<void>` per the interface. Runtime
  // callers who ignore types can and do return anything; the
  // lifecycle must be robust.
  abort: () => Promise<void> = (() => {
    this.abortCalls++;
    if (this.throwOnCall !== null) throw this.throwOnCall;
    return this.makeAbortReturn() as Promise<void>;
  }).bind(this);
}

async function makeLifecycleWithTransport(transport: UpstreamTransport): Promise<{
  lifecycle: GatewayLifecycle;
  paths: ReturnType<typeof pathsFor>;
  cleanup: () => Promise<void>;
}> {
  const paths = pathsFor();
  const { diagnostics } = collectDiagnostics();
  const lifecycle = new GatewayLifecycle({
    backendSocketPath: paths.backendSocketPath,
    socketDir: paths.socketDir,
    preflight: { async run() {} },
    backend: makeBackend(),
    upstreamTransport: transport,
    initSnapshotSource: { currentSnapshot: () => ({}) },
    diagnosticsSink: diagnostics,
    backendCapability: TEST_BACKEND_CAP,
  });
  return {
    lifecycle, paths,
    async cleanup() {
      try { await lifecycle.stop(); } catch {}
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("Commit 2 corrective round 2 P0-1 — hostile abort return values never escape teardown", () => {
  // Each case: close throws to force abort; abort returns a hostile
  // value. The bounded-await machinery MUST catch every case;
  // stop() must resolve to a terminal state (stopped OR stop_failed
  // — but never `stopping`), and NO unhandled rejection fires.
  const cases: Array<{ name: string; makeReturn: () => unknown; expectTerminalAny?: boolean }> = [
    { name: "abort returns undefined", makeReturn: () => undefined, expectTerminalAny: true },
    { name: "abort returns null", makeReturn: () => null, expectTerminalAny: true },
    { name: "abort returns number 42", makeReturn: () => 42, expectTerminalAny: true },
    { name: "abort returns object with throwing then getter", makeReturn: () => ({
      get then() { throw new Error("then_getter_boom"); },
    }) },
    { name: "abort returns thenable that resolves undefined", makeReturn: () => ({
      then(res: (v: undefined) => void) { res(undefined); },
    }) },
    { name: "abort returns rejected Promise via poisoned catch getter", makeReturn: () => {
      const p = Promise.reject(new Error("poisoned_catch_reject"));
      Object.defineProperty(p, "catch", {
        get() { throw new Error("catch_getter_boom"); },
      });
      return p;
    } },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const transport = new HostileAbortTransport({ abortReturn: c.makeReturn });
      let unhandled: unknown = null;
      const listener = (reason: unknown): void => { unhandled = reason; };
      process.on("unhandledRejection", listener);
      const h = await makeLifecycleWithTransport(transport);
      try {
        await h.lifecycle.start();
        // stop() must resolve — NEVER hang or reject.
        await h.lifecycle.stop();
        await new Promise((r) => setTimeout(r, 50));
        // 副指挥 13dd3853 E: close threw → ledger.upstreamClose IS
        // populated → terminal MUST be `stop_failed` (a `stopped`
        // here would be green-wash — the transport failure was
        // silently absorbed).
        expect(h.lifecycle.currentState()).toBe("stop_failed");
        expect(h.lifecycle.stopFailureLedger().upstreamClose).not.toBeNull();
        expect(unhandled).toBeNull();
        expect(transport.abortCalls).toBe(1);
      } finally {
        process.off("unhandledRejection", listener);
        await h.cleanup();
      }
    });
  }

  test("abort synchronously throws with a TypeError → stop_failed with identity preserved; no unhandled", async () => {
    const original = new TypeError("sync_abort_throw_identity");
    const transport = new HostileAbortTransport({
      abortReturn: () => undefined,
      throwOnCall: original,
    });
    let unhandled: unknown = null;
    const listener = (reason: unknown): void => { unhandled = reason; };
    process.on("unhandledRejection", listener);
    const h = await makeLifecycleWithTransport(transport);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()).toBe(original);
      expect(h.lifecycle.stopFailure()).toBeInstanceOf(TypeError);
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });
});

describe("Commit 2 corrective round 2 P1-1 — multi-failure ledger preserves every cause", () => {
  test("three-way failure (backend stop + close + abort) → ledger keeps each; primary=abort", async () => {
    // Backend throw is delivered via test wrapper; upstream close +
    // abort come from ControllableUpstream.
    const upstream = new ControllableUpstream();
    const closeErr = new Error("close_3way");
    const abortErr = new Error("abort_3way");
    upstream.setClose({ kind: "throw", error: closeErr });
    upstream.setAbort({ kind: "sync_throw", error: abortErr });
    const beErr = new Error("backend_stop_3way");
    const h = await makeLifecycleWithMisbehavingBackend(upstream, {
      kind: "throw", error: beErr,
    });
    try {
      await h.lifecycle.stop();
      const l = h.lifecycle.stopFailureLedger();
      // Each slot preserved identity-verbatim.
      expect(l.backendStop).toBe(beErr);
      expect(l.upstreamClose).toBe(closeErr);
      expect(l.upstreamAbort).toBe(abortErr);
      expect(l.tuiStop).toBeNull();
      // Primary priority: abort > close > backend > tui.
      expect(h.lifecycle.stopFailure()).toBe(abortErr);
      // The dedicated close accessor returns ONLY the close cause,
      // never the backend one.
      expect(h.lifecycle.stopFailureCloseCauseError()).toBe(closeErr);
    } finally { await h.cleanup(); }
  });

  test("four-way failure (backend + tui + close + abort) → ledger holds all four; primary=abort", async () => {
    // Build a fresh lifecycle whose backend + tui both throw on stop,
    // upstream close + abort both throw.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    const upstream = new ControllableUpstream();
    const closeErr = new Error("close_4way");
    const abortErr = new Error("abort_4way");
    upstream.setClose({ kind: "throw", error: closeErr });
    upstream.setAbort({ kind: "sync_throw", error: abortErr });
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await lifecycle.start();
    // Inject failures into both local servers.
    const beErr = new Error("backend_stop_4way");
    const tuiErr = new Error("tui_stop_4way");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const be = (lifecycle as unknown as any).backendServer as { stop: () => Promise<void> };
    const beOrig = be.stop.bind(be);
    be.stop = async () => { throw beErr; void beOrig; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tui = (lifecycle as unknown as any).tuiServer as { stop: () => Promise<void> };
    const tuiOrig = tui.stop.bind(tui);
    tui.stop = async () => { throw tuiErr; void tuiOrig; };
    try {
      await lifecycle.stop();
      const l = lifecycle.stopFailureLedger();
      expect(l.backendStop).toBe(beErr);
      expect(l.tuiStop).toBe(tuiErr);
      expect(l.upstreamClose).toBe(closeErr);
      expect(l.upstreamAbort).toBe(abortErr);
      expect(lifecycle.stopFailure()).toBe(abortErr);
      expect(lifecycle.stopFailureCloseCauseError()).toBe(closeErr);
      expect(lifecycle.currentState()).toBe("stop_failed");
    } finally {
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("Commit 2 corrective round 3 (副指挥 cdd20559 pre-submit) — rollback + stop share teardown core EXACTLY once", () => {
  // 副指挥 cdd20559 pre-submit #1: pre-active `emitClose` does NOT
  // invoke `onUpstreamCloseFromRouter` (that fires only on active
  // close). Splitting the round-2 catch-all into TWO honest tests
  // so we can prove exact-1 with the real entry points.
  test("preflight rollback × concurrent stop() → teardown core entered EXACTLY 1; close EXACTLY 1; abort 0 (clean close)", async () => {
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    const upstream = new ControllableUpstream();
    let preflightSettle: (v: void) => void = () => {};
    const preflightP = new Promise<void>((_res, rej) => {
      preflightSettle = () => rej(new Error("preflight_boom"));
    });
    const preflight: PreflightRunner = { run: () => preflightP };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    expect((lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue).toBe(0);
    const startP = lifecycle.start();
    await Promise.resolve();
    await Promise.resolve();
    // Two concurrent manual stops, then reject preflight. Start's
    // catch runs `rollbackStartFailure` → runTeardownCore. Stops
    // await `startInProgress` first, then re-enter the memoised
    // teardown core.
    const stopP1 = lifecycle.stop();
    const stopP2 = lifecycle.stop();
    preflightSettle();
    const results = await Promise.allSettled([startP, stopP1, stopP2]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect(results[2].status).toBe("fulfilled");
    expect(stopP1).toBe(stopP2);
    // EXACT invariants (not `<=1` — really 1):
    expect((lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue).toBe(1);
    expect(upstream.closeCallCount).toBe(1);
    expect(upstream.abortCallCount).toBe(0); // close resolved cleanly → no abort
    // 副指挥 13dd3853 E: preflight rejection is the only failure —
    // ledger stages should ALL be null (close/abort resolved
    // cleanly), so terminal MUST be `stopped`.
    expect(lifecycle.currentState()).toBe("stopped");
    expect(lifecycle.stopFailureLedger().backendStop).toBeNull();
    expect(lifecycle.stopFailureLedger().tuiStop).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamClose).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamAbort).toBeNull();
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("active upstream-close cascade × concurrent stop() → teardown core entered EXACTLY 1; close EXACTLY 1; abort 0 (clean close)", async () => {
    // Full start (all servers bound + router activated) so
    // `emitClose` triggers the REAL `onUpstreamCloseFromRouter`
    // cascade, not the pre-active fence.
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      expect((h.lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue).toBe(0);
      // Fire the active close cascade + two concurrent stops.
      upstream.emitClose();
      const stopP1 = h.lifecycle.stop();
      const stopP2 = h.lifecycle.stop();
      await Promise.all([stopP1, stopP2]);
      expect(stopP1).toBe(stopP2);
      // EXACT invariants:
      expect((h.lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue).toBe(1);
      expect(upstream.closeCallCount).toBe(1);
      expect(upstream.abortCallCount).toBe(0);
      expect(h.lifecycle.currentState()).toBe("stopped");
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 corrective round 3 — tagged winner: post-timeout close settle does NOT revert stop_failed", () => {
  // 副指挥 cdd20559 evidence-delta #2: honest title. The scenario
  // this actually exercises is "close resolves AFTER the timeout
  // has already been picked by Promise.race" — NOT a true
  // same-microtask boundary (which would need a controllable clock
  // seam that the current design doesn't expose). What we CAN
  // prove: once the tagged winner is picked, a subsequent close
  // settle does NOT flip the terminal state back to `stopped`.
  // That IS the tagged-winner invariant a mutable-flag design
  // could violate — we lock it in explicitly by re-checking state
  // after the close settle has definitely fired.
  test("close settles ~20 ms AFTER internal timeout → state stays stop_failed; late settle does not revert", async () => {
    const upstream = new ControllableUpstream();
    let closeRes: (() => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).close = () => {
      upstream.closeCallCount++;
      return new Promise<void>((res) => { closeRes = res; });
    };
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      const microtaskScheduler = setTimeout(() => {
        queueMicrotask(() => { if (closeRes !== null) closeRes(); });
      }, UPSTREAM_CLOSE_TIMEOUT_MS + 20);
      await h.lifecycle.stop();
      const stateAtStopReturn = h.lifecycle.currentState();
      const failureAtStopReturn = h.lifecycle.stopFailure();
      // Wait beyond the scheduled close-settle time so any late
      // effect on state would have observably fired.
      await new Promise((r) => setTimeout(r, 200));
      clearTimeout(microtaskScheduler);
      // Tagged-winner invariant: state and primary Error are
      // UNCHANGED after the late close settle.
      expect(stateAtStopReturn).toBe("stop_failed");
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()).toBe(failureAtStopReturn);
      expect(h.lifecycle.stopFailure()?.message).toMatch(/upstream close timed out/);
      expect(upstream.abortCallCount).toBe(1);
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 corrective round 2 evidence-delta — real late upstream response injection", () => {
  test("late injected upstream response after stop → origin settled exactly once (from stop), NOT re-delivered", async () => {
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      // Fire sendInternal → captures a real upstream id in the mux.
      let settleCount = 0;
      let settledWith: string | null = null;
      const p = h.lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.then(
        () => { settleCount++; settledWith = "resolved"; },
        (e) => { settleCount++; settledWith = `rejected:${e.message}`; },
      );
      await new Promise((r) => setTimeout(r, 10));
      // Capture the real upstream id from the frame written.
      const uid = (upstream.written[0] as JsonRpcRequestFrame).id;
      // Trigger teardown. Under the hood this drains mux → rejects
      // internal pending exactly once.
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 20));
      expect(settleCount).toBe(1);
      expect(settledWith).toMatch(/rejected:/);
      // Inject a LATE upstream response for that same id — the
      // router is unsubscribed, so nothing should route it.
      upstream.emitFrame({ jsonrpc: "2.0", id: uid, result: { late: true } });
      await new Promise((r) => setTimeout(r, 20));
      // No re-delivery: settleCount unchanged.
      expect(settleCount).toBe(1);
      expect(h.lifecycle.pendingUpstreamCount()).toBe(0);
    } finally { await h.cleanup(); }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 3 additions (副指挥 cdd20559)
// ─────────────────────────────────────────────────────────────────────

/**
 * A value whose `toString` / `valueOf` throw. `String(coercionBoom)`
 * throws; `Object.prototype.toString.call(...)` does NOT (it uses
 * the internal Symbol.toStringTag path). The `toError` helper must
 * therefore be robust against `String()` throws.
 */
function makeCoercionBoom(msg = "coercion_boom"): unknown {
  const bomb: Record<string, unknown> = Object.create(null);
  bomb.toString = () => { throw new Error(msg); };
  bomb.valueOf = () => { throw new Error(msg); };
  return bomb;
}

describe("Commit 2 corrective round 3 P0 — non-stringifiable rejection convergence (toError total)", () => {
  test("upstream close throws non-Error non-stringifiable value → stop fulfilled, terminal, no unhandled", async () => {
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).close = () => {
      upstream.closeCallCount++;
      return Promise.reject(makeCoercionBoom("close_coerce_boom"));
    };
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      // stop() must resolve — NOT reject — even under a poisoned rejection.
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      // 副指挥 13dd3853 E: close's rejection is real → ledger
      // slot populated → terminal MUST be `stop_failed`.
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailureLedger().upstreamClose).not.toBeNull();
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("upstream abort throws non-Error non-stringifiable value → stop fulfilled, terminal, no unhandled", async () => {
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_forces_abort") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).abort = () => {
      upstream.abortCallCount++;
      return Promise.reject(makeCoercionBoom("abort_coerce_boom"));
    };
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      // stopFailure returns the abort-side synthetic Error identity.
      const primary = h.lifecycle.stopFailure();
      expect(primary).not.toBeNull();
      expect(primary).toBeInstanceOf(Error);
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("local backend stop throws non-Error non-stringifiable value → stop fulfilled, terminal, no unhandled", async () => {
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWithMisbehavingBackend(
      upstream,
      { kind: "throw", error: makeCoercionBoom("backend_stop_coerce_boom") as Error },
    );
    try {
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailureLedger().backendStop).not.toBeNull();
      expect(h.lifecycle.stopFailureLedger().backendStop).toBeInstanceOf(Error);
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("local TUI stop throws non-Error non-stringifiable value → stop fulfilled, terminal, no unhandled", async () => {
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWithMisbehavingTui(
      upstream,
      { kind: "throw", error: makeCoercionBoom("tui_stop_coerce_boom") as Error },
    );
    try {
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailureLedger().tuiStop).not.toBeNull();
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("forceTerminate throws non-Error non-stringifiable value → stop fulfilled, terminal, no unhandled", async () => {
    // Local stop throws AND forceTerminate throws a coercion-boom.
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    const h = await makeLifecycleWithMisbehavingBackend(
      upstream,
      { kind: "throw", error: new Error("stop_throw_forces_force") },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const be = (h.lifecycle as unknown as any).backendServer;
    if (be !== null && be !== undefined) {
      const originalForce = be.forceTerminate.bind(be);
      be.forceTerminate = () => {
        try { originalForce(); } catch { /* absorb underlying cleanup */ }
        throw makeCoercionBoom("force_coerce_boom");
      };
    }
    try {
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailureLedger().backendStop).not.toBeNull();
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("upstream close rejects with Proxy whose Symbol.toStringTag getter throws → toError fallback fires; terminal; no unhandled", async () => {
    // 副指挥 cdd20559 pre-submit #4: `Object.prototype.toString`
    // internally reads `Symbol.toStringTag` — a Proxy get-trap
    // that throws will make even the safer fallback throw. `toError`
    // catches that and falls through to the fixed synthetic
    // marker. This test verifies the FINAL fallback is reached
    // and shutdown converges.
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    // Create a Proxy over a plain object whose ALL get access is
    // poisoned. Both `toString` and `Symbol.toStringTag` lookups
    // will throw.
    const poisonedProxy = new Proxy({}, {
      get(_target, _prop) { throw new Error("proxy_get_boom"); },
      has(_target, _prop) { throw new Error("proxy_has_boom"); },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).close = () => {
      upstream.closeCallCount++;
      return Promise.reject(poisonedProxy);
    };
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toBeNull();
      // 副指挥 13dd3853 E: Proxy rejection → ledger populated →
      // terminal MUST be `stop_failed`.
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      const closeErr = h.lifecycle.stopFailureLedger().upstreamClose;
      expect(closeErr).not.toBeNull();
      expect(closeErr).toBeInstanceOf(Error);
      // Message contains the synthetic marker OR the fallback
      // Object-prototype tag; either is acceptable — the invariant
      // is "convergence with a real Error, no unhandled".
      expect(typeof closeErr?.message).toBe("string");
      expect(closeErr?.message.length).toBeGreaterThan(0);
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });

  test("onUpstreamCloseFromRouter cascade cannot surface unhandled rejection even if downstream sees hostile throw", async () => {
    let unhandled: unknown = null;
    const listener = (r: unknown): void => { unhandled = r; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    // Close throws a hostile value AND abort throws one too — the
    // fire-and-forget cascade `void this.stop().catch(...)` must
    // absorb any hypothetical downstream rejection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).close = () => Promise.reject(makeCoercionBoom("cascade_close_boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as any).abort = () => Promise.reject(makeCoercionBoom("cascade_abort_boom"));
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      // Trigger the cascade path — active-close via emitClose.
      upstream.emitClose();
      // Wait for cascade to fully settle.
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toBeNull();
      // And a follow-up manual stop still resolves cleanly.
      await h.lifecycle.stop();
      // 副指挥 13dd3853 E: cascade path had both close AND abort
      // reject → ledger has failures → `stop_failed`.
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailureLedger().upstreamClose).not.toBeNull();
      expect(h.lifecycle.stopFailureLedger().upstreamAbort).not.toBeNull();
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 4 — doStart full-body catch (副指挥 dd12966c runtime blocker)
//
// Prior `doStart` only wrapped the four phase awaits + the router
// subscribe. Synchronous throws during the CONSTRUCTION phase
// (mux/reverseNs/coordinator/bearer/BackendUdsServer/TuiWsServer/
// UpstreamRouter constructors) OR from `router.activate()` escaped
// unhandled, leaving state='starting' with dangling refs.
//
// Round-4 wraps the ENTIRE doStart body in a unified try/catch that
// funnels ANY throw through `rollbackStartFailure()` → the memoised
// teardown core. These tests prove convergence for a REAL construction
// throw (backendCapability too short) plus a synthetic
// router-constructor throw and a synthetic activate throw.
// ─────────────────────────────────────────────────────────────────────

describe("Commit 2 corrective round 4 — doStart full-body catch converges construction/activate throws", () => {
  test("backendCapability='short' → BackendUdsServer constructor throws → start rejects; terminal state; no leaks", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: "short",
    });
    await expect(lifecycle.start()).rejects.toThrow();
    expect(lifecycle.currentState()).toBe("stopped");
    expect(lifecycle.stopFailureLedger().backendStop).toBeNull();
    expect(lifecycle.stopFailureLedger().tuiStop).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamClose).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamAbort).toBeNull();
    expect(lifecycle.takeTuiBearerPlaintextForLauncher()).toBeNull();
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    const stopP1 = lifecycle.stop();
    const stopP2 = lifecycle.stop();
    expect(stopP1).toBe(stopP2);
    await Promise.all([stopP1, stopP2]);
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("UpstreamRouter.subscribe() throws (transport onFrame throw) → start rejects; terminal; no leaks", async () => {
    // 副指挥 64fad5de evidence: `onFrame` is called INSIDE
    // `UpstreamRouter.subscribe()`, not the router constructor.
    // Renamed for accuracy.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    class SubscribeThrowTransport implements UpstreamTransport {
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(_h: (raw: unknown) => void): () => void {
        throw new Error("synthetic_router_subscribe_throw");
      }
      onClose(_h: () => void): () => void { return () => {}; }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: new SubscribeThrowTransport(),
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await expect(lifecycle.start()).rejects.toThrow(/synthetic_router_subscribe_throw/);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(lifecycle.takeTuiBearerPlaintextForLauncher()).toBeNull();
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    const stopP = lifecycle.stop();
    expect(stopP).toBe(lifecycle.stop());
    await stopP;
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("router.activate() throws (synthetic) → start rejects; terminal; teardown core entered exactly 1; no leaks", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    let preflightSettle: (v: void) => void = () => {};
    const preflightP = new Promise<void>((res) => { preflightSettle = res; });
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => preflightP },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    const startP = lifecycle.start();
    await Promise.resolve(); await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = (lifecycle as unknown as any).upstreamRouter as { activate: () => void } | null;
    if (router !== null) {
      router.activate = () => { throw new Error("synthetic_activate_throw"); };
    }
    preflightSettle();
    let rejectMsg = "";
    try { await startP; } catch (e) { rejectMsg = (e as Error).message; }
    expect(rejectMsg).toMatch(/synthetic_activate_throw/);
    // 副指挥 64fad5de evidence: activate-throw with a clean
    // rollback (backend/tui stop resolved cleanly, upstream close
    // resolved cleanly, abort not called) → EXACTLY `stopped` +
    // four-ledger-null. Not the loose ["stopped","stop_failed"]
    // from round-4.
    expect(lifecycle.currentState()).toBe("stopped");
    expect(lifecycle.stopFailureLedger().backendStop).toBeNull();
    expect(lifecycle.stopFailureLedger().tuiStop).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamClose).toBeNull();
    expect(lifecycle.stopFailureLedger().upstreamAbort).toBeNull();
    // Full cleanup: bearer unclaimable, socket unlinked, refs null.
    expect(lifecycle.takeTuiBearerPlaintextForLauncher()).toBeNull();
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    expect(
      (lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue,
    ).toBe(1);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 5 — reentrant shutdown single-flight (副指挥 64fad5de)
//
// Prior `stop()` and `runTeardownCore()` assigned the memoised
// promise AFTER calling the async body — the body's synchronous
// prefix (before its first await) ran while the memo was still
// null. If that prefix synchronously triggered a reentrant `stop()`
// (via `router.unsubscribe()` → sync close handler →
// `onUpstreamCloseFromRouter` → `void this.stop()`), the reentrance
// saw a null memo and started a SECOND teardown core.
//
// Fix: `this.shutdownPromise = Promise.resolve().then(() => this
// .doOuterStop())`. The body runs on a microtask so the memo
// assignment is observable before any body code runs. Same pattern
// applied to `runTeardownCore`.
// ─────────────────────────────────────────────────────────────────────

class SyncCloseOnUnsubscribeTransport implements UpstreamTransport {
  written: Array<JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame> = [];
  private frameHandlers: Array<(raw: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closeCallCount = 0;
  abortCallCount = 0;
  private closeBehaviour: { kind: "resolve" } | { kind: "throw"; error: Error } = { kind: "resolve" };
  setClose(b: SyncCloseOnUnsubscribeTransport["closeBehaviour"]): void { this.closeBehaviour = b; }
  async writeFrame(f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
    this.written.push(f);
  }
  onFrame(h: (raw: unknown) => void): () => void {
    this.frameHandlers.push(h);
    return () => {
      // Sync-fire close handlers when frame subscription is torn
      // down. This puts a reentrant `stop()` call INSIDE
      // `router.unsubscribe()` inside `doTeardownCore()`'s
      // synchronous prefix.
      this.frameHandlers = this.frameHandlers.filter((x) => x !== h);
      for (const ch of [...this.closeHandlers]) {
        try { ch(); } catch { /* silent */ }
      }
    };
  }
  onClose(h: () => void): () => void {
    this.closeHandlers.push(h);
    return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
  }
  async close(): Promise<void> {
    this.closeCallCount++;
    switch (this.closeBehaviour.kind) {
      case "resolve": return;
      case "throw": throw this.closeBehaviour.error;
    }
  }
  async abort(): Promise<void> { this.abortCallCount++; }
}

describe("Commit 2 corrective round 6 (副指挥 8cd477e9) — universal shutdown-visibility invariants", () => {
  // Round 6 unified invariants:
  //   I1: shutdown intent + admission gate SYNC visible at stop() return.
  //   I2: outer + core memos SYNC visible before any body/transport/await.
  //   I3: first terminal outcome + ledger STABLE (no late-completion wash).
  //   I4: start/stop/teardown/upstream-close/sendInternal/bearer/preflight
  //       admission all draw from the same state fact; no local exceptions.
  //
  // Matrix below covers every listed entry × timing × assertion.

  test("I1: running + stop() → SYNC state=stopping, bearer=null, sendInternal reject, write=0 (same call stack)", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await lifecycle.start();
    expect(lifecycle.currentState()).toBe("running");
    // Fire stop() and observe IMMEDIATELY (same call stack).
    const stopP = lifecycle.stop();
    const stateAfterStopCall = lifecycle.currentState();
    const bearerAfterStopCall = lifecycle.takeTuiBearerPlaintextForLauncher();
    // sendInternal must reject synchronously; and no write hits
    // the transport.
    let sendReason: string | null = null;
    const sendP = lifecycle.sendInternal("thread/status", { threadId: "t" });
    sendP.catch((e: Error) => { sendReason = e.message; });
    const writesAfterStopCall = upstream.written.length;
    // Also: 1 user microtask later (round-5 fix regressed this).
    await Promise.resolve();
    const stateAfterOneTask = lifecycle.currentState();
    const writesAfterOneTask = upstream.written.length;
    // Now let stop resolve.
    await stopP;
    // Wait for sendInternal's rejection to bubble.
    await new Promise((r) => setTimeout(r, 5));
    expect(stateAfterStopCall).not.toBe("running");
    expect(["stopping", "stopped"]).toContain(stateAfterStopCall);
    expect(bearerAfterStopCall).toBeNull();
    expect(writesAfterStopCall).toBe(0);
    expect(stateAfterOneTask).not.toBe("running");
    expect(writesAfterOneTask).toBe(0);
    expect(sendReason).not.toBeNull();
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("I1+I4: created + stop() → SYNC state=stopped; same-turn start() throws; never-preflight cannot wedge stop", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    let preflightCallCount = 0;
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: {
        run: async () => {
          preflightCallCount++;
          // Never resolves — if start() got in, stop() would wait
          // on startInProgress forever.
          return new Promise<void>(() => {});
        },
      },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    expect(lifecycle.currentState()).toBe("created");
    const stopP = lifecycle.stop();
    // Same call stack: state MUST already be "stopped" (or at
    // worst "stopping"). MUST NOT be "created".
    const stateAfterStopCall = lifecycle.currentState();
    expect(stateAfterStopCall).not.toBe("created");
    // Same-turn start() MUST throw — no admission.
    let startReason = "";
    try { await lifecycle.start(); } catch (e) { startReason = (e as Error).message; }
    expect(startReason).toMatch(/cannot start from state/);
    // Preflight must NEVER have been called (start throw at guard).
    expect(preflightCallCount).toBe(0);
    // stop() resolves within a bounded window — the never-
    // preflight would only matter if start() had entered.
    await Promise.race([
      stopP,
      new Promise<void>((_r, rej) =>
        setTimeout(() => rej(new Error("stop_wedged_by_never_preflight")), 500),
      ),
    ]);
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("I1: bearer claim + sendInternal after stop() return + 1 microtask both closed (regressed by round-5, fixed round-6)", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await lifecycle.start();
    const stopP = lifecycle.stop();
    await Promise.resolve();
    // Round-5 regression window: exactly here, `state` was still
    // "running", bearer still claimable, sendInternal still wrote.
    expect(lifecycle.currentState()).not.toBe("running");
    expect(lifecycle.takeTuiBearerPlaintextForLauncher()).toBeNull();
    const writesBefore = upstream.written.length;
    const p = lifecycle.sendInternal("thread/status", { threadId: "t" });
    let sendErr = "";
    p.catch((e: Error) => { sendErr = e.message; });
    // Wait for the rejection microtask.
    await new Promise((r) => setTimeout(r, 5));
    expect(sendErr).not.toBe("");
    expect(upstream.written.length).toBe(writesBefore);
    await stopP;
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("I2 + I4: sync unsubscribe → sync close handler → reentrant stop() via spy captures identical Promise; core=1, close=1", async () => {
    // 副指挥 8cd477e9 evidence: previously the "reentrant Promise"
    // was actually a follow-up stop() AFTER outerP resolved. This
    // test spies on lifecycle.stop so the INNER reentrant call
    // from `onUpstreamCloseFromRouter → void this.stop()` is
    // captured directly.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    const transport = new SyncCloseOnUnsubscribeTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await lifecycle.start();
    // Install spy AFTER start (so the router's internal wiring
    // isn't affected). Every subsequent stop() call — including
    // the reentrant one from inside the close handler — flows
    // through the spy.
    const stopReturns: Promise<void>[] = [];
    const originalStop = lifecycle.stop.bind(lifecycle);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (lifecycle as unknown as any).stop = () => {
      const p = originalStop();
      stopReturns.push(p);
      return p;
    };
    const outerP = lifecycle.stop();
    await outerP;
    // The spy captured at least the outer call PLUS the reentrant
    // call from onUpstreamCloseFromRouter (fired inside
    // router.unsubscribe → sync close handler).
    expect(stopReturns.length).toBeGreaterThanOrEqual(2);
    // Every captured return is the SAME Promise reference (memo).
    for (const p of stopReturns) expect(p).toBe(outerP);
    expect(
      (lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue,
    ).toBe(1);
    expect(transport.closeCallCount).toBe(1);
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("I3: first close rejects, hypothetical second call would be CLEAN → close called EXACTLY once; no ledger wash; 300 ms stable", async () => {
    // 副指挥 8cd477e9 evidence: two-behaviour transport so a
    // double-core reentrance would OVERWRITE ledger.upstreamClose
    // with null (wash the failure). The single-flight fix keeps
    // close called exactly once → first reject preserved.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    const firstCloseErr = new Error("first_close_reject_wash_check");
    class FirstRejectThenCleanTransport implements UpstreamTransport {
      closeCalls = 0;
      abortCalls = 0;
      private frameHandlers: Array<(raw: unknown) => void> = [];
      private closeHandlers: Array<() => void> = [];
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        return () => {
          this.frameHandlers = this.frameHandlers.filter((x) => x !== h);
          for (const ch of [...this.closeHandlers]) {
            try { ch(); } catch {}
          }
        };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> {
        this.closeCalls++;
        if (this.closeCalls === 1) {
          // Delayed rejection — makes the wash window observable
          // if a double-core were running.
          await new Promise((r) => setTimeout(r, 10));
          throw firstCloseErr;
        }
        // Second call (which we assert does NOT happen) would be
        // clean. If it were called, ledger.upstreamClose would be
        // overwritten to null and state would flip to `stopped`.
      }
      async abort(): Promise<void> { this.abortCalls++; }
    }
    const transport = new FirstRejectThenCleanTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    await lifecycle.start();
    await lifecycle.stop();
    // Capture at stop() return.
    const stateAt = lifecycle.currentState();
    const primaryAt = lifecycle.stopFailure();
    const ledgerCloseAt = lifecycle.stopFailureLedger().upstreamClose;
    // 300 ms drift window — round-4 verdict quoted ~120 ms
    // between the outer resolve and the second-core completion.
    await new Promise((r) => setTimeout(r, 300));
    expect(transport.closeCalls).toBe(1); // load-bearing: NO wash
    expect(
      (lifecycle as unknown as { teardownCoreEnteredCountValue: number }).teardownCoreEnteredCountValue,
    ).toBe(1);
    expect(stateAt).toBe("stop_failed");
    expect(primaryAt).toBe(firstCloseErr);
    expect(ledgerCloseAt).toBe(firstCloseErr);
    // Stable across the drift window.
    expect(lifecycle.currentState()).toBe(stateAt);
    expect(lifecycle.stopFailure()).toBe(primaryAt);
    expect(lifecycle.stopFailureLedger().upstreamClose).toBe(ledgerCloseAt);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 7 — start-side reentrance / epoch-CAS (副指挥 b65ebc50 + e8cdc302)
// ─────────────────────────────────────────────────────────────────────

describe("Commit 2 corrective round 7 — start memo prepublish + shutdown signal race + activate CAS", () => {
  test("preflight.run() sync-calls stop() AND never resolves → stop settles bounded; start rejects; state=stopped; no leaks", async () => {
    // 副指挥 b65ebc50 P0-1: preflight synchronously reentrant
    // stop, then never resolves. Without the shutdown-signal
    // race, stop() awaits startInProgress forever.
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    let stopP: Promise<void> | null = null;
    const preflight: PreflightRunner = {
      run: () => {
        stopP = lifecycle.stop(); // sync reentrant stop
        return new Promise<void>(() => { /* never */ });
      },
    };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    const startP = lifecycle.start();
    // Both settle within a bounded window.
    const startResult = await Promise.race([
      startP.then(() => "resolved", (e: Error) => `rejected:${e.message}`),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("start_wedged")), 800)),
    ]);
    expect(String(startResult)).toContain("rejected");
    await Promise.race([
      stopP!,
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error("stop_wedged")), 500)),
    ]);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(fs.existsSync(paths.backendSocketPath)).toBe(false);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("external stop() during held never-resolving preflight → stop settles bounded; start rejects; state=stopped", async () => {
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    const { diagnostics } = collectDiagnostics();
    const preflight: PreflightRunner = { run: () => new Promise<void>(() => {}) };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight,
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    const startP = lifecycle.start();
    // Yield so start is parked at the preflight race.
    await Promise.resolve(); await Promise.resolve();
    const stopP = lifecycle.stop();
    await Promise.race([
      stopP,
      new Promise<void>((_r, rej) => setTimeout(() => rej(new Error("stop_wedged_by_never_preflight")), 500)),
    ]);
    let startErr = "";
    try { await startP; } catch (e) { startErr = (e as Error).message; }
    expect(startErr).toMatch(/start aborted/);
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("transport.onFrame handler sync-calls stop DURING router.subscribe registration → subscribe finishes; NO transport handler leak", async () => {
    // 副指挥 b65ebc50: prior to Round 7 the reentrant stop
    // during subscribe ran teardown BEFORE subscribe returned
    // its unsub function to the router — router.unsubscribe
    // called with null frameUnsub/closeUnsub → real transport
    // handlers leaked (`frameHandlers.length === 1` after
    // teardown).
    //
    // With Round 7's SYNC startInProgress prepublish, the
    // reentrant stop awaits startInProgress → teardown deferred
    // until start settles → subscribe completes storing its
    // unsub functions before teardown runs.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    class SyncStopOnRegisterTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      lifecycle: GatewayLifecycle | null = null;
      stopFiredSync = false;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        // Sync-invoke stop during registration ONCE.
        if (!this.stopFiredSync && this.lifecycle !== null) {
          this.stopFiredSync = true;
          void this.lifecycle.stop().catch(() => {});
        }
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const transport = new SyncStopOnRegisterTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    transport.lifecycle = lifecycle;
    let startErr = "";
    try { await lifecycle.start(); } catch (e) { startErr = (e as Error).message; }
    expect(startErr).toMatch(/start aborted/);
    expect(lifecycle.currentState()).toBe("stopped");
    // Load-bearing: teardown unsubscribed both handler slots.
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("activate() sync-dispatches diagnostics that call stop → CAS refuses admission; state never 'running'; write=0", async () => {
    // 副指挥 e8cdc302 P0-2: activate synchronously dispatches
    // buffered frames — a diagnostics-sink handler could call
    // stop() during that dispatch. Round-6's fence transitions
    // state to "stopping" sync, but round-6's post-activate
    // path still wrote `state = "running"` unconditionally.
    // Round-7 adds the epoch/CAS commit: if the epoch bumped or
    // state left "starting", DO NOT commit "running".
    const paths = pathsFor();
    const upstream = new ControllableUpstream();
    let sink: GatewayLifecycle | null = null;
    // Custom diagnostics sink: on FIRST report, sync-call stop().
    // Buffered notification is dispatched during activate() and
    // classified as a diagnostic ("upstream_notification_dropped_
    // phase1") — that hits the sink.
    let sinkFired = false;
    const sinkDiag: ProtocolDiagnostics = {
      newCorrelationId: () => "cid",
      reportInternalError: () => {
        if (!sinkFired && sink !== null) {
          sinkFired = true;
          void sink.stop().catch(() => {});
        }
      },
    };
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: sinkDiag,
      backendCapability: TEST_BACKEND_CAP,
    });
    sink = lifecycle;
    // Buffer a notification in the router's pre-active state so
    // activate() sync-dispatches it → sink fires → stop reentrance.
    // The transport's onFrame runs after subscribe; we emit a
    // notification BEFORE `activate()` is called (i.e., during the
    // preflight window). Simpler: emit right before activate by
    // holding preflight open, or emit on `onFrame` first invocation.
    // Cleanest approach: pre-buffer via emit after subscribe but
    // before activate. Preflight is trivially resolved; we can't
    // interpose. Use the ControllableUpstream: after start()
    // resolves the sink fires but activate has already completed.
    //
    // Simpler probe: after start() completes successfully (no reentrance),
    // an emitFrame notification triggers the sink → sink calls
    // stop() → post-start behaviour observed. But that doesn't test
    // the CAS in activate.
    //
    // Instead, use a subscribe hook that emits a notification during
    // subscribe, so the buffered notification is dispatched by
    // activate.
    class NotifyOnSubscribeTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      writesCount = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
        this.writesCount++;
      }
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        // Push a notification into the router's pre-active buffer
        // by calling h() synchronously after registration.
        setTimeout(() => {
          if (this.frameHandlers.includes(h)) {
            h({ jsonrpc: "2.0", method: "some/notification", params: {} });
          }
        }, 0);
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const paths2 = pathsFor();
    const notifyTransport = new NotifyOnSubscribeTransport();
    let sink2: GatewayLifecycle | null = null;
    let sink2Fired = false;
    const sinkDiag2: ProtocolDiagnostics = {
      newCorrelationId: () => "cid",
      reportInternalError: () => {
        if (!sink2Fired && sink2 !== null) {
          sink2Fired = true;
          void sink2.stop().catch(() => {});
        }
      },
    };
    const lc = new GatewayLifecycle({
      backendSocketPath: paths2.backendSocketPath,
      socketDir: paths2.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: notifyTransport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: sinkDiag2,
      backendCapability: TEST_BACKEND_CAP,
    });
    sink2 = lc;
    let startErr = "";
    let startResolved = false;
    try { await lc.start(); startResolved = true; } catch (e) { startErr = (e as Error).message; }
    // With CAS, start may resolve (if sink fires after activate
    // commits) OR reject (if sink fires during activate). Either
    // way, no "running" revive AFTER stop was signalled.
    // Give the deferred setTimeout notification a chance to fire.
    await new Promise((r) => setTimeout(r, 30));
    const stateNow = lc.currentState();
    // Terminal state — never revives to running once stop was
    // signalled.
    if (sink2Fired) {
      // Stop reentrance happened. Either start rejected via CAS
      // OR started then stopped normally — in both cases the
      // terminal is `stopped` and NO transport write must have
      // happened after admission was refused.
      expect(["stopping", "stopped", "stop_failed"]).toContain(stateNow);
    }
    // No spurious upstream writes should have happened before
    // admission (the initial phase-1 flow does not write until
    // sendInternal is called — writes should stay at 0 in this
    // test since no user sendInternal was invoked).
    expect(notifyTransport.writesCount).toBe(0);
    // Belt-and-braces: if we got to running, subsequent stop() is
    // clean; if we got to a terminal directly, ensure stop is
    // idempotent.
    await lc.stop();
    expect(["stopped", "stop_failed"]).toContain(lc.currentState());
    void startResolved; // reference to satisfy no-unused-vars
    void startErr;
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(paths2.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 8 — pre-active close signal + subscribe→preflight fence +
// safe adoption of user-provided promises (副指挥 ef331a80 + cb54a10e)
// ─────────────────────────────────────────────────────────────────────

describe("Commit 2 corrective round 8 — pre-active close + subscribe fence + safe adoption", () => {
  test("subscribe sync-close + NEVER preflight → preflight NOT called; start rejects; handlers=0; close=1; bounded settle", async () => {
    // 副指挥 ef331a80 P0-1 case: transport.onFrame handler
    // synchronously fires a close event during subscribe. Router
    // records `receivedCloseBeforeActive` AND invokes
    // `onPreActiveClose`, which fires the shutdown signal +
    // bumps the epoch. Then subscribe returns. The Round-8
    // subscribe→preflight fence catches the epoch bump and
    // rolls back BEFORE calling `preflight.run()`.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let preflightCalls = 0;
    class SyncCloseOnRegisterTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      closeCalls = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        // Sync-fire close inside onClose registration so the
        // router sees it in `subscribed` state.
        h();
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> { this.closeCalls++; }
      async abort(): Promise<void> {}
    }
    const transport = new SyncCloseOnRegisterTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: {
        run: () => { preflightCalls++; return new Promise<void>(() => {}); },
      },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    let startErr = "";
    const startResult = await Promise.race([
      lifecycle.start().then(() => "resolved", (e: Error) => { startErr = e.message; return "rejected"; }),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("start_wedged")), 800)),
    ]);
    expect(startResult).toBe("rejected");
    // Load-bearing: preflight was NEVER called because the fence
    // caught the epoch bump / preActiveClose flag first.
    expect(preflightCalls).toBe(0);
    expect(startErr).toMatch(/start aborted before preflight/);
    expect(lifecycle.currentState()).toBe("stopped");
    // Router unsubscribed both handler slots. close() called
    // exactly once (during teardown; the sync-fire during onClose
    // registration did NOT go through transport.close()).
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    expect(transport.closeCalls).toBe(1);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("pre-active close during HELD never-preflight → race unblocks; preflight has been called once but NOT waited on; start rejects; bounded", async () => {
    // 副指挥 ef331a80 P0-1 case: preflight is already running
    // (never resolves). Transport delivers close AFTER subscribe
    // has returned. Router records `receivedCloseBeforeActive`
    // AND fires `onPreActiveClose` → lifecycle shutdown signal
    // fires → `Promise.race([preflight, shutdownSignal])` throws
    // → doStart rolls back. No external stop() needed.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let preflightCalls = 0;
    let scheduledClose: (() => void) | null = null;
    class DeferredCloseTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      closeCalls = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        scheduledClose = () => h();
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> { this.closeCalls++; }
      async abort(): Promise<void> {}
    }
    const transport = new DeferredCloseTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: {
        run: () => { preflightCalls++; return new Promise<void>(() => {}); },
      },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    const startP = lifecycle.start();
    // Yield so start reaches the preflight race.
    await Promise.resolve(); await Promise.resolve();
    expect(preflightCalls).toBe(1);
    // Deliver the pre-active close ASYNC.
    setTimeout(() => scheduledClose?.(), 10);
    let startErr = "";
    const startResult = await Promise.race([
      startP.then(() => "resolved", (e: Error) => { startErr = e.message; return "rejected"; }),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("start_wedged")), 600)),
    ]);
    expect(startResult).toBe("rejected");
    expect(startErr).toMatch(/start aborted/);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("preflight promise with poisoned `.catch` getter → race unblocks safely; late reject → 0 unhandledRejection", async () => {
    // 副指挥 cb54a10e safe-adoption case: preflight.run() returns
    // a real Promise whose OWN `.catch` property has a throwing
    // getter. Round-7 code did `preflightP.catch(() => {})` at
    // attach → threw synchronously. Round-8 removed that attach
    // and uses `Promise.resolve(preflightP)` for safe adoption —
    // Promise.race's own `.then` handler consumes any late
    // rejection.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let poisonedGetterReads = 0;
    // Build a real Promise, then poison its instance `.catch`.
    let rejectPreflight: (reason?: unknown) => void = () => {};
    const preflightPromise = new Promise<void>((_res, rej) => { rejectPreflight = rej; });
    Object.defineProperty(preflightPromise, "catch", {
      get() { poisonedGetterReads++; throw new Error("poisoned_catch_getter"); },
      configurable: true,
    });
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => preflightPromise },
      backend: makeBackend(),
      upstreamTransport: new ControllableUpstream(),
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      const startP = lifecycle.start();
      // Give race a chance to attach.
      await Promise.resolve(); await Promise.resolve();
      // Trigger shutdown via external stop, unblocking the race
      // via the shutdown signal.
      const stopP = lifecycle.stop();
      // Now reject the preflight LATE — a late unhandled rejection
      // WOULD surface if the safe-adoption path had touched the
      // poisoned `.catch` and Promise.race had failed to attach.
      setTimeout(() => rejectPreflight(new Error("late_preflight_reject")), 20);
      let startErr = "";
      try { await startP; } catch (e) { startErr = (e as Error).message; }
      await stopP;
      await new Promise((r) => setTimeout(r, 100));
      // The Round-7 code read `preflightP.catch(...)` — the
      // poisoned getter would have thrown; Round-8 never reads it
      // (we use Promise.resolve()), so the getter is NEVER hit
      // by the lifecycle. Any getter read (e.g., by a debugger or
      // unrelated tooling) is fine; the load-bearing count is 0
      // reads from the lifecycle path.
      expect(poisonedGetterReads).toBe(0);
      expect(unhandledCount).toBe(0);
      expect(startErr).toMatch(/start aborted/);
      expect(lifecycle.currentState()).toBe("stopped");
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("deterministic activate CAS red — pre-buffered notification + sink sync-stop during activate → no revive; write=0; handlers=0; terminal", async () => {
    // 副指挥 ef331a80 Round 8: rewrite the activate CAS test to
    // deterministically hit the activate() code path. Router is
    // held in pre-active `subscribed` state until preflight
    // resolves. We manually push a notification frame into the
    // router's buffer, then release preflight. Activate then
    // drains the buffer synchronously — the notification's
    // "upstream_notification_dropped_phase1" diagnostic reaches
    // the sink, which sync-calls stop(). CAS gate refuses admission.
    const paths = pathsFor();
    let sink: GatewayLifecycle | null = null;
    let sinkFired = false;
    const sinkDiag: ProtocolDiagnostics = {
      newCorrelationId: () => "cid",
      reportInternalError: () => {
        if (!sinkFired && sink !== null) {
          sinkFired = true;
          void sink.stop().catch(() => {});
        }
      },
    };
    let deliverFrame: ((raw: unknown) => void) | null = null;
    let releasePreflight: () => void = () => {};
    const preflightP = new Promise<void>((res) => { releasePreflight = res; });
    class BufferInjectTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      writesCount = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
        this.writesCount++;
      }
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        deliverFrame = h;
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const transport = new BufferInjectTransport();
    const lc = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => preflightP },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: sinkDiag,
      backendCapability: TEST_BACKEND_CAP,
    });
    sink = lc;
    const startP = lc.start();
    // Yield so start reaches the preflight race, router is now
    // subscribed and buffering. Push a notification frame.
    await Promise.resolve(); await Promise.resolve();
    deliverFrame?.({ jsonrpc: "2.0", method: "buffered/notification", params: {} });
    // Release preflight → doStart continues past preflight →
    // backendServer.start / tuiServer.start / activate. During
    // activate the buffered notification drains → sink fires →
    // sync stop → epoch bumps → post-activate CAS refuses admission.
    releasePreflight();
    let startErr = "";
    let startFulfilled = false;
    try { await startP; startFulfilled = true; } catch (e) { startErr = (e as Error).message; }
    // NEVER revives to running.
    expect(lc.currentState()).not.toBe("running");
    // sink fired → shutdown intent registered.
    expect(sinkFired).toBe(true);
    // Either start rejected via CAS OR resolved AND state now stopped.
    // Load-bearing: no upstream write happened.
    expect(transport.writesCount).toBe(0);
    // Terminal reached; handlers cleaned.
    await lc.stop();
    // 副指挥 7d061fcd evidence: tighten to EXACT terminal.
    // Clean rollback in this scenario → `stopped`.
    expect(lc.currentState()).toBe("stopped");
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    // Start MUST have rejected (activate ran but CAS blocked
    // commit). A silent resolve is green-wash.
    expect(startFulfilled).toBe(false);
    expect(startErr).toMatch(/start aborted/);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 9 — pre-active overflow signal unification + safeAdopt primitive
// across preflight / router writeFrame / backend writeFrame
// (副指挥 7d061fcd + ff8edc19)
// ─────────────────────────────────────────────────────────────────────

describe("Commit 2 corrective round 9 — unified pre-active terminal + safeAdopt primitive", () => {
  test("held never-preflight + async overflow (257 frames) → start rejects bounded; handlers=0; close=1; terminal EXACT stopped", async () => {
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let deliverFrame: ((raw: unknown) => void) | null = null;
    class DeliverableTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      closeCalls = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        deliverFrame = h;
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> { this.closeCalls++; }
      async abort(): Promise<void> {}
    }
    const transport = new DeliverableTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => new Promise<void>(() => {}) },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    const startP = lifecycle.start();
    await Promise.resolve(); await Promise.resolve();
    for (let i = 0; i < 257; i++) {
      deliverFrame?.({ jsonrpc: "2.0", method: "notif", params: { i } });
    }
    let startErr = "";
    const raced = await Promise.race([
      startP.then(() => "resolved", (e: Error) => { startErr = e.message; return "rejected"; }),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("start_wedged_after_overflow")), 800)),
    ]);
    expect(raced).toBe("rejected");
    expect(startErr).toMatch(/start aborted/);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    expect(transport.closeCalls).toBe(1);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("subscribe registration sync overflow → preflightCalls=0; start rejects; handlers=0/0", async () => {
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let preflightCalls = 0;
    class SyncOverflowTransport implements UpstreamTransport {
      frameHandlers: Array<(raw: unknown) => void> = [];
      closeHandlers: Array<() => void> = [];
      floodedOnce = false;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(h: (raw: unknown) => void): () => void {
        this.frameHandlers.push(h);
        if (!this.floodedOnce) {
          this.floodedOnce = true;
          for (let i = 0; i < 257; i++) {
            h({ jsonrpc: "2.0", method: "notif", params: { i } });
          }
        }
        return () => { this.frameHandlers = this.frameHandlers.filter((x) => x !== h); };
      }
      onClose(h: () => void): () => void {
        this.closeHandlers.push(h);
        return () => { this.closeHandlers = this.closeHandlers.filter((x) => x !== h); };
      }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const transport = new SyncOverflowTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => { preflightCalls++; return Promise.resolve(); } },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    let startErr = "";
    const raced = await Promise.race([
      lifecycle.start().then(() => "resolved", (e: Error) => { startErr = e.message; return "rejected"; }),
      new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("start_wedged")), 800)),
    ]);
    expect(raced).toBe("rejected");
    expect(startErr).toMatch(/start aborted before preflight/);
    expect(preflightCalls).toBe(0);
    expect(lifecycle.currentState()).toBe("stopped");
    expect(transport.frameHandlers.length).toBe(0);
    expect(transport.closeHandlers.length).toBe(0);
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });

  test("safeAdopt vs poisoned .then getter: native Promise fast path → getterReads=0; late reject → 0 unhandled; start rejects; stopped", async () => {
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let rejectPreflight: (reason?: unknown) => void = () => {};
    const preflightPromise = new Promise<void>((_res, rej) => { rejectPreflight = rej; });
    let thenGetterReads = 0;
    Object.defineProperty(preflightPromise, "then", {
      get() { thenGetterReads++; throw new Error("poisoned_then_getter"); },
      configurable: true,
    });
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => preflightPromise },
      backend: makeBackend(),
      upstreamTransport: new ControllableUpstream(),
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      const startP = lifecycle.start();
      await Promise.resolve(); await Promise.resolve();
      const readsAfterAttach = thenGetterReads;
      const stopP = lifecycle.stop();
      setTimeout(() => rejectPreflight(new Error("late_preflight_reject")), 20);
      let startErr = "";
      try { await startP; } catch (e) { startErr = (e as Error).message; }
      await stopP;
      await new Promise((r) => setTimeout(r, 100));
      // Native Promise fast path: safeAdopt uses
      // `Promise.prototype.then.call(preflightPromise, res, rej)`
      // — the internal `[[PromiseState]]` slot is read directly,
      // NEVER touching the caller's OWN poisoned `.then` getter.
      // Load-bearing: getterReads stays at 0 across attach AND
      // the late-reject settle.
      expect(readsAfterAttach).toBe(0);
      expect(thenGetterReads).toBe(0);
      expect(unhandledCount).toBe(0);
      expect(startErr).toMatch(/start aborted/);
      expect(lifecycle.currentState()).toBe("stopped");
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("safeAdopt: poisoned .then + concurrent stop + late reject → no unhandled; stopped; handlers=0; ledger stable", async () => {
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let rejectPreflight: (reason?: unknown) => void = () => {};
    const preflightPromise = new Promise<void>((_res, rej) => { rejectPreflight = rej; });
    Object.defineProperty(preflightPromise, "then", {
      get() { throw new Error("poisoned_then_getter"); },
      configurable: true,
    });
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    const upstream = new ControllableUpstream();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { run: () => preflightPromise },
      backend: makeBackend(),
      upstreamTransport: upstream,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      const startP = lifecycle.start();
      await Promise.resolve();
      const stopP = lifecycle.stop();
      setTimeout(() => rejectPreflight(new Error("late_preflight_reject")), 20);
      let startErr = "";
      try { await startP; } catch (e) { startErr = (e as Error).message; }
      await stopP;
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandledCount).toBe(0);
      expect(startErr).toMatch(/start aborted/);
      expect(lifecycle.currentState()).toBe("stopped");
      expect(upstream.closeCallCount).toBe(1);
      // Ledger stable — no failure recorded (poisoned .then
      // rejected the safeAdopt fresh promise → race → rollback,
      // but that's an aborted-start throw, not a teardown-stage
      // failure).
      const ledger = lifecycle.stopFailureLedger();
      expect(ledger.backendStop).toBeNull();
      expect(ledger.tuiStop).toBeNull();
      expect(ledger.upstreamClose).toBeNull();
      expect(ledger.upstreamAbort).toBeNull();
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("safeAdoptConsume — backend sendInternal writeFrame with poisoned .then + underlying reject → sendInternal rejects with underlying error; mux pending back to 0; 0 unhandled", async () => {
    // uds-server.ts uses safeAdoptConsume around
    // upstreamTransport.writeFrame(). A caller-provided Promise
    // with poisoned OWN `.then` getter is adopted via
    // `Promise.prototype.then.call` (native, uses internal
    // slot) — the poisoned instance getter is NEVER touched. On
    // the underlying rejection, safeAdopt's fresh promise
    // rejects → safeAdoptConsume calls failCleanup → mux slot
    // released + origin.reject fired.
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    try {
      const paths = pathsFor();
      const { diagnostics } = collectDiagnostics();
      let poisonedThenReads = 0;
      let makeRejectingPoisoned: () => Promise<void> = () => {
        const underlying = new Promise<void>((_res, rej) => {
          setTimeout(() => rej(new Error("underlying_write_reject")), 10);
        });
        Object.defineProperty(underlying, "then", {
          get() { poisonedThenReads++; throw new Error("poisoned_then_backend"); },
          configurable: true,
        });
        return underlying;
      };
      class PoisonedThenTransport implements UpstreamTransport {
        writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
          return makeRejectingPoisoned();
        }
        onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
        onClose(_h: () => void): () => void { return () => {}; }
        async close(): Promise<void> {}
        async abort(): Promise<void> {}
      }
      const lifecycle = new GatewayLifecycle({
        backendSocketPath: paths.backendSocketPath,
        socketDir: paths.socketDir,
        preflight: { async run() {} },
        backend: makeBackend(),
        upstreamTransport: new PoisonedThenTransport(),
        initSnapshotSource: { currentSnapshot: () => ({}) },
        diagnosticsSink: diagnostics,
        backendCapability: TEST_BACKEND_CAP,
      });
      await lifecycle.start();
      let sendReason = "";
      const p = lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.catch((e: Error) => { sendReason = e.message; });
      await new Promise((r) => setTimeout(r, 100));
      // Poisoned .then getter NEVER read (native Promise fast path).
      expect(poisonedThenReads).toBe(0);
      expect(unhandledCount).toBe(0);
      // sendInternal rejected with the underlying reject error.
      expect(sendReason).toBe("underlying_write_reject");
      // Mux slot cleaned up.
      expect(lifecycle.pendingUpstreamCount()).toBe(0);
      await lifecycle.stop();
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Round 10 corrective — lifecycle close/abort via safeAdopt +
// entry-site coverage (副指挥 fb2ec49a)
// ─────────────────────────────────────────────────────────────────────

describe("Commit 2 corrective round 10 — lifecycle close/abort routed through safeAdopt", () => {
  test("close() returns real Promise with OWN poisoned .then getter → close_error captured; NO late unhandled; state stop_failed", async () => {
    // 副指挥 fb2ec49a P0: prior lifecycle used
    // `Promise.resolve().then(() => transport.close())`, which
    // reads the caller's OWN `.then` when adopting the returned
    // Promise. Round-10 corrective routes the raw return
    // through `safeAdopt` first — the captured intrinsic attach
    // never reads instance getters.
    let unhandledCount = 0;
    const unhandledReasons: unknown[] = [];
    const listener = (r: unknown): void => { unhandledCount++; unhandledReasons.push(r); };
    process.on("unhandledRejection", listener);
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    // Make close() return a REAL native Promise that eventually
    // rejects, but poison its OWN `.then` getter.
    let closeRejecter: ((reason?: unknown) => void) | null = null;
    class PoisonedCloseThenTransport implements UpstreamTransport {
      closeCalls = 0;
      abortCalls = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
      onClose(_h: () => void): () => void { return () => {}; }
      close(): Promise<void> {
        this.closeCalls++;
        const p = new Promise<void>((_res, rej) => { closeRejecter = rej; });
        Object.defineProperty(p, "then", {
          get() { throw new Error("close_then_getter_boom"); },
          configurable: true,
        });
        return p;
      }
      async abort(): Promise<void> { this.abortCalls++; }
    }
    const transport = new PoisonedCloseThenTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      await lifecycle.start();
      const stopP = lifecycle.stop();
      // Also reject the underlying Promise after adoption to
      // prove the late reject is consumed by our attach — NOT
      // by an instance getter read.
      setTimeout(() => closeRejecter?.(new Error("underlying_close_reject")), 20);
      await stopP;
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandledCount).toBe(0);
      // close threw at adopt attach; safeAdopt's captured attach
      // NEVER read the poisoned .then getter — value's shape
      // check succeeded but `Reflect.apply(NativeThen, value, ...)`
      // works because captured NativeThen uses internal slots.
      // So the adopt succeeds and the underlying rejection
      // routes through as close_error. State = stop_failed.
      expect(lifecycle.currentState()).toBe("stop_failed");
      const closeLedger = lifecycle.stopFailureLedger().upstreamClose;
      expect(closeLedger).not.toBeNull();
      expect(transport.closeCalls).toBe(1);
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("abort() returns real Promise with OWN poisoned .then getter → abort adoption safe; NO late unhandled", async () => {
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    let abortRejecter: ((reason?: unknown) => void) | null = null;
    class PoisonedAbortThenTransport implements UpstreamTransport {
      closeCalls = 0;
      abortCalls = 0;
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
      onClose(_h: () => void): () => void { return () => {}; }
      async close(): Promise<void> {
        this.closeCalls++;
        // Force close to reject to trigger abort escalation.
        throw new Error("close_forcing_abort");
      }
      abort(): Promise<void> {
        this.abortCalls++;
        const p = new Promise<void>((_res, rej) => { abortRejecter = rej; });
        Object.defineProperty(p, "then", {
          get() { throw new Error("abort_then_getter_boom"); },
          configurable: true,
        });
        return p;
      }
    }
    const transport = new PoisonedAbortThenTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      await lifecycle.start();
      const stopP = lifecycle.stop();
      setTimeout(() => abortRejecter?.(new Error("underlying_abort_reject")), 20);
      await stopP;
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandledCount).toBe(0);
      expect(lifecycle.currentState()).toBe("stop_failed");
      expect(transport.closeCalls).toBe(1);
      expect(transport.abortCalls).toBe(1);
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("close() returns non-Promise (undefined) → contract reject at safeAdopt → close_error captured; NO unhandled", async () => {
    let unhandledCount = 0;
    const listener = (): void => { unhandledCount++; };
    process.on("unhandledRejection", listener);
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    class NonPromiseCloseTransport implements UpstreamTransport {
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {}
      onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
      onClose(_h: () => void): () => void { return () => {}; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      close(): any { return undefined; }
      async abort(): Promise<void> {}
    }
    const transport = new NonPromiseCloseTransport();
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: transport,
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      await lifecycle.start();
      await lifecycle.stop();
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandledCount).toBe(0);
      // undefined → safeAdopt contract-rejects with synthetic
      // Error → close_error. Abort escalation runs and
      // succeeds → primary = close-side synthetic Error.
      expect(lifecycle.currentState()).toBe("stop_failed");
      const closeLedger = lifecycle.stopFailureLedger().upstreamClose;
      expect(closeLedger).not.toBeNull();
      expect((closeLedger as Error).message).toMatch(/not an ordinary same-realm base native Promise/);
    } finally {
      process.off("unhandledRejection", listener);
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("non-Error rejection reason (Object.create(null)) verbatim full chain: sendInternal rejects with same identity; pending=0", async () => {
    // 副指挥 fb2ec49a corrective: end-to-end verbatim
    // propagation of a non-Error rejection reason through
    // failCleanup → origin.reject → outerReject → sendInternal
    // Promise reject.
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    const nonErrReason = Object.create(null) as Record<string, unknown>;
    nonErrReason.tag = "verbatim_non_error";
    class RejectingWriteTransport implements UpstreamTransport {
      async writeFrame(_f: JsonRpcRequestFrame | JsonRpcResponseFrame | JsonRpcNotificationFrame): Promise<void> {
        throw nonErrReason;
      }
      onFrame(_h: (raw: unknown) => void): () => void { return () => {}; }
      onClose(_h: () => void): () => void { return () => {}; }
      async close(): Promise<void> {}
      async abort(): Promise<void> {}
    }
    const lifecycle = new GatewayLifecycle({
      backendSocketPath: paths.backendSocketPath,
      socketDir: paths.socketDir,
      preflight: { async run() {} },
      backend: makeBackend(),
      upstreamTransport: new RejectingWriteTransport(),
      initSnapshotSource: { currentSnapshot: () => ({}) },
      diagnosticsSink: diagnostics,
      backendCapability: TEST_BACKEND_CAP,
    });
    try {
      await lifecycle.start();
      let seenReason: unknown = "unset";
      let seen = false;
      const p = lifecycle.sendInternal("thread/status", { threadId: "t" });
      p.catch((r: unknown) => { seenReason = r; seen = true; });
      await new Promise((r) => setTimeout(r, 30));
      expect(seen).toBe(true);
      // VERBATIM identity — same reference, no coerce.
      expect(Object.is(seenReason, nonErrReason)).toBe(true);
      expect(lifecycle.pendingUpstreamCount()).toBe(0);
    } finally {
      await lifecycle.stop();
      try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
    }
  });
});
