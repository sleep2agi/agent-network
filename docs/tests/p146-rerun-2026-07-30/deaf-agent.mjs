// A node process that behaves like a live agent-node session but REFUSES to
// die on SIGTERM. Used to prove the rename path escalates to SIGKILL and
// does not let a survivor heartbeat the old alias back into place (R1).
import { appendFileSync, writeFileSync } from "fs";
const { HUB, NTOK, NETWORK_ID, NODE_ID, OUT, PIDFILE } = process.env;
let alias = process.env.ALIAS;
writeFileSync(PIDFILE, String(process.pid));
const log = (o) => { try { appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); } catch {} };
async function beat() {
  try {
    const r = await fetch(`${HUB}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${NTOK}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call",
        params: { name: "report_status", arguments: { resume_id: `sdk-${NODE_ID}`, alias, status: "idle", node_id: NODE_ID, network_id: NETWORK_ID, task: "deaf-mock" } } }),
    });
    log({ ev: "beat", alias, status: r.status });
  } catch (e) { log({ ev: "beat_err", msg: String(e).slice(0, 120) }); }
}
process.on("SIGTERM", () => log({ ev: "SIGTERM_IGNORED", pid: process.pid }));
process.on("SIGINT", () => log({ ev: "SIGINT_IGNORED", pid: process.pid }));
await beat();
setInterval(beat, 3000);
log({ ev: "deaf_started", pid: process.pid, alias });
