// RFC-030 Wave 1B — unit tests: sqlite driver gate, ledger state machine,
// policy allow/deny table.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseNodeVersion,
  nodeSqliteSupported,
  resolveSqliteDriver,
  selectSqliteFlavor,
  PINNED_BETTER_SQLITE3_VERSION,
  SQLITE_RUNTIME_UNSUPPORTED_CODE,
  type SqliteFlavor,
} from "./sqlite-driver";
import {
  GatewayLedger,
  TERMINAL_STATES,
  MAX_HUB_REPLY_TEXT_LENGTH,
  TRUNCATED_REPLY_MARKER,
  completedDelivery,
} from "./ledger";
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

  test("flavor precedence is Bun, unflagged node:sqlite, then synchronous fallback", () => {
    const cases: ReadonlyArray<{
      bunPresent: boolean;
      nodeVersion: string;
      expected: SqliteFlavor;
    }> = [
      // Bun also reports a Node version: its native driver must still win.
      { bunPresent: true, nodeVersion: "22.13.0", expected: "bun" },
      { bunPresent: true, nodeVersion: "20.20.0", expected: "bun" },
      // Unflagged built-in remains the preferred Node implementation.
      { bunPresent: false, nodeVersion: "22.13.0", expected: "node" },
      { bunPresent: false, nodeVersion: "23.0.0", expected: "node" },
      // No experimental node:sqlite: use the pinned synchronous addon.
      { bunPresent: false, nodeVersion: "22.12.9", expected: "better-sqlite3" },
      { bunPresent: false, nodeVersion: "20.20.0", expected: "better-sqlite3" },
    ];

    for (const { expected, ...runtime } of cases) {
      expect(selectSqliteFlavor(runtime)).toBe(expected);
    }
  });

  test("Node-20 fallback package is exact-pinned, optional, and external to native bundles", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(PINNED_BETTER_SQLITE3_VERSION).toBe("12.9.0");
    expect(pkg.optionalDependencies?.["better-sqlite3"]).toBe(PINNED_BETTER_SQLITE3_VERSION);
    expect(pkg.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(pkg.scripts?.build).toContain("--external better-sqlite3");
    expect(pkg.scripts?.["build:rfc030-integration"]).toContain("--external better-sqlite3");
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
    expect(row.error).toBe(
      "Gateway could not confirm whether this task started; it was not replayed.",
    );
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

  test("recover(): accepted becomes ambiguous/no-resend and completed resumes reply_pending", () => {
    const led = memLedger();
    led.record({ submissionId: "accepted", origin: "agent" });
    led.transition("accepted", "queued");
    led.transition("accepted", "dispatching", { bumpDispatchAttempts: true });
    led.transition("accepted", "accepted", { turnId: "turn-before-crash" });
    led.record({ submissionId: "completed", origin: "agent" });
    led.transition("completed", "queued");
    led.transition("completed", "dispatching", { bumpDispatchAttempts: true });
    led.transition("completed", "accepted", { turnId: "turn-done" });
    led.transition("completed", "completed", { replyText: "durable answer" });

    const report = led.recover(new Map());
    expect(report.ambiguous.map((row) => row.submissionId)).toContain("accepted");
    expect(led.get("accepted")!.state).toBe("ambiguous");
    expect(led.get("accepted")!.dispatchAttempts).toBe(1);
    expect(report.replyPending.map((row) => row.submissionId)).toEqual(["completed"]);
    expect(led.get("completed")!.state).toBe("reply_pending");
    expect(led.get("completed")!.replyText).toBe("durable answer");
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

// ────────────────────────────────────────────────────────────────────────
// L3-R3/R4 — (taskId,messageId) attempt semantics + cancelled roundtrip +
// queuePosition immediate-start (freeze 90d1e58 + 副指挥 P1)
// ────────────────────────────────────────────────────────────────────────

import { GatewayScheduler, type DispatchOutcome, type TurnDispatcher } from "./scheduler";
import { asTaskId, asMessageId, type AuthenticatedSender } from "./contract";
import {
  injectOrdinaryInboxRow,
  type OrdinaryQuarantineRequest,
} from "./inbox-pump";
import { senderFromInboxRow } from "./bridge-adapter";

const R3_SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_r3_001",
  role: "member",
  networkId: "net_default",
};

function r3Scheduler(dispatch: () => Promise<DispatchOutcome>) {
  const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
  const dispatcher: TurnDispatcher = { startTurn: () => dispatch() };
  const scheduler = new GatewayScheduler({
    ledger,
    dispatcher,
    ownerAttached: () => true,
  });
  return { ledger, scheduler };
}

const enq = (
  s: GatewayScheduler,
  taskId: string,
  messageId: string,
  text = "work",
) =>
  s.enqueueTask({
    taskId: asTaskId(taskId),
    messageId: asMessageId(messageId),
    authenticatedSender: R3_SENDER,
    text,
  });

describe("R3 — (taskId,messageId) pair semantics", () => {
  test("same (taskId,messageId) resubmitted → duplicate, dispatched exactly once", async () => {
    let dispatched = 0;
    const { scheduler } = r3Scheduler(async () => {
      dispatched++;
      return { kind: "accepted", turnId: `turn_${dispatched}` };
    });
    const r1 = await enq(scheduler, "lt1", "lt1"); // initial: messageId == taskId
    const r2 = await enq(scheduler, "lt1", "lt1");
    expect(r1.outcome).toBe("accepted");
    if (r1.outcome === "accepted") expect(r1.duplicate).toBe(false);
    expect(r2.outcome).toBe("accepted");
    if (r2.outcome === "accepted") expect(r2.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toBe(1);
  });

  test("same taskId + NEW messageId while the attempt is LIVE → duplicate, never double-runs", async () => {
    let dispatched = 0;
    const { scheduler } = r3Scheduler(async () => {
      dispatched++;
      return { kind: "accepted", turnId: `turn_${dispatched}` };
    });
    await enq(scheduler, "lt2", "m_first");
    await new Promise((r) => setTimeout(r, 20));
    const retryWhileLive = await enq(scheduler, "lt2", "m_second");
    expect(retryWhileLive.outcome).toBe("accepted");
    if (retryWhileLive.outcome === "accepted") expect(retryWhileLive.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toBe(1); // still exactly one live run
  });

  test("same taskId + NEW messageId retries only after the prior terminal outbox is delivered", async () => {
    let call = 0;
    const { scheduler, ledger } = r3Scheduler(async () => {
      call++;
      return call === 1
        ? { kind: "failed", error: "first attempt exploded" }
        : { kind: "accepted", turnId: "turn_retry" };
    });
    await enq(scheduler, "lt3", "m_a1");
    await new Promise((r) => setTimeout(r, 20));
    expect((await scheduler.getTaskState(asTaskId("lt3"))).state).toBe("failed");

    const heldForDelivery = await enq(scheduler, "lt3", "m_a2");
    expect(heldForDelivery.outcome).toBe("accepted");
    if (heldForDelivery.outcome === "accepted") expect(heldForDelivery.duplicate).toBe(true);
    expect(ledger.get("m_a2")).toBeNull();

    scheduler.markReplied("m_a1");
    const retry = await enq(scheduler, "lt3", "m_a2");
    expect(retry.outcome).toBe("accepted");
    if (retry.outcome === "accepted") expect(retry.duplicate).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    // Latest-attempt view: the logical task is now running.
    expect((await scheduler.getTaskState(asTaskId("lt3"))).state).toBe("running");
    // Both attempt rows exist; the first stays terminal-failed (audit).
    expect(ledger.get("m_a1")!.state).toBe("failed");
    expect(ledger.get("m_a2")!.state).toBe("accepted");
  });
});

describe("R4 — cancelled roundtrip + queuePosition immediate-start", () => {
  test("cancelQueuedTask → outcome cancelled AND getTaskState reads back cancelled/by agent", async () => {
    // Park the reservation under a human turn so the entry stays queued.
    const { scheduler } = r3Scheduler(async () => ({ kind: "accepted", turnId: "t" }));
    scheduler.onHumanTurnStarted("h1");
    await enq(scheduler, "lt4", "m_c1");
    const c = await scheduler.cancelQueuedTask(asTaskId("lt4"));
    expect(c.outcome).toBe("cancelled");
    const ts = await scheduler.getTaskState(asTaskId("lt4"));
    expect(ts.state).toBe("cancelled");
    if (ts.state === "cancelled") expect(ts.cancelledBy).toBe("agent");
  });

  test("idle enqueue starts immediately → queuePosition null (副指挥 P1 race fixed)", async () => {
    const { scheduler } = r3Scheduler(async () => ({ kind: "accepted", turnId: "t" }));
    const r = await enq(scheduler, "lt5", "m_q1");
    expect(r.outcome).toBe("accepted");
    if (r.outcome === "accepted") expect(r.queuePosition).toBeNull();
  });

  test("enqueue behind a live reservation → real queue position", async () => {
    const { scheduler } = r3Scheduler(async () => ({ kind: "accepted", turnId: "t" }));
    scheduler.onHumanTurnStarted("h1");
    const r1 = await enq(scheduler, "lt6", "m_q2");
    const r2 = await enq(scheduler, "lt7", "m_q3");
    if (r1.outcome === "accepted") expect(r1.queuePosition).toBe(0);
    if (r2.outcome === "accepted") expect(r2.queuePosition).toBe(1);
  });
});

describe("Stage2 durable scheduler recovery", () => {
  test("a queued row restores its durable payload and dispatches only after owner reattaches", async () => {
    const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
    ledger.record({
      submissionId: "recovered-message",
      origin: "agent",
      taskId: "recovered-task",
      fromAlias: "display-only",
      requestText: "durable work",
      clientUserMessageId: "anet:recovered-message",
    });
    ledger.transition("recovered-message", "queued");
    const recovery = ledger.recover(new Map());
    let owner = false;
    const dispatched: unknown[] = [];
    const scheduler = new GatewayScheduler({
      ledger,
      ownerAttached: () => owner,
      dispatcher: {
        async startTurn(input) {
          dispatched.push(input);
          return { kind: "accepted", turnId: "turn-recovered" };
        },
      },
    });
    scheduler.restoreRecoveredQueue(recovery.requeued);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dispatched).toHaveLength(0);
    owner = true;
    scheduler.onOwnerAttachmentChanged();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dispatched).toEqual([
      {
        submissionId: "recovered-message",
        taskId: "recovered-task",
        fromAlias: "display-only",
        text: "durable work",
        clientUserMessageId: "anet:recovered-message",
        sourceType: "task",
        sourceId: "recovered-task",
      },
    ]);
    expect(ledger.get("recovered-message")!.state).toBe("accepted");
    expect(ledger.get("recovered-message")!.dispatchAttempts).toBe(1);
  });

  test("legacy queued row without payload fails closed instead of fake-live", () => {
    const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
    ledger.record({ submissionId: "legacy-row", origin: "agent", taskId: "legacy-task" });
    ledger.transition("legacy-row", "queued");
    const scheduler = new GatewayScheduler({
      ledger,
      ownerAttached: () => true,
      dispatcher: { async startTurn() { throw new Error("must not dispatch"); } },
    });
    scheduler.restoreRecoveredQueue(ledger.recover(new Map()).requeued);
    expect(ledger.get("legacy-row")!.state).toBe("failed");
  });
});

// ───────────────────────────────────────────────────────────────────────
// Stage2 mixed ingress + durable terminal-outcome outbox
// ──────────────────────────────────────────────────────────────────────

const settleScheduler = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("Stage2 ordinary inbox scheduling", () => {
  test("prototype-property sender roles fail closed", () => {
    for (const role of ["constructor", "toString", "__proto__"]) {
      expect(senderFromInboxRow({
        id: `role-${role}`,
        from_session: "display-only",
        network_id: "net_default",
        sender_token_id: "server-stamped-token",
        sender_role: role,
      })).toBeNull();
    }
  });

  test("ordinary rows share the task FIFO and finish locally without an outbound reply", async () => {
    const ledger = memLedger();
    const dispatched: Array<Parameters<TurnDispatcher["startTurn"]>[0]> = [];
    const scheduler = new GatewayScheduler({
      ledger,
      ownerAttached: () => true,
      dispatcher: {
        async startTurn(input) {
          dispatched.push(input);
          return { kind: "accepted", turnId: `turn-${input.submissionId}` };
        },
      },
    });

    await enq(scheduler, "fifo-task-1", "fifo-message-1", "formal one");
    await settleScheduler();
    const ordinary = await scheduler.injectMessage({
      messageId: "fifo-ordinary-1",
      authenticatedSender: R3_SENDER,
      type: "reply",
      text: "ordinary middle",
    });
    await enq(scheduler, "fifo-task-2", "fifo-message-2", "formal two");

    expect(ordinary.outcome).toBe("accepted");
    expect(dispatched.map((input) => input.submissionId)).toEqual(["fifo-message-1"]);

    scheduler.onAgentTurnFinished("fifo-message-1", { ok: true, replyText: "one done" });
    await settleScheduler();
    expect(dispatched.map((input) => input.submissionId)).toEqual([
      "fifo-message-1",
      "fifo-ordinary-1",
    ]);
    expect(dispatched[1]).toMatchObject({
      sourceType: "reply",
      sourceId: "fifo-ordinary-1",
      text: "ordinary middle",
    });

    scheduler.onAgentTurnFinished("fifo-ordinary-1", { ok: true, replyText: "locally consumed" });
    await settleScheduler();
    expect(dispatched.map((input) => input.submissionId)).toEqual([
      "fifo-message-1",
      "fifo-ordinary-1",
      "fifo-message-2",
    ]);

    const ordinaryRow = ledger.get("fifo-ordinary-1")!;
    expect(ordinaryRow.state).toBe("replied");
    expect(ordinaryRow.expectsReply).toBe(false);
    expect(ordinaryRow.outboundDelivery).toBe("none");
    expect(ordinaryRow.deliveryStatus).toBeNull();
    expect(ledger.outboundPending().map((row) => row.submissionId)).not.toContain(
      "fifo-ordinary-1",
    );
  });

  test("ordinary invalid/unsupported quarantine never forwards a row-supplied canonical task id", async () => {
    const quarantined: OrdinaryQuarantineRequest[] = [];
    let acked = 0;
    let injected = 0;
    const disposition = await injectOrdinaryInboxRow(
      {
        id: "ordinary-reply-invalid",
        type: "reply",
        content: "untrusted reply",
        from_session: "display-only",
        network_id: "net_default",
        sender_token_id: "server-stamped-token",
        sender_role: "member",
        canonical_task_id: "canonical-task-must-not-be-touched",
      },
      {
        async injectMessage() {
          injected += 1;
          return {
            outcome: "refused_invalid_arg",
            field: "text",
            reason: "invalid ordinary payload",
          };
        },
      },
      {
        ack() {
          acked += 1;
        },
        quarantine(request) {
          quarantined.push(request);
          return { outcome: "quarantined" };
        },
      },
    );

    expect(disposition).toEqual({
      outcome: "quarantined",
      result: { outcome: "quarantined" },
    });
    expect(acked).toBe(0);
    expect(injected).toBe(1);
    expect(quarantined).toEqual([
      {
        messageId: "ordinary-reply-invalid",
        reason: "refused_invalid_arg",
      },
    ]);
    expect(Object.hasOwn(quarantined[0]!, "canonicalTaskId")).toBe(false);

    const unsupported = await injectOrdinaryInboxRow(
      {
        id: "ordinary-unsupported",
        type: "status_update",
        content: "must not become a turn",
        from_session: "display-only",
        network_id: "net_default",
        sender_token_id: "server-stamped-token",
        sender_role: "member",
        canonical_task_id: "another-canonical-task-must-not-be-touched",
      },
      {
        async injectMessage() {
          throw new Error("unsupported type must be quarantined before scheduler injection");
        },
      },
      {
        ack() {
          acked += 1;
        },
        quarantine(request) {
          quarantined.push(request);
          return { outcome: "quarantined" };
        },
      },
    );
    expect(unsupported.outcome).toBe("quarantined");
    expect(acked).toBe(0);
    expect(quarantined[1]).toEqual({
      messageId: "ordinary-unsupported",
      reason: "refused_invalid_arg",
    });
    expect(Object.hasOwn(quarantined[1]!, "canonicalTaskId")).toBe(false);
  });
});

describe("Stage2 terminal outcome outbox", () => {
  test("success is durable reply_pending until delivery is acknowledged", async () => {
    const { ledger, scheduler } = r3Scheduler(async () => ({
      kind: "accepted",
      turnId: "turn-success",
    }));
    await enq(scheduler, "out-success-task", "out-success");
    await settleScheduler();
    scheduler.onAgentTurnFinished("out-success", { ok: true, replyText: "answer" });

    const pending = ledger.get("out-success")!;
    expect(pending).toMatchObject({
      state: "reply_pending",
      outboundDelivery: "pending",
      deliveryStatus: "replied",
      deliveryCode: "completed",
      deliveryText: "answer",
    });
    expect(pending.terminalAt).not.toBeNull();
    expect(ledger.outboundPending().map((row) => row.submissionId)).toEqual(["out-success"]);

    scheduler.markReplied("out-success");
    expect(ledger.get("out-success")).toMatchObject({
      state: "replied",
      outboundDelivery: "delivered",
    });
  });

  test("dispatch failure and turn failure persist stable failed outcomes", async () => {
    const dispatchFailure = r3Scheduler(async () => ({
      kind: "failed",
      error: "raw upstream dispatch secret",
    }));
    await enq(dispatchFailure.scheduler, "out-dispatch-task", "out-dispatch-failed");
    await settleScheduler();
    const dispatchRow = dispatchFailure.ledger.get("out-dispatch-failed")!;
    expect(dispatchRow).toMatchObject({
      state: "failed",
      outboundDelivery: "pending",
      deliveryStatus: "failed",
      deliveryCode: "dispatch_failed",
      deliveryText: "Gateway could not start this task.",
    });
    expect(JSON.stringify(dispatchRow)).not.toContain("raw upstream dispatch secret");

    const turnFailure = r3Scheduler(async () => ({
      kind: "accepted",
      turnId: "turn-failure",
    }));
    await enq(turnFailure.scheduler, "out-turn-task", "out-turn-failed");
    await settleScheduler();
    turnFailure.scheduler.onAgentTurnFinished("out-turn-failed", {
      ok: false,
      error: "raw upstream turn secret",
    });
    const turnRow = turnFailure.ledger.get("out-turn-failed")!;
    expect(turnRow).toMatchObject({
      state: "failed",
      outboundDelivery: "pending",
      deliveryStatus: "failed",
      deliveryCode: "turn_failed",
      deliveryText: "Gateway could not complete this task.",
    });
    expect(JSON.stringify(turnRow)).not.toContain("raw upstream turn secret");
  });

  test("ambiguous dispatch persists a no-replay failed outcome", async () => {
    const { ledger, scheduler } = r3Scheduler(async () => ({
      kind: "ambiguous",
      detail: "raw uncertain upstream detail",
    }));
    await enq(scheduler, "out-ambiguous-task", "out-ambiguous");
    await settleScheduler();

    const row = ledger.get("out-ambiguous")!;
    expect(row).toMatchObject({
      state: "ambiguous",
      outboundDelivery: "pending",
      deliveryStatus: "failed",
      deliveryCode: "dispatch_outcome_unknown",
      deliveryText: "Gateway could not confirm whether this task started; it was not replayed.",
    });
    expect(JSON.stringify(row)).not.toContain("raw uncertain upstream detail");
  });

  test("owner interrupt persists a cancelled outcome", async () => {
    const { ledger, scheduler } = r3Scheduler(async () => ({
      kind: "accepted",
      turnId: "turn-interrupted",
    }));
    await enq(scheduler, "out-interrupted-task", "out-interrupted");
    await settleScheduler();
    scheduler.onAgentTurnInterrupted("out-interrupted");

    expect(ledger.get("out-interrupted")).toMatchObject({
      state: "interrupted_by_human",
      outboundDelivery: "pending",
      deliveryStatus: "cancelled",
      deliveryCode: "interrupted_by_human",
      deliveryText: "The human owner interrupted this task.",
    });
  });

  test("queued agent cancellation persists a cancelled outcome", async () => {
    const { ledger, scheduler } = r3Scheduler(async () => ({
      kind: "accepted",
      turnId: "must-not-start",
    }));
    scheduler.onHumanTurnStarted("human-holds-fifo");
    await enq(scheduler, "out-cancelled-task", "out-cancelled");
    expect(await scheduler.cancelQueuedTask(asTaskId("out-cancelled-task"))).toMatchObject({
      outcome: "cancelled",
    });

    expect(ledger.get("out-cancelled")).toMatchObject({
      state: "cancelled",
      outboundDelivery: "pending",
      deliveryStatus: "cancelled",
      deliveryCode: "cancelled_by_agent",
      deliveryText: "This queued task was cancelled before it started.",
    });
  });

  test("empty, 10000, and 10001-character answers obey the exact Hub boundary", async () => {
    const empty = completedDelivery("");
    expect(empty).toEqual({
      ok: false,
      delivery: {
        status: "failed",
        code: "empty_final_answer",
        text: "Gateway received no final answer for this task.",
      },
    });
    const emptyScheduler = r3Scheduler(async () => ({
      kind: "accepted",
      turnId: "turn-empty-answer",
    }));
    await enq(emptyScheduler.scheduler, "out-empty-task", "out-empty");
    await settleScheduler();
    emptyScheduler.scheduler.onAgentTurnFinished("out-empty", { ok: true, replyText: "" });
    expect(emptyScheduler.ledger.get("out-empty")).toMatchObject({
      state: "failed",
      outboundDelivery: "pending",
      deliveryStatus: "failed",
      deliveryCode: "empty_final_answer",
      deliveryText: "Gateway received no final answer for this task.",
    });

    const exact = "x".repeat(MAX_HUB_REPLY_TEXT_LENGTH);
    const exactResult = completedDelivery(exact);
    expect(exactResult.ok).toBe(true);
    expect(exactResult.delivery.text).toBe(exact);
    expect(exactResult.delivery.text).toHaveLength(MAX_HUB_REPLY_TEXT_LENGTH);

    const oversized = completedDelivery("y".repeat(MAX_HUB_REPLY_TEXT_LENGTH + 1));
    expect(oversized.ok).toBe(true);
    expect(oversized.delivery.text).toHaveLength(MAX_HUB_REPLY_TEXT_LENGTH);
    expect(oversized.delivery.text.endsWith(TRUNCATED_REPLY_MARKER)).toBe(true);
    expect(oversized.delivery.text).toBe(
      "y".repeat(MAX_HUB_REPLY_TEXT_LENGTH - TRUNCATED_REPLY_MARKER.length) +
        TRUNCATED_REPLY_MARKER,
    );

    const prefixLimit = MAX_HUB_REPLY_TEXT_LENGTH - TRUNCATED_REPLY_MARKER.length;
    const astral = completedDelivery(
      "a".repeat(prefixLimit - 1) + "😀" + "z".repeat(TRUNCATED_REPLY_MARKER.length),
    );
    expect(astral.ok).toBe(true);
    expect(astral.delivery.text.endsWith(TRUNCATED_REPLY_MARKER)).toBe(true);
    expect(astral.delivery.text).not.toContain("\ud83d");
    expect(astral.delivery.text.length).toBeLessThanOrEqual(MAX_HUB_REPLY_TEXT_LENGTH);
  });

  test("terminal and delivered timestamps remain stable across attempts and duplicate delivery", () => {
    const ledger = memLedger();
    ledger.record({ submissionId: "timestamp", origin: "agent", taskId: "timestamp-task" });
    ledger.transition("timestamp", "queued");
    ledger.transition("timestamp", "dispatching", { bumpDispatchAttempts: true });
    ledger.transition("timestamp", "accepted", { turnId: "timestamp-turn" });
    ledger.transition("timestamp", "completed", { replyText: "timestamp answer" });
    ledger.transition("timestamp", "reply_pending", {
      outbound: completedDelivery("timestamp answer").delivery,
    });

    const initial = ledger.get("timestamp")!;
    expect(initial.terminalAt).not.toBeNull();
    expect(initial.deliveryUpdatedAt).not.toBeNull();
    const attempted = ledger.noteOutboundAttempt("timestamp");
    expect(attempted.terminalAt).toBe(initial.terminalAt);
    expect(attempted.deliveryAttempts).toBe(1);

    const delivered = ledger.markOutboundDelivered("timestamp");
    expect(delivered.terminalAt).toBe(initial.terminalAt);
    expect(delivered.deliveredAt).not.toBeNull();
    const deliveredAt = delivered.deliveredAt;
    expect(() => ledger.markOutboundDelivered("timestamp")).toThrow(/not pending/);
    expect(ledger.get("timestamp")!.deliveredAt).toBe(deliveredAt);
  });

  test("recovery preserves an existing pending outcome and reconstructs legacy terminal pending metadata", () => {
    const ledger = memLedger();
    ledger.record({ submissionId: "already-pending", origin: "agent", taskId: "pending-task" });
    ledger.transition("already-pending", "queued");
    ledger.transition("already-pending", "dispatching", { bumpDispatchAttempts: true });
    ledger.transition("already-pending", "accepted", { turnId: "pending-turn" });
    ledger.transition("already-pending", "completed", { replyText: "durable success" });
    ledger.transition("already-pending", "reply_pending", {
      outbound: completedDelivery("durable success").delivery,
    });
    const pendingBefore = ledger.get("already-pending")!;

    ledger.record({ submissionId: "legacy-failed", origin: "agent", taskId: "legacy-failed-task" });
    ledger.transition("legacy-failed", "failed", { error: "stable legacy failure" });

    const report = ledger.recover(new Map());
    expect(report.replyPending.map((row) => row.submissionId)).toEqual(["legacy-failed"]);
    expect(ledger.outboundPending().map((row) => row.submissionId)).toEqual([
      "already-pending",
      "legacy-failed",
    ]);
    expect(ledger.get("already-pending")).toMatchObject({
      state: "reply_pending",
      outboundDelivery: "pending",
      deliveryStatus: "replied",
      deliveryCode: "completed",
      deliveryText: "durable success",
      terminalAt: pendingBefore.terminalAt,
      deliveryUpdatedAt: pendingBefore.deliveryUpdatedAt,
    });
    expect(ledger.get("legacy-failed")).toMatchObject({
      state: "failed",
      outboundDelivery: "pending",
      deliveryStatus: "failed",
      deliveryCode: "turn_failed",
      deliveryText: "Gateway could not complete this task.",
    });
  });
});
