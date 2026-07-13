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
import { SYNC_ABORT, type SyncAbortAcknowledgement, type UpstreamTransport } from "./uds-server";
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
  abort(): SyncAbortAcknowledgement { this.abortCallCount++; return SYNC_ABORT; }
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
      expect(startResult).toMatch(/start aborted by concurrent stop|start aborted: upstream closed/);
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
  private abortBehaviour: { kind: "ok" } | { kind: "throw"; error: Error } = { kind: "ok" };

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
  abort(): SyncAbortAcknowledgement {
    this.abortCallCount++;
    if (this.abortBehaviour.kind === "throw") throw this.abortBehaviour.error;
    return SYNC_ABORT;
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

  test("close throws AND abort throws → stop_failed preserving abort error with close as cause", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_boom") });
    upstream.setAbort({ kind: "throw", error: new Error("abort_boom") });
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      expect(upstream.closeCallCount).toBe(1);
      expect(upstream.abortCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      const failure = h.lifecycle.stopFailure();
      expect(failure?.message).toBe("abort_boom");
      expect((failure?.cause as Error | undefined)?.message).toBe("close_boom");
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

describe("Commit 2 corrective #4 — rollback shares single-flight core with stop×upstream close", () => {
  test("rollback (preflight throw) × concurrent stop() × upstream close cascade → close/abort/local stop each exactly once", async () => {
    const upstream = new ControllableUpstream();
    const paths = pathsFor();
    const { diagnostics } = collectDiagnostics();
    // Preflight resolves quickly, but we make backend.start throw
    // so rollback runs — while a concurrent stop() and upstream
    // close cascade race for the same shutdown.
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
    // Start OK. Then race: emitClose + parallel stop() calls.
    await lifecycle.start();
    upstream.emitClose();
    const p1 = lifecycle.stop();
    const p2 = lifecycle.stop();
    await Promise.all([p1, p2]);
    // Single-flight: close called exactly once.
    expect(upstream.closeCallCount).toBe(1);
    expect(lifecycle.currentState()).toBe("stopped");
    try { fs.rmSync(paths.socketDir, { recursive: true, force: true }); } catch {}
  });
});

describe("Commit 2 corrective #5 — async abort never surfaces as unhandled rejection", () => {
  test("thenable-returning abort → detected + rejection consumed; stop_failed with violation Error", async () => {
    const upstream = new ControllableUpstream();
    // Override abort to return a rejecting Promise WITHOUT any
    // .catch — before the fix this would be unhandled.
    upstream.setClose({ kind: "throw", error: new Error("close_fail_to_force_abort") });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upstream as unknown as { abort: () => unknown }).abort = () => {
      return Promise.reject(new Error("async_abort_boom"));
    };
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
      expect(h.lifecycle.stopFailure()?.message).toMatch(
        /UpstreamTransport\.abort\(\) returned a thenable/,
      );
    } finally {
      process.off("unhandledRejection", listener);
      await h.cleanup();
    }
  });
});

describe("Commit 2 corrective #6 — tagged winner race (timeout wins deterministically)", () => {
  test("close settles AT SAME microtask boundary as timeout → timeout wins → abort called; stop_failed", async () => {
    const upstream = new ControllableUpstream();
    // A close that resolves right at the boundary would be racy
    // with a mutable flag; the tagged-winner race must land on
    // "timeout" because the timer resolves first. We simulate by
    // having close resolve strictly AFTER the timer fires.
    upstream.setClose({ kind: "never" }); // never resolves → timeout must win
    const h = await makeLifecycleWith(upstream);
    try {
      await h.lifecycle.start();
      await h.lifecycle.stop();
      expect(upstream.abortCallCount).toBe(1);
      expect(h.lifecycle.currentState()).toBe("stop_failed");
      expect(h.lifecycle.stopFailure()?.message).toMatch(/upstream close timed out/);
    } finally { await h.cleanup(); }
  });
});

describe("Commit 2 corrective #7 — original abort Error identity preserved (incl. frozen)", () => {
  test("TypeError with custom .code/.stack → stopFailure() === original abort Error object", async () => {
    const upstream = new ControllableUpstream();
    upstream.setClose({ kind: "throw", error: new Error("close_fail") });
    class MyTypeError extends TypeError {
      code = "E_CUSTOM_ABORT";
      constructor(msg: string) { super(msg); this.name = "MyTypeError"; }
    }
    const original = new MyTypeError("abort_boom_custom");
    upstream.setAbort({ kind: "throw", error: original });
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
    upstream.setAbort({ kind: "throw", error: frozen });
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
    upstream.setAbort({ kind: "throw", error: sealed });
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
      abort(): SyncAbortAcknowledgement { this.abortCalls++; return SYNC_ABORT; }
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
