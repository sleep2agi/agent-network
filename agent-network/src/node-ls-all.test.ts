import { describe, test, expect } from "bun:test";
import {
  formatMachineGroups, groupNodesByMachine, machineGroupsJson, parseNodeLsAllArgs, pickNetwork, shortAgo,
} from "./node-ls-all";

// Hub timestamps are UTC without a zone marker.
const NOW = Date.parse("2026-10-05T12:00:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString().replace("T", " ").slice(0, 19);

const sessions = [
  { alias: "a-writer", node_id: "n_aw", runtime: "codex-app-server", status: "working", model: "gpt-x", last_seen_at: at(60), host: { hostname: "host-alpha" } },
  { alias: "a-coder", node_id: "n_ac", runtime: "claude-agent-sdk", status: "idle", model: "claude-x", last_seen_at: at(12), host: { hostname: "host-alpha" } },
  { alias: "b-runner", node_id: "n_br", runtime: null, agent: "grok-build-cli", status: "offline", model: null, last_seen_at: at(3 * 86400), host: { hostname: "host-beta" } },
  { alias: "alpha-daemon", node_id: "n_ad", runtime: "claude-agent-sdk", status: "idle", last_seen_at: at(5), host: { hostname: "host-alpha" } },
  { alias: "nowhere", node_id: "n_nw", runtime: "claude-agent-sdk", status: "idle", last_seen_at: at(5), host: { hostname: null } },
];
const daemons = [{ alias: "alpha-daemon", hostname: "host-alpha", online: true, last_seen_at: at(5) }];
const NET = { network_id: "net_0123456789abcdef", network_name: "team" };

describe("#562 groupNodesByMachine", () => {
  test("groups by hostname, sorted, unknown host last, nodes sorted by alias", () => {
    const g = groupNodesByMachine(sessions, daemons);
    expect(g.map(x => x.hostname)).toEqual(["host-alpha", "host-beta", null]);
    expect(g[0].nodes.map(n => n.alias)).toEqual(["a-coder", "a-writer"]);
    expect(g[1].nodes.map(n => n.alias)).toEqual(["b-runner"]);
  });

  test("the daemon is on the machine line, not a node row; its machine is remote-manageable", () => {
    const g = groupNodesByMachine(sessions, daemons);
    expect(g[0].daemon).toBe("online");
    expect(g[0].daemons.map(d => d.alias)).toEqual(["alpha-daemon"]);
    expect(g.flatMap(x => x.nodes).some(n => n.alias === "alpha-daemon")).toBe(false);
    expect(g[1].daemon).toBe("none-visible");
  });

  test("runtime falls back to the raw agent field", () => {
    const g = groupNodesByMachine(sessions, daemons);
    expect(g[1].nodes[0].runtime).toBe("grok-build-cli");
  });

  test("an empty daemon list is 'none-visible', an unreadable one is 'unknown' — never a flat 'no'", () => {
    expect(groupNodesByMachine(sessions, []).every(x => x.daemon === "none-visible")).toBe(true);
    expect(groupNodesByMachine(sessions, null).every(x => x.daemon === "unknown")).toBe(true);
  });

  test("an offline daemon does not make its machine manageable", () => {
    const g = groupNodesByMachine(sessions, [{ ...daemons[0], online: false }]);
    expect(g[0].daemon).toBe("offline");
  });

  test("a machine with only a daemon still appears", () => {
    const g = groupNodesByMachine([], [{ alias: "gamma-daemon", hostname: "host-gamma", online: true, last_seen_at: at(1) }]);
    expect(g).toHaveLength(1);
    expect(g[0].hostname).toBe("host-gamma");
    expect(g[0].nodes).toEqual([]);
  });

  test("hostname matching is case-insensitive", () => {
    const g = groupNodesByMachine([{ alias: "x", status: "idle", host: { hostname: "Host-Alpha" } }], daemons);
    expect(g).toHaveLength(1);
    expect(g[0].daemon).toBe("online");
  });
});

describe("#562 formatMachineGroups", () => {
  test("renders machine headers with daemon state and one row per node", () => {
    const out = formatMachineGroups(groupNodesByMachine(sessions, daemons), { network: NET, nowMs: NOW }).join("\n");
    expect(out).toContain("Network: team (net_01234567) — 4 node(s) on 3 machine(s)");
    expect(out).toContain("host-alpha   daemon: alpha-daemon online — remote-manageable");
    expect(out).toContain("host-beta   daemon: none visible");
    expect(out).toContain("(unknown host)");
    expect(out).toMatch(/a-coder\s+claude-agent-sdk\s+idle\s+12s ago\s+claude-x/);
    expect(out).toMatch(/a-writer\s+codex-app-server\s+working\s+1m ago\s+gpt-x/);
    expect(out).toMatch(/b-runner\s+grok-build-cli\s+offline\s+3d ago\s+-/);
    // the host-alpha block lists its nodes before host-beta's header
    expect(out.indexOf("a-writer")).toBeLessThan(out.indexOf("host-beta"));
  });

  test("when no daemon is visible at all, says why it may be hidden", () => {
    const out = formatMachineGroups(groupNodesByMachine(sessions, []), { network: NET, nowMs: NOW }).join("\n");
    expect(out).toContain("hides daemons from members whose agent access is restricted");
  });

  test("an unreadable daemon list is reported with its reason", () => {
    const out = formatMachineGroups(groupNodesByMachine(sessions, null), { network: NET, nowMs: NOW, daemonsError: "HTTP 500" }).join("\n");
    expect(out).toContain("daemon: unknown");
    expect(out).toContain("Could not read daemons: HTTP 500.");
  });

  test("no nodes at all", () => {
    const out = formatMachineGroups([], { network: NET, nowMs: NOW }).join("\n");
    expect(out).toContain("0 node(s) on 0 machine(s)");
    expect(out).toContain("The hub shows you no nodes in this network.");
  });

  test("json carries the same grouping", () => {
    const j = machineGroupsJson(groupNodesByMachine(sessions, daemons), { network: NET });
    expect(j.network).toEqual({ network_id: NET.network_id, network_name: "team" });
    expect(j.daemons_readable).toBe(true);
    expect(j.machines.map(m => [m.hostname, m.daemon, m.nodes.length])).toEqual([
      ["host-alpha", "online", 2], ["host-beta", "none-visible", 1], [null, "none-visible", 1],
    ]);
    const j2 = machineGroupsJson(groupNodesByMachine(sessions, null), { network: NET, daemonsError: "x" });
    expect(j2.daemons_readable).toBe(false);
    expect(j2.daemons_error).toBe("x");
  });
});

describe("#562 shortAgo", () => {
  test("reads hub UTC timestamps without a zone as UTC", () => {
    expect(shortAgo(at(30), NOW)).toBe("30s ago");
    expect(shortAgo(at(7200), NOW)).toBe("2h ago");
    expect(shortAgo(null, NOW)).toBe("-");
    expect(shortAgo("garbage", NOW)).toBe("?");
    expect(shortAgo(at(-30), NOW)).toContain("clock skew");
  });
});

describe("#562 parseNodeLsAllArgs / pickNetwork", () => {
  test("flags", () => {
    expect(parseNodeLsAllArgs(["node", "ls", "--all", "--json", "--network", "team"]))
      .toEqual({ all: true, json: true, network: "team", error: null });
    expect(parseNodeLsAllArgs(["node", "ls", "--all", "--network=net_1"]).network).toBe("net_1");
    expect(parseNodeLsAllArgs(["node", "ls", "--all", "--network"]).error).toContain("--network needs a value");
    expect(parseNodeLsAllArgs(["node", "ls", "--all", "--network", "--json"]).error).toContain("--network needs a value");
    expect(parseNodeLsAllArgs(["node", "ls"]).all).toBe(false);
  });

  const nets = [
    { network_id: "net_aaaa1111", network_name: "team" },
    { network_id: "net_aaaa2222", network_name: "dup" },
    { network_id: "net_bbbb3333", network_name: "dup" },
  ];
  test("default = the current network from anet login", () => {
    const p = pickNetwork(nets, null, "net_aaaa1111");
    expect(p.ok && p.network.network_name).toBe("team");
    expect(pickNetwork(nets, null, null).ok).toBe(false);
    expect(pickNetwork(nets, null, "net_gone").ok).toBe(false);
  });
  test("by id, by name, by unique id prefix; ambiguity refused", () => {
    expect((pickNetwork(nets, "net_bbbb3333", null) as any).network.network_id).toBe("net_bbbb3333");
    expect((pickNetwork(nets, "team", null) as any).network.network_id).toBe("net_aaaa1111");
    expect((pickNetwork(nets, "net_bbbb", null) as any).network.network_id).toBe("net_bbbb3333");
    expect(pickNetwork(nets, "dup", null).ok).toBe(false);
    expect(pickNetwork(nets, "net_aaaa", null).ok).toBe(false);
    expect(pickNetwork(nets, "nope", null).ok).toBe(false);
  });
});
