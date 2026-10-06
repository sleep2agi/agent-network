import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseCommhubToolResult } from "./commhub-response.js";

export const ADOPT_USAGE = "anet daemon adopt <alias> [--all] [--daemon <id-or-alias>] [--yes]\n  anet daemon unadopt <alias> [--yes]\n  anet daemon adopted [--daemon <id-or-alias>]";
export interface AdoptCliDeps {
  cwd: string; home: string; login: { hub?: string; token?: string; network_id?: string };
  fetch: typeof fetch; print: (line: string) => void;
}
/** Human login only. No local process control or node-directory writes. */
export async function runDaemonAdopt(verb: string, args: string[], deps: AdoptCliDeps): Promise<number> {
  let yes = false, all = false, daemonRef = "", alias = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--all" && verb === "adopt") all = true;
    else if (arg === "--daemon" && args[i + 1] && !args[i + 1].startsWith("-")) daemonRef = args[++i];
    else if (!arg.startsWith("-") && !alias && verb !== "adopted") alias = arg;
    else { deps.print(ADOPT_USAGE); return 2; }
  }
  if ((verb !== "adopted" && !alias && !all) || (all && alias)) { deps.print(ADOPT_USAGE); return 2; }
  const { login } = deps;
  if (!login.hub || !login.token || login.token.startsWith("ntok_") || !login.network_id) {
    deps.print("Use anet login with a human account and select a network first."); return 1;
  }
  const hub = login.hub.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${login.token}` };
  const query = `network_id=${encodeURIComponent(login.network_id)}`;
  const get = async (path: string) => {
    const res = await deps.fetch(`${hub}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    const body: any = await res.json();
    if (!res.ok || body.ok === false) throw Error(`Hub request failed (HTTP ${res.status})`);
    return body;
  };
  const call = async (name: string, params: object) => {
    const res = await deps.fetch(`${hub}/mcp`, { method: "POST", headers: { ...headers,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...params, network_id: login.network_id } } }),
      signal: AbortSignal.timeout(20_000) });
    const raw = await res.text(); const lines = raw.split("\n").filter(l => l.startsWith("data:"));
    const result = parseCommhubToolResult(JSON.parse(lines.length ? lines.at(-1)!.slice(5).trim() : raw));
    if (!res.ok || !result?.ok) throw Error(typeof result?.error === "string" ? result.error : "Hub refused request");
    return result;
  };
  try {
    const nodes: any[] = (await get(`/api/nodes?${query}`)).nodes ?? [];
    if (verb === "adopted") {
      // Local provenance AND current Hub authority; never label created nodes adopted.
      let registry: Record<string, any> = {};
      try { registry = JSON.parse(readFileSync(join(deps.cwd, ".anet/child-workdirs.json"), "utf8")); }
      catch (e: any) { if (e.code !== "ENOENT") throw Error("Cannot read local adoption registry"); }
      let count = 0;
      for (const [name, entry] of Object.entries(registry)) {
        if (entry?.adopted !== true) continue;
        const n = nodes.find(n => n.node_id === entry.node_id && n.alias === name && n.lifecycle_daemon_node_id);
        if (!n || (daemonRef && n.lifecycle_daemon_node_id !== daemonRef)) continue;
        deps.print(`${name} ${n.node_id} adopted by ${n.lifecycle_daemon_node_id}; workdir=${entry.workdir}`); count++;
      }
      if (!count) deps.print("No active adopted nodes in this registry. Run from the daemon workdir; --daemon takes a node id.");
      return 0;
    }
    const workdir = realpathSync(deps.cwd);
    const profiles: any[] = [];
    if (verb === "adopt") {
      const dir = join(workdir, ".anet/nodes");
      for (const id of readdirSync(dir)) {
        const nodeDir = join(dir, id), path = join(nodeDir, "config.json");
        try {
          if (lstatSync(nodeDir).isSymbolicLink() || lstatSync(path).isSymbolicLink()) continue;
          const p = JSON.parse(readFileSync(path, "utf8"));
          if (all ? p.role !== "host_supervisor" : (p.alias ?? p.node_name) === alias) profiles.push({ ...p, nodeDir });
        } catch { /* incomplete unrelated directory */ }
      }
      if (!profiles.length || (!all && profiles.length !== 1)) throw Error("Local node missing or ambiguous; run from its workdir.");
    } else {
      const matches = nodes.filter(n => n.alias === alias);
      if (matches.length !== 1) throw Error("Hub alias missing or ambiguous");
      profiles.push(matches[0]);
    }
    let daemon: any;
    if (verb === "adopt") {
      const rows: any[] = (await get(`/api/host-supervisors?${query}`)).daemons ?? [];
      const matches = rows.filter(d => daemonRef ? d.daemon_node_id === daemonRef || d.alias === daemonRef : profiles.every(p => {
        const n = nodes.find(n => n.node_id === p.node_id); return n?.hostname && n.hostname === d.hostname;
      }));
      if (matches.length !== 1) throw Error("Select exactly one daemon with --daemon <id-or-alias>");
      daemon = matches[0];
    }
    // Plan every target before dispatching any request.
    for (const p of profiles) {
      if (!p.node_id || !nodes.some(n => n.node_id === p.node_id)) throw Error("Local identity is not in the selected Hub network");
      if (verb === "adopt" && (p.network_id !== login.network_id || String(p.hub).replace(/\/+$/, "") !== hub)) throw Error("Local Hub/network identity mismatch");
      deps.print(`${verb}: ${p.alias ?? p.node_name} (${p.node_id}); workdir=${workdir}; HOME=${deps.home}`);
      if (daemon) {
        let pid = "stopped", mode = "tmux (on next start)";
        try {
          const raw = readFileSync(join(p.nodeDir, ".pid"), "utf8").trim();
          if (!/^\d+$/.test(raw) || Number(raw) <= 1) throw Error("invalid PID file");
          const env = readFileSync(`/proc/${raw}/environ`, "utf8").split("\0");
          pid = raw; mode = env.some(v => v.startsWith("TMUX=")) ? "tmux" : "bare";
        } catch (e: any) { if (e.code !== "ENOENT") { pid = "unverified"; mode = "unverified"; } }
        deps.print(`daemon=${daemon.daemon_node_id}; runtime=${p.runtime ?? "default"}; PID=${pid}; mode=${mode} (local hint, daemon rechecks)`);
        deps.print("Future anet pin/version is not exposed by Hub; verify the daemon's configured ANET_BIN_ABS before enabling lifecycle control.");
      }
    }
    if (!yes) { deps.print("Plan only. Re-run with --yes to request binding; no process will be restarted."); return 0; }
    for (const p of profiles) {
      const result = await call(verb === "adopt" ? "request_adopt_node" : "unadopt_node", verb === "adopt"
        ? { node_id: p.node_id, daemon_node_id: daemon.daemon_node_id, workdir } : { node_id: p.node_id });
      deps.print(verb === "adopt" ? `Pending daemon verification: ${result.request_id}. Not yet adopted; check Hub state.` : `Binding revoked: ${p.node_id}. Node was not stopped.`);
    }
    return 0;
  } catch (e: any) { deps.print(`Adoption failed: ${e.message}`); return 1; }
}
