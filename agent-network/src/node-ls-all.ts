/**
 * #562 step 1 — `anet node ls --all`: every node the Hub shows the logged-in user in one
 * network, grouped by machine (hostname), plus whether that machine has a live daemon
 * (role=host_supervisor) — i.e. whether it could be managed remotely later.
 *
 * Read-only. Pure functions here; the HTTP calls live in bin/cli.ts (nodeLsAllCommand).
 *
 * Inputs are exactly what the Hub returns to this user:
 *   GET /api/status?network_id=…          sessions (full projection: host.hostname, model, last_seen_at)
 *   GET /api/host-supervisors?network_id=…  daemons (hostname, online, last_seen_at)
 * Nothing is filtered or widened client-side: a restricted member sees the rows the Hub gives them.
 *
 * 🔴 The Hub answers /api/host-supervisors with `daemons: []` for a member whose agent access is
 *    restricted — the same body as "this network has no daemon". The CLI cannot tell the two
 *    apart, so an empty list is rendered as "none visible", never as a flat "no daemon".
 */
import { displayWidth, padDisplayEnd } from "./display-width";
import { parseHubTimestamp } from "./offline-age";
import { classifySessionStatus, type SessionClass } from "./session-status-class";

export const UNKNOWN_HOST = "(unknown host)";

export type NodeLsAllArgs = { all: boolean; json: boolean; network: string | null; error: string | null };

/** `--all`, `--json`, `--network <id|name>` (also `--network=<v>`). */
export function parseNodeLsAllArgs(argv: string[]): NodeLsAllArgs {
  const out: NodeLsAllArgs = { all: false, json: false, network: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--json") out.json = true;
    else if (a === "--network") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) { out.error = "--network needs a value: --network <id|name>"; continue; }
      out.network = v; i++;
    } else if (a.startsWith("--network=")) {
      const v = a.slice("--network=".length);
      if (!v) { out.error = "--network needs a value: --network <id|name>"; continue; }
      out.network = v;
    }
  }
  return out;
}

export type HubNetwork = { network_id: string; network_name?: string | null; member_role?: string | null };

export type NetworkPick =
  | { ok: true; network: HubNetwork }
  | { ok: false; error: string };

/**
 * Same matching as `anet network use <name>` (exact id or exact name), plus a unique id prefix
 * because `anet network ls` prints 12-character id prefixes. Ambiguity is refused, never guessed.
 */
export function pickNetwork(networks: HubNetwork[], ref: string | null, currentId: string | null | undefined): NetworkPick {
  const list = Array.isArray(networks) ? networks.filter(n => n && typeof n.network_id === "string") : [];
  if (!ref) {
    if (!currentId) return { ok: false, error: "no current network; run: anet login (or pass --network <id|name>)" };
    const cur = list.find(n => n.network_id === currentId);
    if (!cur) return { ok: false, error: `the current network ${currentId} is not one the hub lists for you; run: anet network ls` };
    return { ok: true, network: cur };
  }
  const exact = list.find(n => n.network_id === ref) ?? null;
  if (exact) return { ok: true, network: exact };
  const byName = list.filter(n => n.network_name === ref);
  if (byName.length === 1) return { ok: true, network: byName[0] };
  if (byName.length > 1) return { ok: false, error: `network name "${ref}" matches ${byName.length} networks; pass the id instead (anet network ls)` };
  const byPrefix = list.filter(n => n.network_id.startsWith(ref));
  if (byPrefix.length === 1) return { ok: true, network: byPrefix[0] };
  if (byPrefix.length > 1) return { ok: false, error: `network id prefix "${ref}" is ambiguous; pass more characters (anet network ls)` };
  return { ok: false, error: `no network "${ref}" among the ${list.length} network(s) you can see; run: anet network ls` };
}

export type DaemonState = "online" | "offline" | "none-visible" | "unknown";

export type MachineNode = {
  alias: string;
  node_id: string | null;
  runtime: string | null;
  status: string | null;
  status_class: SessionClass;
  last_seen_at: string | null;
  model: string | null;
};

export type MachineDaemon = { alias: string; online: boolean; last_seen_at: string | null };

export type MachineGroup = {
  hostname: string | null;
  /** online = at least one daemon on this host is online (remote management possible). */
  daemon: DaemonState;
  daemons: MachineDaemon[];
  nodes: MachineNode[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const hostKey = (h: string | null): string => (h ? h.toLowerCase() : "\u0000unknown");

/**
 * @param daemons the Hub's daemon list, or null when it could not be read (state "unknown").
 *                An empty array means "the Hub showed you none" (state "none-visible").
 */
export function groupNodesByMachine(sessions: any[], daemons: any[] | null): MachineGroup[] {
  const groups = new Map<string, MachineGroup>();
  const groupFor = (hostname: string | null): MachineGroup => {
    const k = hostKey(hostname);
    let g = groups.get(k);
    if (!g) { g = { hostname, daemon: daemons === null ? "unknown" : "none-visible", daemons: [], nodes: [] }; groups.set(k, g); }
    return g;
  };

  const daemonAliases = new Set<string>();
  for (const d of daemons ?? []) {
    const alias = str(d?.alias);
    if (!alias) continue;
    daemonAliases.add(alias);
    const g = groupFor(str(d?.hostname));
    g.daemons.push({ alias, online: d?.online === true, last_seen_at: str(d?.last_seen_at) });
  }

  for (const s of Array.isArray(sessions) ? sessions : []) {
    const alias = str(s?.alias);
    if (!alias) continue;
    // The daemon's own session is shown on the machine line, not as a work node.
    if (daemonAliases.has(alias)) continue;
    const g = groupFor(str(s?.host?.hostname) ?? str(s?.hostname));
    g.nodes.push({
      alias,
      node_id: str(s?.node_id),
      runtime: str(s?.runtime) ?? str(s?.agent),
      status: str(s?.status),
      status_class: classifySessionStatus(s?.status),
      last_seen_at: str(s?.last_seen_at) ?? str(s?.updated_at),
      model: str(s?.model),
    });
  }

  for (const g of groups.values()) {
    if (g.daemons.length > 0) g.daemon = g.daemons.some(d => d.online) ? "online" : "offline";
    g.daemons.sort((a, b) => a.alias.localeCompare(b.alias));
    g.nodes.sort((a, b) => a.alias.localeCompare(b.alias));
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.hostname !== !b.hostname) return a.hostname ? -1 : 1; // unknown host last
    return (a.hostname ?? "").localeCompare(b.hostname ?? "");
  });
}

/** Compact English age for a table cell. Unparseable → "?", future → "in Ns (clock skew?)". */
export function shortAgo(raw: string | null, nowMs: number): string {
  if (!raw) return "-";
  const ms = parseHubTimestamp(raw);
  if (ms === null) return "?";
  const d = nowMs - ms;
  if (d < 0) return `in ${Math.round(-d / 1000)}s (clock skew?)`;
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function daemonLabel(g: MachineGroup, nowMs: number): string {
  switch (g.daemon) {
    case "online": {
      const on = g.daemons.filter(d => d.online).map(d => d.alias);
      return `daemon: ${on.join(", ")} online — remote-manageable`;
    }
    case "offline": {
      const d = g.daemons[0];
      return `daemon: ${g.daemons.map(x => x.alias).join(", ")} offline (last seen ${shortAgo(d.last_seen_at, nowMs)})`;
    }
    case "none-visible": return "daemon: none visible";
    default: return "daemon: unknown";
  }
}

export type FormatOpts = {
  network: HubNetwork;
  nowMs: number;
  /** why the daemon list could not be read (daemons === null) */
  daemonsError?: string | null;
};

export function formatMachineGroups(groups: MachineGroup[], opts: FormatOpts): string[] {
  const lines: string[] = [];
  const nodeCount = groups.reduce((n, g) => n + g.nodes.length, 0);
  const netName = opts.network.network_name || opts.network.network_id;
  lines.push("");
  lines.push(`Network: ${netName} (${opts.network.network_id.slice(0, 12)}) — ${nodeCount} node(s) on ${groups.length} machine(s)`);
  if (groups.length === 0) {
    lines.push("");
    lines.push("  The hub shows you no nodes in this network.");
    lines.push("");
    return lines;
  }
  const allNodes = groups.flatMap(g => g.nodes);
  const aliasW = Math.max(5, ...allNodes.map(n => displayWidth(n.alias)));
  const runtimeW = Math.max(7, ...allNodes.map(n => displayWidth(n.runtime ?? "-")));
  const statusW = Math.max(6, ...allNodes.map(n => displayWidth(n.status ?? "-")));
  const seenW = Math.max(9, ...allNodes.map(n => displayWidth(shortAgo(n.last_seen_at, opts.nowMs))));
  const row = (a: string, r: string, s: string, l: string, m: string) =>
    `    ${padDisplayEnd(a, aliasW)}  ${padDisplayEnd(r, runtimeW)}  ${padDisplayEnd(s, statusW)}  ${padDisplayEnd(l, seenW)}  ${m}`.trimEnd();

  for (const g of groups) {
    lines.push("");
    lines.push(`  ${g.hostname ?? UNKNOWN_HOST}   ${daemonLabel(g, opts.nowMs)}`);
    if (g.nodes.length === 0) { lines.push("    (no nodes visible on this machine)"); continue; }
    lines.push(row("ALIAS", "RUNTIME", "STATUS", "LAST SEEN", "MODEL"));
    for (const n of g.nodes) {
      lines.push(row(n.alias, n.runtime ?? "-", n.status ?? "-", shortAgo(n.last_seen_at, opts.nowMs), n.model ?? "-"));
    }
  }
  lines.push("");
  if (groups.every(g => g.daemon === "none-visible")) {
    lines.push("  No daemon is visible to you: either none is registered in this network, or the hub");
    lines.push("  hides daemons from members whose agent access is restricted.");
    lines.push("");
  } else if (groups.some(g => g.daemon === "unknown")) {
    lines.push(`  Could not read daemons${opts.daemonsError ? `: ${opts.daemonsError}` : ""}.`);
    lines.push("");
  }
  return lines;
}

export function machineGroupsJson(groups: MachineGroup[], opts: { network: HubNetwork; daemonsError?: string | null }) {
  return {
    network: { network_id: opts.network.network_id, network_name: opts.network.network_name ?? null },
    daemons_readable: !groups.some(g => g.daemon === "unknown") && !opts.daemonsError,
    ...(opts.daemonsError ? { daemons_error: opts.daemonsError } : {}),
    machines: groups.map(g => ({
      hostname: g.hostname,
      daemon: g.daemon,
      daemons: g.daemons,
      nodes: g.nodes,
    })),
  };
}
