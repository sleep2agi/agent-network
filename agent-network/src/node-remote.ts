/**
 * #562 step 2 — remote lifecycle: act on a node that lives on ANOTHER machine.
 *
 *   anet node start   <alias> --remote [--network <id|name>] [--yes] [--wait <s>]
 *   anet node stop    <alias> --remote [--network <id|name>] [--yes] [--wait <s>] [--force]
 *   anet node restart <alias> --remote [--network <id|name>] [--yes] [--wait <s>]
 *   anet node edit    <alias> --model <id> --remote [--network <id|name>] [--yes] [--wait <s>]
 *
 * Nothing new on the Hub: these are the same MCP tools the app calls (POST /mcp tools/call):
 *   start   → start_node          Hub → that machine's daemon (host_supervisor) spawns the child
 *   stop    → stop_node           Hub → that machine's daemon stops the child
 *   restart → restart_node        Hub → the node itself drains + exits 75; its `anet node start`
 *                                 wrapper respawns it (whoever ran that wrapper: a daemon or a person)
 *   edit    → update_node_config  same doorbell; a model change is restart-tier
 * Permission checks are the Hub's (canWrite: member+, not viewer, not agent-restricted); this
 * module never decides who may do what — it only refuses what cannot work, BEFORE dispatching:
 *   start/stop (need the machine's daemon):
 *   - no online daemon on the node's machine          → "this machine can't be managed remotely"
 *   - the node was not created by a daemon            → the Hub keeps no daemon for it
 *   - the daemon that created it is offline
 *   restart/edit (#570 — no daemon involved, the Hub pushes to the node itself):
 *   - the node is not running                         → nothing would receive the doorbell
 *   - it does not report config_update_capable        → no exit-75 supervisor: it would just die
 *
 * Pure functions here; the HTTP calls live in bin/cli.ts (nodeRemoteCommand).
 */
import type { PlannedCommand } from "./codex-menu";
import { classifySessionStatus } from "./session-status-class";

export type RemoteVerb = "start" | "stop" | "restart" | "edit";
export const REMOTE_VERBS: readonly RemoteVerb[] = ["start", "stop", "restart", "edit"];

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;

export type RemoteArgs = {
  verb: RemoteVerb;
  alias: string | null;
  network: string | null;
  model: string | null;
  yes: boolean;
  force: boolean;
  waitSeconds: number;
  error: string | null;
};

/** True when this `anet node <verb> …` invocation is the remote form. */
export function isRemoteInvocation(argv: string[]): boolean {
  return argv.includes("--remote");
}

const VALUE_FLAGS = new Set(["--network", "--model", "--wait"]);
const BOOL_FLAGS = new Set(["--remote", "--yes", "-y", "--force"]);

/**
 * @param argv everything after `anet node <verb>` (the verb itself excluded).
 * Unknown flags are refused: a local-only flag (`--tmux`, `--copresence`, `--runtime` …) silently
 * ignored on a remote node would be a lie about what was done.
 */
export function parseRemoteArgs(verb: RemoteVerb, argv: string[]): RemoteArgs {
  const out: RemoteArgs = { verb, alias: null, network: null, model: null, yes: false, force: false, waitSeconds: DEFAULT_WAIT_SECONDS, error: null };
  const fail = (m: string) => { if (!out.error) out.error = m; };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline: string | null = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    if (BOOL_FLAGS.has(a)) {
      if (inline !== null) { fail(`${a} takes no value`); continue; }
      if (a === "--yes" || a === "-y") out.yes = true;
      else if (a === "--force") out.force = true;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      let v = inline;
      if (v === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) { fail(`${a} needs a value`); continue; }
        v = next; i++;
      }
      if (!v) { fail(`${a} needs a value`); continue; }
      if (a === "--network") out.network = v;
      else if (a === "--model") out.model = v;
      else {
        if (!/^\d+$/.test(v) || Number(v) > MAX_WAIT_SECONDS) { fail(`--wait takes whole seconds 0-${MAX_WAIT_SECONDS} (0 = don't wait)`); continue; }
        out.waitSeconds = Number(v);
      }
      continue;
    }
    if (a.startsWith("-")) { fail(`${a} is not supported with --remote (it only applies to a node on this machine)`); continue; }
    positionals.push(a);
  }
  if (positionals.length === 0) fail(`which node? Usage: anet node ${verb} <alias>${verb === "edit" ? " --model <id>" : ""} --remote`);
  else if (positionals.length > 1) fail(`one node at a time (got ${positionals.map((p) => `"${p}"`).join(", ")})`);
  else out.alias = positionals[0];
  if (out.force && verb !== "stop") fail("--force only applies to stop (stop a node that still has tasks in flight)");
  if (verb === "edit") {
    if (out.model === null) fail("--remote edit only changes the model: anet node edit <alias> --model <id> --remote");
    else if (/\s/.test(out.model) || out.model.length > 200) fail("--model must be one id, no whitespace, at most 200 characters");
  } else if (out.model !== null) fail(`--model only applies to edit (anet node edit <alias> --model <id> --remote)`);
  return out;
}

// ── target resolution ─────────────────────────────────────────────────────

export type HubNodeRow = {
  node_id: string;
  alias: string;
  hostname?: string | null;
  role?: string | null;
  lifecycle_state?: string | null;
  lifecycle_controllable?: boolean;
  lifecycle_daemon_node_id?: string | null;
  model?: string | null;
};
export type HubSession = { alias?: string; node_id?: string | null; status?: string | null; hostname?: string | null; host?: { hostname?: string | null } | null; last_seen_at?: string | null; updated_at?: string | null; model?: string | null };
/** GET /api/host-supervisors row: the daemon's node id is `daemon_node_id` (not `node_id`). */
export type HubDaemon = { daemon_node_id?: string; alias?: string; hostname?: string | null; online?: boolean; last_seen_at?: string | null };

export type RemoteTarget = {
  node_id: string;
  alias: string;
  hostname: string | null;
  lifecycle_state: string;
  session_status: string | null;
  session_seen: string | null;
  model: string | null;
  /** The daemon that created the node (start/stop go through it). null = not daemon-managed: only
   *  restart/edit resolve without one. `online` is false only for restart/edit (they don't need it). */
  daemon: { node_id: string; alias: string; online: boolean } | null;
};

export type ResolveResult =
  | { ok: true; target: RemoteTarget }
  | { ok: false; code: "not_found" | "is_daemon" | "daemons_not_visible" | "no_daemon_on_host" | "not_daemon_managed" | "creator_daemon_offline"; message: string };

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const sameHost = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * @param nodes    GET /api/nodes?alias=<alias>&network_id=<net>  (rows; newest first)
 * @param sessions GET /api/status?network_id=<net>                (sessions)
 * @param daemons  GET /api/host-supervisors?network_id=<net>      (daemons; [] = none visible)
 */
export function resolveRemoteTarget(verb: RemoteVerb, alias: string, nodes: HubNodeRow[], sessions: HubSession[], daemons: HubDaemon[]): ResolveResult {
  const session = (Array.isArray(sessions) ? sessions : []).find((x) => s(x?.alias) === alias) ?? null;
  const rows = (Array.isArray(nodes) ? nodes : []).filter((n) => n && s(n.alias) === alias && s(n.node_id));
  // One alias can own several rows (re-created nodes); the live one is the row the session points at.
  const node = rows.find((n) => session && n.node_id === s(session.node_id)) ?? rows[0] ?? null;
  if (!node) {
    return { ok: false, code: "not_found", message: `no node "${alias}" in this network that the hub shows you (see: anet node ls --all)` };
  }
  if (node.role === "host_supervisor") {
    return { ok: false, code: "is_daemon", message: `"${alias}" is a daemon (host_supervisor), not a work node; manage it on its own machine with anet daemon …` };
  }
  const hostname = s(session?.host?.hostname) ?? s(session?.hostname) ?? s(node.hostname);
  const hostLabel = hostname ?? "(unknown host)";
  const all = Array.isArray(daemons) ? daemons.filter((d) => d && s(d.daemon_node_id)) : [];
  const creatorId = node.lifecycle_controllable === true ? s(node.lifecycle_daemon_node_id) : null;
  const creator = creatorId ? all.find((d) => d.daemon_node_id === creatorId) ?? null : null;
  const target = (daemon: RemoteTarget["daemon"]): ResolveResult => ({
    ok: true,
    target: {
      node_id: node.node_id,
      alias,
      hostname,
      lifecycle_state: s(node.lifecycle_state) ?? "active",
      session_status: s(session?.status),
      session_seen: s(session?.last_seen_at) ?? s(session?.updated_at),
      model: s(session?.model) ?? s(node.model),
      daemon,
    },
  });
  // #570 — restart/edit never touch a daemon: the Hub pushes them to the node itself and the node's
  // own `anet node start` wrapper respawns it (exit 75). Whether that wrapper exists is precheck's
  // job (config_update_capable), not the daemon's. The creator, if any, is kept only for display.
  if (verb === "restart" || verb === "edit") {
    return target(creator ? { node_id: creator.daemon_node_id!, alias: s(creator.alias) ?? creator.daemon_node_id!, online: creator.online === true } : null);
  }
  if (all.length === 0) {
    return {
      ok: false, code: "daemons_not_visible",
      message: `this machine can't be managed remotely by you: the hub shows you no daemon on ${hostLabel} — either none is registered, or your agent access in this network is restricted (restricted members can't manage nodes; ask a network admin)`,
    };
  }
  const onHost = all.filter((d) => sameHost(s(d.hostname), hostname));
  if (!onHost.some((d) => d.online === true)) {
    const off = onHost.map((d) => d.alias).filter(Boolean);
    return {
      ok: false, code: "no_daemon_on_host",
      message: `this machine can't be managed remotely: no daemon online on ${hostLabel}${off.length ? ` (${off.join(", ")} is offline)` : ""}. On that machine: anet daemon start`,
    };
  }
  if (!creatorId) {
    return {
      ok: false, code: "not_daemon_managed",
      message: `"${alias}" on ${hostLabel} was not created by a daemon, so the hub has no daemon that can start/stop it. Manage it on that machine (anet node … ${alias}), or re-create it through the daemon (app → new node → that machine)`,
    };
  }
  if (!creator || creator.online !== true) {
    return {
      ok: false, code: "creator_daemon_offline",
      message: `"${alias}" belongs to daemon ${creator?.alias ?? creatorId}, which is ${creator ? "offline" : "not visible to you"}; only that daemon can manage it`,
    };
  }
  return target({ node_id: creator.daemon_node_id!, alias: s(creator.alias) ?? creator.daemon_node_id!, online: true });
}

// ── per-verb precheck (state the hub already shows) ────────────────────────

export type Precheck = { kind: "go" } | { kind: "noop"; message: string } | { kind: "refuse"; message: string };

export function isRunning(t: RemoteTarget): boolean {
  return t.lifecycle_state === "active" && classifySessionStatus(t.session_status) !== "offline" && !!t.session_status;
}

export function precheck(verb: RemoteVerb, t: RemoteTarget, cfg?: { config_update_capable?: boolean } | null): Precheck {
  const st = t.lifecycle_state;
  if (verb === "start") {
    if (st === "stopped" || st === "starting") return { kind: "go" };
    if (isRunning(t)) return { kind: "noop", message: `"${t.alias}" is already running on ${t.hostname ?? "its machine"} — nothing to do` };
    if (st === "active") return { kind: "refuse", message: `"${t.alias}" is offline but the hub still records it as active (it was not stopped through the hub), so start_node refuses it. Stop it first: anet node stop ${t.alias} --remote` };
    return { kind: "refuse", message: `"${t.alias}" is ${st}; it can be started only from stopped` };
  }
  if (verb === "stop") {
    if (st === "stopped") return { kind: "noop", message: `"${t.alias}" is already stopped — nothing to do` };
    if (st !== "active") return { kind: "refuse", message: `"${t.alias}" is ${st}; wait for that to finish (anet node ls --all)` };
    return { kind: "go" };
  }
  // restart / edit are delivered to the node itself — it must be up to receive them.
  if (!isRunning(t)) {
    return { kind: "refuse", message: `"${t.alias}" is not running (${st}${t.session_status ? `, ${t.session_status}` : ""}); ${verb === "restart" ? "start it instead" : "start it first"}: anet node start ${t.alias} --remote` };
  }
  // #570 — the node applies both by exiting 75 and relying on its supervisor to respawn it. Only an
  // `anet node start` wrapper does that, and it says so with config_update_capable=true. Anything
  // else (a bare agent-node under pm2/systemd, an agent-node too old to report it, no config read)
  // would simply exit and stay down — so refuse up front, for restart as much as for edit.
  if (cfg?.config_update_capable !== true) {
    const what = verb === "restart" ? "restarted remotely" : "switched to another model remotely (that needs a restart)";
    return { kind: "refuse", message: `"${t.alias}" can't be ${what}: it doesn't support config updates (started without \`anet node start\`?); ${verb === "restart" ? "restart it" : "change it"} on its machine (${t.hostname ?? "unknown host"})` };
  }
  return { kind: "go" };
}

// ── plan: what will be done + the equivalent command ───────────────────────

export function remoteCommandArgv(a: { verb: RemoteVerb; alias: string; networkId: string; model?: string | null; force?: boolean }): string[] {
  const argv = ["anet", "node", a.verb, a.alias];
  if (a.verb === "edit" && a.model) argv.push("--model", a.model);
  argv.push("--remote", "--network", a.networkId);
  if (a.force) argv.push("--force");
  argv.push("--yes");
  return argv;
}

export function describePlan(verb: RemoteVerb, t: RemoteTarget, model?: string | null): string {
  const where = t.hostname ?? "(unknown host)";
  switch (verb) {
    case "start": return `ask the hub to have daemon ${t.daemon?.alias ?? "?"} on ${where} start "${t.alias}"`;
    case "stop": return `ask the hub to have daemon ${t.daemon?.alias ?? "?"} on ${where} stop "${t.alias}" (its config is kept; start it again with --remote)`;
    case "restart": return `ask "${t.alias}" on ${where} itself, through the hub, to restart${selfNote(t)} (it finishes its current turn, exits and its \`anet node start\` respawns it)`;
    case "edit": return `ask "${t.alias}" on ${where} itself, through the hub, to switch to model ${model} (was ${t.model ?? "unknown"})${selfNote(t)}; it restarts to apply it`;
  }
}

const selfNote = (t: RemoteTarget) => (t.daemon ? "" : " (it's not managed by a daemon)");

/** The one-line "where/what" header printed before the plan. */
export function describeTarget(verb: RemoteVerb, t: RemoteTarget): string {
  const where = t.hostname ?? "(unknown host)";
  const state = `hub state: ${t.lifecycle_state}${t.session_status ? ` / ${t.session_status}` : ""}`;
  if (verb === "start" || verb === "stop") return `Node ${t.alias} — on ${where}, daemon ${t.daemon?.alias ?? "?"} online; ${state}`;
  const mgr = t.daemon ? `created by daemon ${t.daemon.alias}${t.daemon.online ? "" : " (offline — not needed for this)"}` : "not managed by a daemon";
  return `Node ${t.alias} — on ${where}, ${mgr}; ${state}`;
}

export function planRemote(a: { verb: RemoteVerb; target: RemoteTarget; networkId: string; model?: string | null; force?: boolean }): PlannedCommand {
  return {
    argv: remoteCommandArgv({ verb: a.verb, alias: a.target.alias, networkId: a.networkId, model: a.model, force: a.force }),
    note: describePlan(a.verb, a.target, a.model),
  };
}

export function toolCall(verb: RemoteVerb, t: RemoteTarget, networkId: string, opts: { model?: string | null; force?: boolean; baseRevision?: number } = {}): { name: string; arguments: Record<string, unknown> } {
  switch (verb) {
    case "start": return { name: "start_node", arguments: { child_node_id: t.node_id, network_id: networkId } };
    case "stop": return { name: "stop_node", arguments: { child_node_id: t.node_id, network_id: networkId, ...(opts.force ? { force: true } : {}) } };
    case "restart": return { name: "restart_node", arguments: { node_id: t.node_id, network_id: networkId } };
    case "edit": return { name: "update_node_config", arguments: { node_id: t.node_id, base_revision: opts.baseRevision ?? 0, patch: { model: opts.model }, network_id: networkId } };
  }
}

// ── hub refusal → one sentence ─────────────────────────────────────────────

export function explainHubRefusal(verb: RemoteVerb, alias: string, r: any): string {
  const code = typeof r?.error === "string" ? r.error : "";
  const msg = typeof r?.message === "string" ? r.message : "";
  const base = `the hub refused to ${verb} "${alias}": ${code || msg || JSON.stringify(r)}`;
  switch (code) {
    case "permission_denied":
    case "access_denied":
    case "forbidden_cross_tenant":
      return `${base}${msg ? ` (${msg})` : ""} — your role in this network can't manage nodes (viewers and members with restricted agent access can't); ask a network admin`;
    case "node_busy_in_flight":
      return `${base} — it still has ${r?.in_flight_count ?? "some"} task(s) in flight. Wait, or stop it anyway: anet node stop ${alias} --remote --force`;
    case "update_in_flight":
      return `${base} — another config change/restart is still being applied (${Math.round((r?.age_ms ?? 0) / 1000)}s old); try again in a minute`;
    case "revision_conflict":
      return `${base} — its config changed while you were editing; run the command again`;
    case "node_already_starting":
      return `${base} — a start is already in progress; check: anet node ls --all`;
    default:
      return msg && code ? `${base} (${msg})` : base;
  }
}

// ── waiting for the outcome ────────────────────────────────────────────────

export type Observation = {
  lifecycle_state: string | null;
  session_status: string | null;
  session_seen: string | null;
  config_revision: number | null;
  model: string | null;
};

export type Outcome = { state: "pending" } | { state: "done"; message: string } | { state: "failed"; message: string };

/**
 * @param before what the hub showed right before dispatch
 * @param now    what it shows now
 * Seen-times are compared as the hub's own strings (changed or not), never against this machine's
 * clock: the node is on another machine and the hub on a third.
 */
export function evaluateOutcome(verb: RemoteVerb, t: RemoteTarget, before: Observation, now: Observation, want: { model?: string | null; baseRevision?: number } = {}): Outcome {
  const where = t.hostname ?? "its machine";
  const st = now.lifecycle_state;
  if (verb === "start") {
    if (st === "stopped") return { state: "failed", message: `the daemon on ${where} could not start "${t.alias}" (hub: back to stopped). Look at the daemon's log on that machine` };
    const fresh = !!now.session_seen && now.session_seen !== before.session_seen;
    if (st === "active" && fresh && classifySessionStatus(now.session_status) !== "offline") {
      return { state: "done", message: `"${t.alias}" is up on ${where} (${now.session_status})` };
    }
    return { state: "pending" };
  }
  if (verb === "stop") {
    if (st === "stopped") return { state: "done", message: `"${t.alias}" is stopped on ${where}` };
    if (st === "stop_failed") return { state: "failed", message: `the daemon on ${where} could not stop "${t.alias}" (hub: stop_failed)` };
    return { state: "pending" };
  }
  // restart / edit: the hub promotes config_revision only when the respawned node reports in again
  // (finalize-on-report_status), so a revision past the base already means "it came back". Also require
  // that this report is visible in the session (seen moved, not offline): "done" must mean reachable.
  const base = want.baseRevision ?? before.config_revision ?? 0;
  if (now.config_revision !== null && now.config_revision > base) {
    const back = !!now.session_seen && now.session_seen !== before.session_seen && classifySessionStatus(now.session_status) !== "offline";
    if (!back) return { state: "pending" };
    if (verb === "edit" && want.model && now.model !== want.model) {
      return { state: "failed", message: `"${t.alias}" restarted but reports model ${now.model ?? "unknown"}, not ${want.model}` };
    }
    return { state: "done", message: verb === "edit" ? `"${t.alias}" on ${where} now runs model ${now.model ?? want.model}` : `"${t.alias}" restarted on ${where} (${now.session_status ?? "status unknown"})` };
  }
  return { state: "pending" };
}

/**
 * @param last the last observation before the deadline (null = none could be read). For restart/edit it
 *             tells "went down and never came back" (the supervisor did not respawn it — a real failure
 *             worth a different next step) apart from "still finishing its turn".
 */
export function timeoutMessage(verb: RemoteVerb, alias: string, seconds: number, last: Observation | null = null, host: string | null = null): string {
  const generic = `no result within ${seconds}s — the request was accepted by the hub, but it has not seen "${alias}" ${verb === "stop" ? "stop" : verb === "start" ? "come up" : "restart"} yet. It may still finish; check: anet node ls --all`;
  if ((verb === "restart" || verb === "edit") && last && classifySessionStatus(last.session_status) === "offline") {
    return `no result within ${seconds}s — "${alias}" went offline and has not come back. Its supervisor may not have respawned it; look at it on ${host ?? "its machine"} (anet node start ${alias} there). Check: anet node ls --all`;
  }
  if ((verb === "restart" || verb === "edit") && last && classifySessionStatus(last.session_status) === "working") {
    return `no result within ${seconds}s — "${alias}" is still working, and it restarts only after its current turn finishes — so it may still apply; check later: anet node ls --all`;
  }
  return generic;
}
