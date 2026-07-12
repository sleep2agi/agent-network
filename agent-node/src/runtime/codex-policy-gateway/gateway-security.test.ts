// RFC-030 Wave 1B — security + integration tranche 2:
//   - shared UpstreamRequestMux: unique ids across origins on one socket,
//     tui_response routing, unknown ids fail closed as orphan
//   - TUI authorizer (Phase-1 拍板): busy-deny under agent reservation,
//     interrupt-always, config lock, bound-thread, 0 upstream writes on deny
//   - interrupted_by_human: exactly-once, structured terminal, restart does
//     not replay
//   - token isolation: scrubbed spawn env has no ntok material; argv has no
//     CommHub MCP wiring
//   - version gate: real codex 0.144.0 passes; corrupted pin fails closed

import { describe, expect, test } from "bun:test";
import { CodexAppServerClient } from "../codex-app-server-client";
import {
  buildOwnedAppServerArgs,
  scrubSpawnEnv,
  SENSITIVE_ENV_PATTERN,
} from "../codex-app-server/runtime";
import { SharedUpstreamMux } from "./upstream-mux";
import { createTuiAuthorizer, TUI_DENY_CODES } from "./tui-authorizer";
import { GatewayLedger } from "./ledger";
import { resolveSqliteDriver } from "./sqlite-driver";
import { GatewayScheduler, type DispatchOutcome, type TurnDispatcher } from "./scheduler";
import { asTaskId, asMessageId, type AuthenticatedSender } from "./contract";
import { digestSchemaBundle } from "./version-gate";

const SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_fixture_001",
  role: "member",
  networkId: "net_default",
};

// Minimal WS echo server for mux tests.
async function startEchoServer() {
  const received: object[] = [];
  const connections = new Set<{ send: (s: string) => void }>();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("", { status: 400 });
    },
    websocket: {
      open(ws) {
        const h = { send: (s: string) => ws.send(s) };
        connections.add(h);
        (ws as unknown as { data: { h: typeof h } }).data = { h };
      },
      message(_ws, raw) {
        received.push(JSON.parse(typeof raw === "string" ? raw : String(raw)));
      },
      close(ws) {
        const h = (ws as unknown as { data?: { h?: { send: (s: string) => void } } }).data?.h;
        if (h) connections.delete(h);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    send: (obj: object) => {
      const s = JSON.stringify(obj);
      for (const c of connections) c.send(s);
    },
    stop: () => server.stop(true),
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────
// UpstreamRequestMux
// ────────────────────────────────────────────────────────────────────────

describe("SharedUpstreamMux — single id namespace across origins", () => {
  test("interleaved internal/tui allocations never collide", () => {
    const mux = new SharedUpstreamMux();
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const id = mux.allocate(i % 3 === 0 ? "tui" : "internal");
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(500);
  });

  test("client with injected mux: internal requests + concurrent TUI id, responses route by origin", async () => {
    const srv = await startEchoServer();
    const mux = new SharedUpstreamMux();
    const client = new CodexAppServerClient({ url: srv.url, mux });
    await client.connect();

    const tuiResponses: unknown[] = [];
    const orphans: unknown[] = [];
    client.on("tui_response", (m) => tuiResponses.push(m));
    client.on("orphan_response", (m) => orphans.push(m));

    // A's proxy allocates a TUI id FIRST (would have been id=1 under a
    // private counter — the historical collision case).
    const tuiId = mux.allocate("tui");

    // Internal request races on the same socket.
    const p = client.request<{ ok: boolean }>("thread/resume", { threadId: "t" }, 2_000);
    await tick();
    const internalReq = srv.received.find(
      (m) => (m as { method?: string }).method === "thread/resume",
    ) as { id: number };
    expect(internalReq).toBeDefined();
    expect(internalReq.id).not.toBe(tuiId); // no collision

    // Server answers OUT OF ORDER: tui id first, then internal.
    srv.send({ jsonrpc: "2.0", id: tuiId, result: { forTui: true } });
    srv.send({ jsonrpc: "2.0", id: internalReq.id, result: { ok: true } });

    const internalResp = await p;
    expect(internalResp).toEqual({ ok: true });
    await tick();
    // TUI response routed out, NOT orphaned, NOT resolved internally.
    expect(tuiResponses).toHaveLength(1);
    expect((tuiResponses[0] as { id: number }).id).toBe(tuiId);
    expect(orphans).toHaveLength(0);

    // Unknown id → fail closed as orphan (never resolves anything).
    srv.send({ jsonrpc: "2.0", id: 987654, result: { evil: true } });
    await tick();
    expect(orphans).toHaveLength(1);

    await client.close();
    srv.stop();
  });
});

// ────────────────────────────────────────────────────────────────────────
// TUI authorizer (Phase-1 frozen policy)
// ────────────────────────────────────────────────────────────────────────

describe("TUI authorizer — Phase-1 拍板 rules", () => {
  const BOUND = "thread-1";
  function authWith(reservation: "none" | "human" | "agent") {
    return createTuiAuthorizer({
      boundThreadId: () => BOUND,
      reservation: () => reservation,
    });
  }

  test("reservation=none/human: turn/start + turn/steer allowed", () => {
    for (const r of ["none", "human"] as const) {
      const auth = authWith(r);
      expect(auth.authorize({ method: "turn/start", params: { threadId: BOUND } }).verdict).toBe("allow");
      expect(auth.authorize({ method: "turn/steer", params: { threadId: BOUND } }).verdict).toBe("allow");
    }
  });

  test("reservation=agent: turn/start + turn/steer denied with stable busy code", () => {
    const auth = authWith("agent");
    for (const method of ["turn/start", "turn/steer"]) {
      const d = auth.authorize({ method, params: { threadId: BOUND } });
      expect(d.verdict).toBe("deny");
      if (d.verdict === "deny") {
        expect(d.code).toBe(TUI_DENY_CODES.busyAgent);
        expect(d.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("reservation=agent: turn/interrupt is the emergency exception (allowed)", () => {
    const d = authWith("agent").authorize({
      method: "turn/interrupt",
      params: { threadId: BOUND },
    });
    expect(d.verdict).toBe("allow");
  });

  test("config/auth/account/model/sandbox mutations denied regardless of reservation", () => {
    for (const r of ["none", "human", "agent"] as const) {
      const auth = authWith(r);
      for (const method of ["config/set", "auth/login", "account/switch", "model/override", "sandbox/set", "execpolicy/amend"]) {
        const d = auth.authorize({ method, params: {} });
        expect(d.verdict).toBe("deny");
        if (d.verdict === "deny") expect(d.code).toBe(TUI_DENY_CODES.configLocked);
      }
    }
  });

  test("requests naming an unbound thread denied", () => {
    const d = authWith("none").authorize({
      method: "turn/start",
      params: { threadId: "someone-elses-thread" },
    });
    expect(d.verdict).toBe("deny");
    if (d.verdict === "deny") expect(d.code).toBe(TUI_DENY_CODES.threadNotBound);
  });

  test("conversational reads allowed (fuzzy search etc.)", () => {
    const d = authWith("agent").authorize({ method: "fuzzyFileSearch", params: {} });
    expect(d.verdict).toBe("allow");
  });
});

// ────────────────────────────────────────────────────────────────────────
// interrupted_by_human
// ────────────────────────────────────────────────────────────────────────

describe("interrupted_by_human — structured terminal, no replay", () => {
  function fixedDispatcher(outcome: DispatchOutcome): TurnDispatcher {
    return { startTurn: async () => outcome };
  }

  test("interrupt on the active agent task → terminal state, reservation freed, next task runs", async () => {
    const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
    const scheduler = new GatewayScheduler({
      ledger,
      dispatcher: fixedDispatcher({ kind: "accepted", turnId: "turn_1" }),
    });
    await scheduler.enqueueTask({
      taskId: asTaskId("t1"),
      messageId: asMessageId("m1"),
      authenticatedSender: SENDER,
      text: "long running",
    });
    await tick();
    expect(scheduler.snapshot().activeReservationOwner).toBe("agent");

    scheduler.onAgentTurnInterrupted("t1");
    const row = ledger.get("t1")!;
    expect(row.state).toBe("interrupted_by_human");
    expect(scheduler.snapshot().activeReservationOwner).toBe("none");

    // Contract mapping: cancelled by owner.
    const ts = await scheduler.getTaskState(asTaskId("t1"));
    expect(ts.state).toBe("cancelled");
    if (ts.state === "cancelled") expect(ts.cancelledBy).toBe("owner");

    // Terminal: any further transition throws.
    expect(() => ledger.transition("t1", "queued")).toThrow(/illegal transition/);
  });

  test("restart does NOT replay an interrupted task (recover ignores terminal rows)", () => {
    const driver = resolveSqliteDriver(":memory:").driver;
    const led1 = new GatewayLedger(driver);
    led1.record({ submissionId: "t1", origin: "agent", clientUserMessageId: "anet:m1" });
    led1.transition("t1", "queued");
    led1.transition("t1", "dispatching", { bumpDispatchAttempts: true });
    led1.transition("t1", "accepted", { turnId: "turn_1" });
    led1.transition("t1", "interrupted_by_human");

    // "Restart": a fresh ledger over the same db.
    const led2 = new GatewayLedger(driver);
    const report = led2.recover(new Map([["anet:m1", "turn_1"]]));
    expect(report.requeued).toHaveLength(0);
    expect(report.reconciled).toHaveLength(0);
    expect(report.ambiguous).toHaveLength(0);
    expect(led2.get("t1")!.state).toBe("interrupted_by_human");
    expect(led2.get("t1")!.dispatchAttempts).toBe(1); // never resent
  });
});

// ────────────────────────────────────────────────────────────────────────
// Token isolation (dispatch item 5)
// ────────────────────────────────────────────────────────────────────────

describe("token isolation — codex process must never see ntok material", () => {
  test("scrubSpawnEnv removes token-named keys and ntok-valued keys", () => {
    const dirty: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANET_CODEX_COMMHUB_TOKEN: "ntok_deadbeef01",
      COMMHUB_TOKEN: "ntok_deadbeef02",
      NTOK: "ntok_deadbeef03",
      MY_ANET_TOKEN: "whatever",
      INNOCENT_LOOKING: "prefix ntok_cafe0001 suffix", // value smuggling
      NORMAL_VAR: "keep me",
    };
    const clean = scrubSpawnEnv(dirty);
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.NORMAL_VAR).toBe("keep me");
    expect(clean.ANET_CODEX_COMMHUB_TOKEN).toBeUndefined();
    expect(clean.COMMHUB_TOKEN).toBeUndefined();
    expect(clean.NTOK).toBeUndefined();
    expect(clean.MY_ANET_TOKEN).toBeUndefined();
    expect(clean.INNOCENT_LOOKING).toBeUndefined();
    // Nothing in the final env contains an ntok literal.
    for (const v of Object.values(clean)) {
      expect(String(v)).not.toMatch(/ntok_[0-9a-zA-Z]/);
    }
  });

  test("owned app-server argv has NO CommHub MCP wiring and NO token flags", () => {
    const args = buildOwnedAppServerArgs("ws://127.0.0.1:4500", {
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    const joined = args.join(" ");
    expect(joined).not.toContain("mcp_servers.commhub");
    expect(joined).not.toContain("bearer_token");
    expect(joined).not.toMatch(/ntok_/);
    expect(joined).toContain("approval_policy=never");
    expect(joined).toContain("sandbox_mode=read-only");
  });

  test("SENSITIVE_ENV_PATTERN catches the historical injection var", () => {
    expect(SENSITIVE_ENV_PATTERN.test("ANET_CODEX_COMMHUB_TOKEN")).toBe(true);
    expect(SENSITIVE_ENV_PATTERN.test("COMMHUB_MCP_TOKEN")).toBe(true);
    expect(SENSITIVE_ENV_PATTERN.test("NTOK")).toBe(true);
    expect(SENSITIVE_ENV_PATTERN.test("PATH")).toBe(false);
    expect(SENSITIVE_ENV_PATTERN.test("HOME")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Version/schema gate (against the REAL pinned binary)
// ────────────────────────────────────────────────────────────────────────

describe("version gate — fail closed on baseline mismatch", () => {
  test("real codex 0.144.0 on this machine passes both gates", async () => {
    const { assertCodexBaseline } = await import("./version-gate");
    const { PINNED_SCHEMA_SHA256 } = await import("./pinned");
    const verified = await assertCodexBaseline("codex", { timeoutMs: 60_000 });
    expect(verified.version).toBe("codex-cli 0.144.0");
    expect(verified.schemaSha256).toBe(PINNED_SCHEMA_SHA256);
  }, 90_000);

  test("a wrong binary fails closed with the baseline-mismatch code", async () => {
    const { assertCodexBaseline, BASELINE_MISMATCH_CODE } = await import("./version-gate");
    let caught: (Error & { code?: string }) | null = null;
    try {
      // `echo` exists everywhere and will report the wrong version line.
      await assertCodexBaseline("echo");
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe(BASELINE_MISMATCH_CODE);
    expect(caught!.message).toContain("refusing to boot");
  });

  test("digestSchemaBundle is stable across repeated generation", async () => {
    const { execFile } = await import("child_process");
    const { mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const gen = (out: string) =>
      new Promise<void>((res, rej) =>
        execFile("codex", ["app-server", "generate-json-schema", "--out", out], (e) =>
          e ? rej(e) : res(),
        ),
      );
    const d1 = mkdtempSync(join(tmpdir(), "sg1-"));
    const d2 = mkdtempSync(join(tmpdir(), "sg2-"));
    try {
      await gen(d1);
      await gen(d2);
      expect(digestSchemaBundle(d1)).toBe(digestSchemaBundle(d2));
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────
// Checkpoint-3 delta 4 — TUI disconnect drains only TUI ids
// ────────────────────────────────────────────────────────────────────────

describe("mux drain semantics — TUI disconnect vs upstream restart", () => {
  test("drainProxiedTui releases tui ids only; internal pending stays routable", async () => {
    const srv = await startEchoServer();
    const mux = new SharedUpstreamMux();
    const client = new CodexAppServerClient({ url: srv.url, mux });
    await client.connect();

    const tuiA = mux.allocate("tui");
    const tuiB = mux.allocate("tui");
    const p = client.request<{ ok: boolean }>("thread/resume", { threadId: "t" }, 2_000);
    await tick();
    const internalReq = srv.received.find(
      (m) => (m as { method?: string }).method === "thread/resume",
    ) as { id: number };

    // Human closes the TUI mid-flight.
    const released = mux.drainProxiedTui();
    expect(released.sort()).toEqual([tuiA, tuiB].sort());
    expect(mux.ownerOf(internalReq.id)).toBe("internal"); // untouched

    // The in-flight agent request STILL resolves after the TUI is gone.
    srv.send({ jsonrpc: "2.0", id: internalReq.id, result: { ok: true } });
    expect(await p).toEqual({ ok: true });

    // drainAll (upstream restart) clears everything.
    mux.allocate("internal");
    mux.allocate("tui");
    expect(mux.outstanding()).toBeGreaterThan(0);
    mux.drainAll();
    expect(mux.outstanding()).toBe(0);

    await client.close();
    srv.stop();
  });
});
