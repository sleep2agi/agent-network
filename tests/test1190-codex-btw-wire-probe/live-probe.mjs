import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("codex", [
  "app-server", "--stdio",
  "-c", "approval_policy=never",
  "-c", "sandbox_mode=danger-full-access",
], { stdio: ["pipe", "pipe", "pipe"], env: process.env });

let seq = 0;
const pending = new Map();
const events = [];
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && !msg.method) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : p.resolve(msg.result);
    return;
  }
  if (msg.method) events.push(msg);
});

const rpc = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} timed out`));
  }, timeoutMs);
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const idOfThread = (x) => x?.thread?.id ?? x?.threadId;
const idOfTurn = (x) => x?.turn?.id ?? x?.turnId;
const statusOf = (x) => x?.turn?.status ?? x?.status;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEvent = async (method, predicate, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const at = events.findIndex((e) => e.method === method && predicate(e.params ?? {}));
    if (at >= 0) return events.splice(at, 1)[0].params;
    await sleep(25);
  }
  throw new Error(`notification ${method} timed out`);
};
const terminal = async (threadId, turnId) => waitEvent("turn/completed", (p) =>
  (p.threadId ?? p.thread_id) === threadId && idOfTurn(p) === turnId, 180_000);
const tryRpc = async (method, params) => {
  try { return { ok: true, value: await rpc(method, params) }; }
  catch (e) { return { ok: false, code: e.rpc?.code ?? null, message: String(e.message).slice(0, 240) }; }
};

const result = { version: "codex-cli 0.148.0", observations: {} };
try {
  await rpc("initialize", {
    clientInfo: { name: "anet-btw-wire-probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});

  const source = idOfThread(await rpc("thread/start", { ephemeral: false }));
  if (!source) throw new Error("thread/start returned no id");

  const seed = idOfTurn(await rpc("turn/start", {
    threadId: source,
    input: [{ type: "text", text: "Reply with exactly SEED_OK and nothing else." }],
  }));
  if (!seed) throw new Error("seed turn/start returned no id");
  const seedDone = await terminal(source, seed);
  if (statusOf(seedDone) !== "completed") throw new Error(`seed status=${statusOf(seedDone)}`);

  const active = idOfTurn(await rpc("turn/start", {
    threadId: source,
    input: [{ type: "text", text: "Run the shell command `sleep 12`, then reply exactly MAIN_OK." }],
  }));
  if (!active) throw new Error("active turn/start returned no id");
  await waitEvent("turn/started", (p) => (p.threadId ?? p.thread_id) === source && idOfTurn(p) === active);

  // Exact completed boundary while the source has a later active turn.
  const forkAResp = await rpc("thread/fork", { threadId: source, lastTurnId: seed, ephemeral: false });
  const forkA = idOfThread(forkAResp);
  const forkBResp = await rpc("thread/fork", { threadId: source, beforeTurnId: active, ephemeral: false });
  const forkB = idOfThread(forkBResp);
  if (!forkA || !forkB || forkA === forkB || forkA === source || forkB === source) {
    throw new Error("fork ids are not independent");
  }
  const activeAsBoundary = await tryRpc("thread/fork", { threadId: source, lastTurnId: active, ephemeral: true });
  result.observations.forkBoundary = {
    completedLastTurnWhileLaterActive: true,
    beforeActiveTurn: true,
    activeLastTurnRejected: !activeAsBoundary.ok,
    activeLastTurnErrorCode: activeAsBoundary.code,
  };

  // Two derived threads execute concurrently. B is short; A is cancelled.
  const turnA = idOfTurn(await rpc("turn/start", {
    threadId: forkA,
    input: [{ type: "text", text: "Run `sleep 9`, then reply exactly FORK_A_SHOULD_NOT_FINISH." }],
  }));
  const turnB = idOfTurn(await rpc("turn/start", {
    threadId: forkB,
    input: [{ type: "text", text: "Reply exactly FORK_B_OK and nothing else." }],
  }));
  await Promise.all([
    waitEvent("turn/started", (p) => (p.threadId ?? p.thread_id) === forkA && idOfTurn(p) === turnA),
    waitEvent("turn/started", (p) => (p.threadId ?? p.thread_id) === forkB && idOfTurn(p) === turnB),
  ]);
  const interrupted = await tryRpc("turn/interrupt", { threadId: forkA, turnId: turnA });
  const [aDone, bDone, mainDone] = await Promise.all([
    terminal(forkA, turnA), terminal(forkB, turnB), terminal(source, active),
  ]);
  result.observations.concurrentAndCancel = {
    independentInterruptAccepted: interrupted.ok,
    cancelledForkStatus: statusOf(aDone),
    siblingForkStatus: statusOf(bDone),
    sourceStatus: statusOf(mainDone),
    allThreadIdsDistinct: new Set([source, forkA, forkB]).size === 3,
  };

  const archived = await tryRpc("thread/archive", { threadId: forkA });
  const readArchived = await tryRpc("thread/read", { threadId: forkA, includeTurns: true });
  const deleted = await tryRpc("thread/delete", { threadId: forkB });
  const readDeleted = await tryRpc("thread/read", { threadId: forkB, includeTurns: true });
  result.observations.retention = {
    archiveAccepted: archived.ok,
    archivedStillReadable: readArchived.ok,
    deleteAccepted: deleted.ok,
    deletedReadRejected: !readDeleted.ok,
    deletedReadErrorCode: readDeleted.code,
  };
} finally {
  try { await rpc("shutdown", {}, 5_000); } catch {}
  child.kill("SIGTERM");
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
