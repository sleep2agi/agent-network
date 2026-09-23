// The CommHub node loop, independent of DSH: heartbeat, SSE doorbell with
// reconnect/backoff, inbox drain, exactly-once reply per task id.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const REPLY_MAX_CHARS = 10_000; // hub send_reply text limit

export function truncateReply(text) {
  const s = String(text ?? "");
  if (s.length <= REPLY_MAX_CHARS) return s;
  const note = "\n\n[dsh-commhub: reply truncated to the hub's 10000-character limit]";
  return s.slice(0, REPLY_MAX_CHARS - note.length) + note;
}

const isTerminalAlready = (err) => /reply_task_terminal|already terminal/i.test(String(err?.message ?? err));

/**
 * @param {{client: ReturnType<import('./hub-client.mjs').createHubClient>, alias: string,
 *   runTurn: (prompt: string, task: object) => Promise<string>, ledger: ReturnType<import('./ledger.mjs').createLedger>,
 *   log?: (m: string) => void, heartbeatMs?: number, pollMs?: number, turnTimeoutMs?: number,
 *   backoff?: {initialMs: number, maxMs: number}, version?: string}} opts
 */
export function createCommhubNode(opts) {
  const { client, alias, runTurn, ledger } = opts;
  const log = opts.log ?? (() => {});
  const resumeId = `dsh-${randomUUID()}`;
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const pollMs = opts.pollMs ?? 60_000;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 30 * 60_000;
  const backoff = opts.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
  let stopped = true;
  let sseAbort = null;
  let timers = [];
  let draining = null;
  let drainAgain = false;
  let status = "idle";
  let currentTask;
  const stats = { connects: 0, drains: 0, replies: 0, failures: 0 };

  const heartbeat = (next, task) => {
    if (next) status = next;
    currentTask = task;
    return client.call("report_status", {
      resume_id: resumeId, alias, status, ...(task ? { task: task.slice(0, 200) } : {}),
      agent: "dsh", hostname: hostname(), project_dir: process.cwd(), version: opts.version ?? "dsh-commhub",
    }).catch((e) => log(`report_status failed: ${e.message}`));
  };

  async function sendReply(id, text, replyStatus) {
    try {
      await client.call("send_reply", { in_reply_to: id, text: truncateReply(text), status: replyStatus, from_session: alias });
    } catch (e) {
      if (!isTerminalAlready(e)) throw e;
      log(`task ${id.slice(0, 8)} already terminal on the hub; not replying again`);
    }
    ledger.set(id, { state: "done", status: replyStatus });
    replyStatus === "replied" ? stats.replies++ : stats.failures++;
  }

  async function withTimeout(promise, ms) {
    let t;
    try {
      return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`turn exceeded ${Math.round(ms / 1000)}s`)), ms); })]);
    } finally { clearTimeout(t); }
  }

  async function handleTask(msg) {
    const id = String(msg.task_id || msg.id);
    const seen = ledger.get(id);
    if (seen?.state === "done") { log(`task ${id.slice(0, 8)} already replied; ack only`); return; }
    if (seen?.state === "answered") {
      log(`task ${id.slice(0, 8)} answered earlier but reply not delivered; resending`);
      await sendReply(id, seen.text, seen.status);
      return;
    }
    if (seen?.state === "started") {
      // The previous plugin process died mid-turn. Say so instead of silently re-running.
      await sendReply(id, "dsh-commhub: the node restarted before this task finished; nothing was returned. Please resend the task.", "failed");
      return;
    }
    ledger.set(id, { state: "started" });
    const content = String(msg.content ?? "");
    log(`task ${id.slice(0, 8)} from ${msg.from_session ?? "?"}: ${content.slice(0, 60)}`);
    await heartbeat("working", content);
    let text; let replyStatus = "replied";
    try {
      text = await withTimeout(runTurn(`[来自 ${msg.from_session ?? "unknown"}] ${content}`, msg), turnTimeoutMs);
      if (!String(text ?? "").trim()) { text = "dsh-commhub: the agent finished without any text answer."; replyStatus = "failed"; }
    } catch (e) {
      text = `dsh-commhub: the agent turn failed: ${e?.message ?? e}`;
      replyStatus = "failed";
    }
    ledger.set(id, { state: "answered", text: String(text), status: replyStatus });
    await sendReply(id, String(text), replyStatus);
    log(`task ${id.slice(0, 8)} → ${replyStatus} (${String(text).length} chars)`);
  }

  async function drainOnce() {
    stats.drains++;
    const { messages = [] } = await client.call("get_inbox", { alias, limit: 10 });
    for (const msg of messages) {
      if (stopped) return;
      try {
        if (msg.type === "task") await handleTask(msg);
        else log(`skip ${msg.type ?? "message"} ${String(msg.id).slice(0, 8)} from ${msg.from_session ?? "?"}`);
        await client.call("ack_inbox", { alias, message_id: msg.id });
      } catch (e) {
        // Leave the row unacked so the next drain retries it; the ledger prevents a double reply.
        log(`inbox row ${String(msg.id).slice(0, 8)} not finished: ${e.message}`);
      }
    }
    if (messages.length > 0) await heartbeat("idle");
  }

  function drain() {
    if (stopped) return Promise.resolve();
    if (draining) { drainAgain = true; return draining; }
    draining = (async () => {
      do {
        drainAgain = false;
        try { await drainOnce(); } catch (e) { log(`drain failed: ${e.message}`); }
      } while (drainAgain && !stopped);
    })().finally(() => { draining = null; });
    return draining;
  }

  async function sseLoop() {
    let delay = backoff.initialMs;
    while (!stopped) {
      sseAbort = new AbortController();
      try {
        for await (const ev of client.events(alias, sseAbort.signal)) {
          if (ev.type === "connected") {
            stats.connects++;
            delay = backoff.initialMs;
            log(stats.connects === 1 ? "SSE connected" : "SSE reconnected; re-registering and draining");
            if (stats.connects > 1) void heartbeat();
            void drain();
          } else if (ev.type === "new_task" || ev.type === "new_message") {
            void drain();
          }
        }
        if (!stopped) log("SSE stream ended");
      } catch (e) {
        if (stopped) return;
        log(`SSE error: ${e.message}`);
      }
      if (stopped) return;
      await new Promise((r) => { const t = setTimeout(r, delay); timers.push(t); });
      delay = Math.min(delay * 2, backoff.maxMs);
    }
  }

  return {
    resumeId,
    stats,
    drain,
    async start() {
      if (!stopped) return;
      stopped = false;
      await heartbeat("idle");
      timers.push(setInterval(() => void heartbeat(undefined, currentTask), heartbeatMs));
      timers.push(setInterval(() => void drain(), pollMs));
      void sseLoop();
      log(`node started alias=${alias}`);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      sseAbort?.abort();
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      timers = [];
      if (draining) await draining.catch(() => {});
      await heartbeat("offline");
    },
  };
}
