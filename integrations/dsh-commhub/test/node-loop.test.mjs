import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeHub, waitFor } from "./fake-hub.mjs";
import { createHubClient } from "../src/hub-client.mjs";
import { createLedger } from "../src/ledger.mjs";
import { createCommhubNode, truncateReply, REPLY_MAX_CHARS } from "../src/node-loop.mjs";
import { commhubToolSpecs } from "../src/tools.mjs";

const fast = { heartbeatMs: 60_000, pollMs: 60_000, backoff: { initialMs: 20, maxMs: 80 } };

async function setup({ runTurn, failReplyTimes, ledgerPath } = {}) {
  const hub = await startFakeHub({ failReplyTimes });
  const dir = mkdtempSync(join(tmpdir(), "dsh-commhub-test-"));
  const client = createHubClient({ hub: hub.url, token: hub.token });
  const turns = [];
  const node = createCommhubNode({
    client, alias: "dsh-a", ledger: createLedger(ledgerPath ?? join(dir, "ledger.json")), ...fast,
    runTurn: runTurn ?? (async (prompt) => { turns.push(prompt); return `answer to: ${prompt}`; }),
  });
  return { hub, node, turns, dir, client, cleanup: async () => { await node.stop(); await hub.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("registers with report_status on start and goes offline on stop", async () => {
  const t = await setup();
  try {
    await t.node.start();
    assert.equal(t.hub.statuses[0].alias, "dsh-a");
    assert.equal(t.hub.statuses[0].status, "idle");
    assert.equal(t.hub.statuses[0].agent, "dsh");
    assert.match(t.hub.statuses[0].resume_id, /^dsh-/);
    await t.node.stop();
    assert.equal(t.hub.statuses.at(-1).status, "offline");
  } finally { await t.cleanup(); }
});

test("a task arriving over SSE is answered exactly once with status replied, and its inbox row is acked", async () => {
  const t = await setup();
  try {
    await t.node.start();
    assert.ok(await waitFor(() => t.hub.sseCount() === 1), "SSE subscribed");
    const id = t.hub.addTask("1+1?");
    assert.ok(await waitFor(() => t.hub.replies.length === 1), "reply sent");
    assert.equal(t.hub.replies[0].in_reply_to, id);
    assert.equal(t.hub.replies[0].status, "replied");
    assert.match(t.hub.replies[0].text, /answer to: \[来自 peer-a\] 1\+1\?/);
    assert.ok(await waitFor(() => t.hub.inbox.every((m) => m.acked)), "row acked");
    assert.ok(t.hub.statuses.some((s) => s.status === "working"), "reported working during the turn");
    assert.equal(t.turns.length, 1);
  } finally { await t.cleanup(); }
});

test("after an SSE drop the node reconnects, drains, and never replies twice to the same task", async () => {
  const t = await setup();
  try {
    await t.node.start();
    assert.ok(await waitFor(() => t.hub.sseCount() === 1));
    const first = t.hub.addTask("first");
    assert.ok(await waitFor(() => t.hub.replies.length === 1));
    // Simulate the hub re-delivering the same row (unacked) plus a network blip.
    t.hub.inbox.find((m) => m.id === first).acked = false;
    t.hub.dropSse();
    assert.ok(await waitFor(() => t.hub.sseCount() === 1 && t.node.stats.connects >= 2), "reconnected");
    const second = t.hub.addTask("second");
    assert.ok(await waitFor(() => t.hub.replies.some((r) => r.in_reply_to === second)), "second task answered after reconnect");
    await t.node.drain();
    assert.equal(t.hub.replies.filter((r) => r.in_reply_to === first).length, 1, "no duplicate reply for the redelivered task");
    assert.equal(t.turns.filter((p) => p.endsWith("first")).length, 1, "the agent ran the first task once");
    assert.ok(t.hub.inbox.every((m) => m.acked), "redelivered row acked without a new turn");
  } finally { await t.cleanup(); }
});

test("a failing agent turn is reported as failed with a human-readable reason, never dropped", async () => {
  const t = await setup({ runTurn: async () => { throw new Error("model quota exhausted"); } });
  try {
    await t.node.start();
    t.hub.addTask("do something");
    assert.ok(await waitFor(() => t.hub.replies.length === 1));
    assert.equal(t.hub.replies[0].status, "failed");
    assert.match(t.hub.replies[0].text, /agent turn failed: model quota exhausted/);
  } finally { await t.cleanup(); }
});

test("an empty agent answer is reported as failed, not as an empty success", async () => {
  const t = await setup({ runTurn: async () => "   " });
  try {
    await t.node.start();
    t.hub.addTask("say nothing");
    assert.ok(await waitFor(() => t.hub.replies.length === 1));
    assert.equal(t.hub.replies[0].status, "failed");
    assert.match(t.hub.replies[0].text, /without any text answer/);
  } finally { await t.cleanup(); }
});

test("if the hub rejects send_reply, the answer is kept and resent on the next drain without re-running the turn", async () => {
  const t = await setup({ failReplyTimes: 1 });
  try {
    await t.node.start();
    const id = t.hub.addTask("keep my answer");
    assert.ok(await waitFor(() => t.hub.calls.filter((c) => c === "send_reply").length >= 1));
    assert.equal(t.hub.replies.length, 0, "first reply attempt failed");
    assert.equal(t.hub.inbox.find((m) => m.id === id).acked, false, "row left unacked for retry");
    await t.node.drain();
    assert.equal(t.hub.replies.length, 1);
    assert.equal(t.hub.replies[0].status, "replied");
    assert.equal(t.turns.length, 1, "turn not re-run");
  } finally { await t.cleanup(); }
});

test("a task left 'started' by a crashed previous process is answered failed with a resend hint, not silently re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-commhub-crash-"));
  const ledgerPath = join(dir, "ledger.json");
  const t = await setup({ ledgerPath });
  try {
    const id = t.hub.addTask("interrupted work");
    createLedger(ledgerPath).set(id, { state: "started" });
    // Re-open the ledger the node uses by restarting with a fresh node on the same path.
    const node2 = createCommhubNode({ client: t.client, alias: "dsh-a", ledger: createLedger(ledgerPath), ...fast, runTurn: async () => { t.turns.push("ran"); return "x"; } });
    await node2.start();
    assert.ok(await waitFor(() => t.hub.replies.length === 1));
    assert.equal(t.hub.replies[0].status, "failed");
    assert.match(t.hub.replies[0].text, /restarted before this task finished/);
    assert.equal(t.turns.length, 0);
    await node2.stop();
  } finally { await t.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("non-task inbox rows are acked and never start an agent turn", async () => {
  const t = await setup();
  try {
    await t.node.start();
    t.hub.addMessage("fyi");
    assert.ok(await waitFor(() => t.hub.inbox.every((m) => m.acked)));
    assert.equal(t.turns.length, 0);
    assert.equal(t.hub.replies.length, 0);
  } finally { await t.cleanup(); }
});

test("replies longer than the hub limit are truncated with a visible note", () => {
  const long = "x".repeat(REPLY_MAX_CHARS + 50);
  const out = truncateReply(long);
  assert.equal(out.length, REPLY_MAX_CHARS);
  assert.match(out, /truncated/);
  assert.equal(truncateReply("short"), "short");
});

test("the three agent tools call send_task / send_message / get_all_status as this node", async () => {
  const hub = await startFakeHub();
  try {
    const client = createHubClient({ hub: hub.url, token: hub.token });
    const specs = Object.fromEntries(commhubToolSpecs(client, "dsh-a").map((s) => [s.name, s]));
    const t = await specs.commhub_send_task.handler({ alias: "peer-a", task: "review this" });
    const m = await specs.commhub_send_message.handler({ alias: "peer-a", message: "fyi" });
    const s = await specs.commhub_get_all_status.handler({});
    assert.match(t.id, /^t/); assert.match(m.id, /^m/);
    assert.deepEqual(s.agents, [{ alias: "peer-a", status: "idle", agent: "agent-node:claude" }]);
    assert.deepEqual(hub.sent.map((x) => [x.tool, x.alias, x.from_session]), [["send_task", "peer-a", "dsh-a"], ["send_message", "peer-a", "dsh-a"]]);
  } finally { await hub.close(); }
});

test("a wrong token surfaces as an unauthorized error rather than an empty success", async () => {
  const hub = await startFakeHub();
  try {
    const client = createHubClient({ hub: hub.url, token: "ntok_wrong" });
    await assert.rejects(client.call("get_inbox", { alias: "dsh-a" }), /HTTP 401|unauthorized/);
  } finally { await hub.close(); }
});

test("an offline target is reported as queued, not as a failure; an unknown alias still fails", async () => {
  const hub = await startFakeHub();
  try {
    const client = createHubClient({ hub: hub.url, token: hub.token });
    const specs = Object.fromEntries(commhubToolSpecs(client, "dsh-a").map((s) => [s.name, s]));
    const out = await specs.commhub_send_message.handler({ alias: "offline-peer", message: "hi" });
    assert.equal(out.ok, true); assert.equal(out.queued, true); assert.match(out.id, /^m/);
    assert.match(specs.commhub_send_message.render(out), /queued .*target offline/);
    await assert.rejects(specs.commhub_send_message.handler({ alias: "no-such-peer", message: "hi" }), /alias_not_found/);
  } finally { await hub.close(); }
});
