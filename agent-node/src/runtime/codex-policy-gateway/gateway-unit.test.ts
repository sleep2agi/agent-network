// RFC-030 Wave 1B — unit tests: sqlite driver gate, ledger state machine,
// policy allow/deny table.

import { describe, expect, test } from "bun:test";
import {
  parseNodeVersion,
  nodeSqliteSupported,
  resolveSqliteDriver,
  SQLITE_RUNTIME_UNSUPPORTED_CODE,
} from "./sqlite-driver";
import { GatewayLedger, TERMINAL_STATES } from "./ledger";
import { evaluateUpstreamCall, assertPhase1Profile, PHASE1_PROFILE } from "./policy";

// ────────────────────────────────────────────────────────────────────────
// sqlite-driver
// ────────────────────────────────────────────────────────────────────────

describe("sqlite-driver — runtime gate (A′ decision)", () => {
  test("version parse handles v-prefix and junk", () => {
    expect(parseNodeVersion("22.13.1")).toEqual([22, 13, 1]);
    expect(parseNodeVersion("v20.20.0")).toEqual([20, 20, 0]);
    expect(parseNodeVersion("garbage")).toEqual([0, 0, 0]);
  });

  test("node:sqlite support boundary is exactly 22.13", () => {
    expect(nodeSqliteSupported("22.12.9")).toBe(false);
    expect(nodeSqliteSupported("22.13.0")).toBe(true);
    expect(nodeSqliteSupported("23.0.0")).toBe(true);
    expect(nodeSqliteSupported("20.20.0")).toBe(false);
    expect(nodeSqliteSupported("18.17.0")).toBe(false);
  });

  test("under Bun, resolveSqliteDriver picks bun:sqlite", () => {
    const { driver, flavor } = resolveSqliteDriver(":memory:");
    expect(flavor).toBe("bun");
    driver.exec("CREATE TABLE t (a)");
    driver.prepare("INSERT INTO t VALUES (?)").run(1);
    const row = driver.prepare("SELECT a FROM t").get() as { a: number };
    expect(row.a).toBe(1);
    driver.close();
  });

  test("fail-closed error carries the stable Wave-2 error code", () => {
    // We can't un-Bun this process, but the code constant must be stable
    // and the error path is exercised in the Node-20 subprocess check
    // (see rfc-030 checkpoint script). Pin the constant here.
    expect(SQLITE_RUNTIME_UNSUPPORTED_CODE).toBe("codex_gateway_sqlite_runtime_unsupported");
  });
});

// ────────────────────────────────────────────────────────────────────────
// ledger
// ────────────────────────────────────────────────────────────────────────

function memLedger(): GatewayLedger {
  return new GatewayLedger(resolveSqliteDriver(":memory:").driver);
}

describe("GatewayLedger — state machine", () => {
  test("happy path walks received→queued→dispatching→accepted→completed→reply_pending→replied", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent", taskId: "t1", clientUserMessageId: "anet:m1" });
    expect(led.get("s1")!.state).toBe("received");
    led.transition("s1", "queued");
    led.transition("s1", "dispatching", { bumpDispatchAttempts: true });
    led.transition("s1", "accepted", { turnId: "turn_9" });
    expect(led.get("s1")!.turnId).toBe("turn_9");
    led.transition("s1", "completed", { replyText: "done" });
    led.transition("s1", "reply_pending");
    led.transition("s1", "replied");
    expect(led.get("s1")!.state).toBe("replied");
    expect(led.get("s1")!.dispatchAttempts).toBe(1);
  });

  test("illegal transitions throw (queued→accepted skips dispatching)", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent" });
    led.transition("s1", "queued");
    expect(() => led.transition("s1", "accepted", { turnId: "x" })).toThrow(/illegal transition/);
  });

  test("terminal states accept nothing further", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent" });
    led.transition("s1", "failed", { error: "nope" });
    for (const next of ["queued", "dispatching", "replied"] as const) {
      expect(() => led.transition("s1", next)).toThrow(/illegal transition/);
    }
    expect(TERMINAL_STATES.has("failed")).toBe(true);
    expect(TERMINAL_STATES.has("ambiguous")).toBe(true);
    expect(TERMINAL_STATES.has("replied")).toBe(true);
  });

  test("duplicate submissionId insert throws", () => {
    const led = memLedger();
    led.record({ submissionId: "dup", origin: "agent" });
    expect(() => led.record({ submissionId: "dup", origin: "agent" })).toThrow();
  });

  test("recover(): dispatching row WITH matching observed turn → accepted (reconciled)", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent", clientUserMessageId: "anet:m1" });
    led.transition("s1", "queued");
    led.transition("s1", "dispatching", { bumpDispatchAttempts: true });
    const report = led.recover(new Map([["anet:m1", "turn_42"]]));
    expect(report.reconciled).toHaveLength(1);
    expect(report.ambiguous).toHaveLength(0);
    const row = led.get("s1")!;
    expect(row.state).toBe("accepted");
    expect(row.turnId).toBe("turn_42");
  });

  test("recover(): dispatching row WITHOUT matching turn → ambiguous, dispatchAttempts unchanged (no resend)", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent", clientUserMessageId: "anet:m1" });
    led.transition("s1", "queued");
    led.transition("s1", "dispatching", { bumpDispatchAttempts: true });
    const report = led.recover(new Map());
    expect(report.ambiguous).toHaveLength(1);
    const row = led.get("s1")!;
    expect(row.state).toBe("ambiguous");
    expect(row.dispatchAttempts).toBe(1); // NOT bumped again — nothing was resent
    expect(row.error).toContain("not resending");
  });

  test("recover(): queued rows are reported requeued and left dispatchable", () => {
    const led = memLedger();
    led.record({ submissionId: "s1", origin: "agent" });
    led.transition("s1", "queued");
    const report = led.recover(new Map());
    expect(report.requeued).toHaveLength(1);
    expect(led.get("s1")!.state).toBe("queued");
    // Still legal to dispatch after recovery.
    led.transition("s1", "dispatching", { bumpDispatchAttempts: true });
  });
});

// ────────────────────────────────────────────────────────────────────────
// policy
// ────────────────────────────────────────────────────────────────────────

describe("gateway policy — deny-by-default upstream allowlist", () => {
  const BOUND = "thread-bound-1";

  test("turn/start on the bound thread is allowed", () => {
    const d = evaluateUpstreamCall("turn/start", { threadId: BOUND }, BOUND);
    expect(d.allowed).toBe(true);
  });

  test("turn/start on a DIFFERENT thread is denied (thread_not_bound)", () => {
    const d = evaluateUpstreamCall("turn/start", { threadId: "other" }, BOUND);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("thread_not_bound");
  });

  test.each([
    ["turn/steer"],
    ["thread/list"],
    ["thread/archive"],
    ["some/random/method"],
    ["rawJsonRpcPassthrough"],
  ])("non-allowlisted method %s denied", (method) => {
    const d = evaluateUpstreamCall(method, {}, BOUND);
    expect(d.allowed).toBe(false);
  });

  test.each([
    ["item/tool/requestApproval/respond", "approval_response_attempt"],
    ["serverRequest/respond", "approval_response_attempt"],
    ["item/tool/requestUserInput", "approval_response_attempt"],
    ["shellCommand/execute", "method_not_allowlisted"],
    ["fs/readFile", "method_not_allowlisted"],
    ["fs/writeFile", "method_not_allowlisted"],
    ["applyPatch", "method_not_allowlisted"],
    ["config/set", "config_override_attempt"],
    ["auth/login", "config_override_attempt"],
    ["account/switch", "config_override_attempt"],
    ["model/override", "config_override_attempt"],
    ["sandbox/set", "config_override_attempt"],
    ["execpolicy/amend", "config_override_attempt"],
  ] as const)("dangerous method %s denied with code %s", (method, code) => {
    const d = evaluateUpstreamCall(method, {}, BOUND);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe(code);
  });

  test("deny rules outrank the allowlist (defense in depth)", () => {
    // Even if someone added an approval-looking method to the allowlist by
    // mistake, the deny rules run first. Simulate by testing a method the
    // deny regex catches regardless of allowlist membership.
    const d = evaluateUpstreamCall("initialize/approvalHack", {}, BOUND);
    expect(d.allowed).toBe(false);
  });

  test("thread/start (fresh binding) allowed without bound-thread match", () => {
    const d = evaluateUpstreamCall("thread/start", {}, null);
    expect(d.allowed).toBe(true);
  });
});

describe("gateway policy — Phase-1 fixed profile", () => {
  test("read-only/never passes", () => {
    expect(() => assertPhase1Profile(PHASE1_PROFILE)).not.toThrow();
  });
  test.each([
    [{ sandboxMode: "workspace-write", approvalPolicy: "never" }],
    [{ sandboxMode: "danger-full-access", approvalPolicy: "never" }],
    [{ sandboxMode: "read-only", approvalPolicy: "on-request" }],
    [{ sandboxMode: "read-only", approvalPolicy: "untrusted" }],
  ])("any deviation fails closed: %o", (profile) => {
    expect(() => assertPhase1Profile(profile as never)).toThrow(/refusing to boot/);
  });
});
