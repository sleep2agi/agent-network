import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommHubError } from "../reply-reliability";
import {
  createCommHubPollCompensator,
  isUnboundTokenRejection,
  type CompensationPollAdapters,
  type InboxObservation,
} from "./commhub-poll-compensator";

// Field report: after upgrading, codex-app-server nodes whose node token was
// minted before RFC-036 node binding logged
//   [commhub-compensation] poll failed; retry in …: app-level rejection: from_node_id_identity_mismatch
// forever. The Hub refusal is permanent for an unbound token, and because the
// inbox read shares the poll, inbox compensation was lost too.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function rejection(code: string) {
  return new CommHubError(`app-level rejection: ${code}`, { code, payload: { ok: false, error: code }, appLevel: true });
}

function harness(listOutbound: CompensationPollAdapters["listOutbound"]) {
  const root = mkdtempSync(join(tmpdir(), "anet-poll-unbound-"));
  roots.push(root);
  const inbox: InboxObservation[] = [];
  const drains: string[] = [];
  const warnings: string[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let outboundCalls = 0;
  const adapters: CompensationPollAdapters = {
    getInbox: async () => [...inbox],
    listOutbound: async (w) => { outboundCalls++; return listOutbound(w); },
    scheduleInboxDrain: () => drains.push("drain"),
    onOutboundTerminal: () => {},
    log: () => {},
    warn: (m) => warnings.push(m),
    now: () => Date.parse("2026-09-24T00:00:00.000Z"),
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: () => {},
  };
  const poller = createCommHubPollCompensator({ cursorPath: join(root, "cursor.json"), intervalMs: 15_000, adapters });
  return { poller, inbox, drains, warnings, timers, calls: () => outboundCalls };
}

describe("compensation with a legacy (unbound) node token", () => {
  test("classifier: only the two binding refusals, only as app-level rejections", () => {
    expect(isUnboundTokenRejection(rejection("from_node_id_identity_mismatch"))).toBe(true);
    expect(isUnboundTokenRejection(rejection("node_token_required"))).toBe(true);
    expect(isUnboundTokenRejection(rejection("durable_cursor_required"))).toBe(false);
    expect(isUnboundTokenRejection(rejection("some_other_error"))).toBe(false);
    // Same text over a transport failure is NOT a binding verdict.
    expect(isUnboundTokenRejection(new CommHubError("from_node_id_identity_mismatch", { code: "from_node_id_identity_mismatch", appLevel: false }))).toBe(false);
    expect(isUnboundTokenRejection(new Error("app-level rejection: from_node_id_identity_mismatch"))).toBe(false);
    expect(isUnboundTokenRejection(null)).toBe(false);
  });

  test("identity refusal disables outbound once, keeps inbox compensation, warns once, no backoff loop", async () => {
    const h = harness(async () => { throw rejection("from_node_id_identity_mismatch"); });
    h.inbox.push({ id: "row-lost", task_id: "task-lost" });
    h.poller.trigger("startup");
    await h.poller.idle();
    expect(h.poller.mode).toBe("active");
    expect(h.poller.outboundDisabled).toBe(true);
    expect(h.drains).toEqual(["drain"]);
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("outbound reconciliation disabled");
    expect(h.warnings[0]).toContain("from_node_id_identity_mismatch");
    expect(h.warnings.some((w) => w.includes("poll failed"))).toBe(false);
    // Re-armed at the normal interval, not an exponential failure backoff.
    expect(h.timers.at(-1)?.delay).toBe(15_000);

    // Later polls never call the refused cursor again and never re-warn.
    h.inbox.push({ id: "row-2", task_id: "task-2" });
    h.timers.at(-1)!.callback();
    await h.poller.idle();
    expect(h.calls()).toBe(1);
    expect(h.warnings.length).toBe(1);
    expect(h.drains).toEqual(["drain", "drain"]);
  });

  test("node_token_required is treated the same way", async () => {
    const h = harness(async () => { throw rejection("node_token_required"); });
    h.poller.trigger("startup");
    await h.poller.idle();
    expect(h.poller.outboundDisabled).toBe(true);
    expect(h.poller.mode).toBe("active");
  });

  test("any other outbound failure keeps the existing retry-with-backoff behaviour", async () => {
    const h = harness(async () => { throw rejection("some_other_error"); });
    h.poller.trigger("startup");
    await h.poller.idle();
    expect(h.poller.outboundDisabled).toBe(false);
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("poll failed; retry in 30000ms");
    expect(h.timers.at(-1)?.delay).toBe(30_000);
  });

  test("a transient transport error is retried, not treated as a permanent binding verdict", async () => {
    const h = harness(async () => { throw new CommHubError("fetch failed", { appLevel: false }); });
    h.poller.trigger("startup");
    await h.poller.idle();
    expect(h.poller.outboundDisabled).toBe(false);
    h.timers.at(-1)!.callback();
    await h.poller.idle();
    expect(h.calls()).toBe(2);
  });

  test("bound tokens are unaffected: outbound stays enabled", async () => {
    const h = harness(async () => ({ tasks: [], hasMore: false }));
    h.poller.trigger("startup");
    await h.poller.idle();
    expect(h.poller.outboundDisabled).toBe(false);
    expect(h.warnings).toEqual([]);
  });
});
