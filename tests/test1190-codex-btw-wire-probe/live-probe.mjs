import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";

const child = spawn("codex", ["app-server", "--stdio", "-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let stderrTail = "";
child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });

let rpcId = 0, semanticSeq = 0;
const pending = new Map(), events = [], trace = [], aliases = new Map();
const alias = (id) => aliases.get(id) ?? "unknown";
const mark = (kind, fields = {}) => trace.push({ seq: ++semanticSeq, kind, ...fields });
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && !msg.method) {
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id);
    mark("rpc_response", { method: p.method, class: msg.error ? "error" : "success", errorCode: msg.error?.code });
    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "turn/started" || msg.method === "turn/completed") {
    const event = { seq: ++semanticSeq, method: msg.method, params: msg.params, used: false };
    events.push(event);
    trace.push({ seq: event.seq, kind: "notification", method: msg.method, threadId: msg.params?.threadId, turnId: msg.params?.turn?.id, status: msg.params?.turn?.status });
  }
});
const rpc = (method, params, timeoutMs = 180_000) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  mark("rpc_request", { method, threadId: params?.threadId, turnId: params?.turnId,
    boundaryTurnId: params?.lastTurnId ?? params?.beforeTurnId,
    boundaryKind: params?.lastTurnId ? "through" : params?.beforeTurnId ? "before" : undefined });
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr=${stderrTail}`)); }, timeoutMs);
  pending.set(id, { method, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitEvent = async (method, threadId, turnId, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find((x) => !x.used && x.method === method && x.params?.threadId === threadId && x.params?.turn?.id === turnId);
    if (event) { event.used = true; return event; }
    await sleep(20);
  }
  throw new Error(`${method} timed out for ${alias(threadId)}/${alias(turnId)}`);
};
const strictThread = (response, method) => {
  if (!response?.thread?.id || Object.hasOwn(response, "threadId")) throw new Error(`${method} response shape drift`);
  return response.thread;
};
const strictTurn = (response) => {
  if (!response?.turn?.id || Object.hasOwn(response, "turnId")) throw new Error("turn/start response shape drift");
  return response.turn;
};
const read = async (threadId) => strictThread(await rpc("thread/read", { threadId, includeTurns: true }), "thread/read");
const statusType = (thread) => thread?.status?.type;
const turnIds = (thread) => (thread.turns ?? []).map((turn) => turn.id);
const tryRpc = async (method, params) => { try { return { ok: true, value: await rpc(method, params) }; } catch (error) { return { ok: false, code: error.rpc?.code ?? null }; } };
const started = (threadId, turnId) => waitEvent("turn/started", threadId, turnId);
const terminal = (threadId, turnId) => waitEvent("turn/completed", threadId, turnId);
const completedStatus = (event) => event.params.turn.status;
const logicalTurns = (ids) => ids.map(alias);
const sanitizeTrace = () => trace.map((entry) => {
  const output = { ...entry };
  if (entry.threadId) output.thread = alias(entry.threadId);
  if (entry.turnId) output.turn = alias(entry.turnId);
  if (entry.boundaryTurnId) output.boundaryTurn = alias(entry.boundaryTurnId);
  delete output.threadId; delete output.turnId; delete output.boundaryTurnId;
  return output;
});

const binary = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
const binarySha256 = createHash("sha256").update(fs.readFileSync(fs.realpathSync(binary))).digest("hex");
const result = {
  evidenceRevision: "test1190-wire-v2",
  artifact: { codexCli: "0.148.0", packageBoundary: "probe-only; agent-node lock remains 0.133.0", os: os.platform(), arch: os.arch(), binarySha256 },
  topology: "owned-stdio", forkBoundary: {}, concurrencyCancel: {}, reverseCompletion: {}, retention: {},
};

try {
  await rpc("initialize", { clientInfo: { name: "anet-btw-wire-probe", version: "0.2.0" }, capabilities: { experimentalApi: true } });
  notify("initialized", {});
  const source = strictThread(await rpc("thread/start", { ephemeral: false }), "thread/start").id; aliases.set(source, "source");
  const seed = strictTurn(await rpc("turn/start", { threadId: source, input: [{ type: "text", text: "Reply exactly SEED_OK." }] })).id; aliases.set(seed, "seed");
  await terminal(source, seed);
  const active = strictTurn(await rpc("turn/start", { threadId: source, input: [{ type: "text", text: "Run `sleep 15`, then reply MAIN_OK." }] })).id; aliases.set(active, "sourceActive");
  const sourceStarted = await started(source, active);
  if (process.env.BTW_WITNESS_SOURCE_FIRST === "1") await terminal(source, active);
  const sourceBefore = await read(source);
  if (statusType(sourceBefore) !== "active") throw new Error("WITNESS_RED: source was not active at fork boundary");

  const forkCancel = strictThread(await rpc("thread/fork", { threadId: source, lastTurnId: seed, ephemeral: false }), "thread/fork").id; aliases.set(forkCancel, "forkCancel");
  const forkCancelRead = await read(forkCancel);
  if (statusType(await read(source)) !== "active") throw new Error("source stopped before beforeTurnId fork");
  const forkSibling = strictThread(await rpc("thread/fork", { threadId: source, beforeTurnId: active, ephemeral: false }), "thread/fork").id; aliases.set(forkSibling, "forkSibling");
  const forkSiblingRead = await read(forkSibling);
  const activeBoundary = await tryRpc("thread/fork", { threadId: source, lastTurnId: active, ephemeral: true });
  result.forkBoundary = {
    sourceStatusAtFork: statusType(sourceBefore), sourceTurnsBefore: logicalTurns(turnIds(sourceBefore)),
    throughTurns: logicalTurns(turnIds(forkCancelRead)), beforeTurns: logicalTurns(turnIds(forkSiblingRead)),
    throughForkedFromMatches: forkCancelRead.forkedFromId === source, beforeForkedFromMatches: forkSiblingRead.forkedFromId === source,
    seedIncluded: turnIds(forkCancelRead).includes(seed) && turnIds(forkSiblingRead).includes(seed),
    activeExcluded: !turnIds(forkCancelRead).includes(active) && !turnIds(forkSiblingRead).includes(active),
    activeInclusiveBoundaryRejected: !activeBoundary.ok, activeInclusiveBoundaryErrorCode: activeBoundary.code,
  };

  const cancelTurn = strictTurn(await rpc("turn/start", { threadId: forkCancel, input: [{ type: "text", text: "Run `sleep 12`, then reply CANCEL_BAD." }] })).id; aliases.set(cancelTurn, "cancelTurn");
  const siblingTurn = strictTurn(await rpc("turn/start", { threadId: forkSibling, input: [{ type: "text", text: "Run `sleep 8`, then reply SIBLING_OK." }] })).id; aliases.set(siblingTurn, "siblingTurn");
  const [cancelStarted, siblingStarted] = await Promise.all([started(forkCancel, cancelTurn), started(forkSibling, siblingTurn)]);
  const activeReads = await Promise.all([read(source), read(forkCancel), read(forkSibling)]);
  if (activeReads.some((thread) => statusType(thread) !== "active")) throw new Error("three-way active precondition failed");
  mark("cancel_requested", { threadId: forkCancel, turnId: cancelTurn }); const cancelRequestedSeq = semanticSeq;
  await rpc("turn/interrupt", { threadId: forkCancel, turnId: cancelTurn });
  const [cancelDone, siblingDone, sourceDone] = await Promise.all([terminal(forkCancel, cancelTurn), terminal(forkSibling, siblingTurn), terminal(source, active)]);
  const sourceAfterCancel = await read(source), siblingAfterCancel = await read(forkSibling);
  result.concurrencyCancel = {
    sourceStartedBeforeForks: sourceStarted.seq < cancelStarted.seq && sourceStarted.seq < siblingStarted.seq,
    allThreeActiveBeforeCancel: true,
    cancelRequestedBeforeTargetTerminal: cancelRequestedSeq < cancelDone.seq,
    cancelRequestedBeforeSiblingTerminal: cancelRequestedSeq < siblingDone.seq,
    cancelRequestedBeforeSourceTerminal: cancelRequestedSeq < sourceDone.seq,
    targetStatus: completedStatus(cancelDone), siblingStatus: completedStatus(siblingDone), sourceStatus: completedStatus(sourceDone),
    sourceReadableAfterCancel: sourceAfterCancel.id === source, siblingReadableAfterCancel: siblingAfterCancel.id === forkSibling,
  };

  const slowThread = strictThread(await rpc("thread/fork", { threadId: source, lastTurnId: seed, ephemeral: false }), "thread/fork").id;
  const fastThread = strictThread(await rpc("thread/fork", { threadId: source, lastTurnId: seed, ephemeral: false }), "thread/fork").id;
  aliases.set(slowThread, "forkSlow"); aliases.set(fastThread, "forkFast");
  const slowTurn = strictTurn(await rpc("turn/start", { threadId: slowThread, input: [{ type: "text", text: "Run `sleep 6`, then reply SLOW_OK." }] })).id;
  const fastTurn = strictTurn(await rpc("turn/start", { threadId: fastThread, input: [{ type: "text", text: "Reply FAST_OK." }] })).id;
  aliases.set(slowTurn, "slowTurn"); aliases.set(fastTurn, "fastTurn");
  const [fastDone, slowDone] = await Promise.all([terminal(fastThread, fastTurn), terminal(slowThread, slowTurn)]);
  result.reverseCompletion = { creationOrder: ["forkSlow", "forkFast"], completionOrder: fastDone.seq < slowDone.seq ? ["forkFast", "forkSlow"] : ["forkSlow", "forkFast"], fastStatus: completedStatus(fastDone), slowStatus: completedStatus(slowDone) };

  await rpc("thread/archive", { threadId: forkCancel }); const archivedRead = await read(forkCancel);
  await rpc("thread/unarchive", { threadId: forkCancel }); const unarchivedRead = await read(forkCancel);
  await rpc("thread/delete", { threadId: forkSibling }); const deletedRead = await tryRpc("thread/read", { threadId: forkSibling, includeTurns: true });
  const sourceAfterDelete = await read(source), unarchivedAfterDelete = await read(forkCancel);
  result.retention = {
    archivedReadable: archivedRead.id === forkCancel, unarchivedReadable: unarchivedRead.id === forkCancel,
    deleteReadRejected: !deletedRead.ok, deleteReadErrorCode: deletedRead.code,
    sourceIsolatedFromDelete: sourceAfterDelete.id === source, unarchivedSiblingIsolatedFromDelete: unarchivedAfterDelete.id === forkCancel,
  };
  fs.writeFileSync(process.env.BTW_TRACE_PATH, JSON.stringify({ evidenceRevision: result.evidenceRevision, topology: result.topology, trace: sanitizeTrace() }, null, 2) + "\n", { mode: 0o600 });
} finally {
  try { await rpc("shutdown", {}, 5_000); } catch {}
  child.kill("SIGTERM");
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
