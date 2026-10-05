import { describe, test, expect } from "bun:test";
import {
  describeTarget, evaluateOutcome, explainHubRefusal, isRemoteInvocation, parseRemoteArgs, planRemote, precheck,
  remoteCommandArgv, resolveRemoteTarget, timeoutMessage, toolCall, type Observation, type RemoteTarget,
} from "./node-remote";

// Daemon rows have the real /api/host-supervisors shape (`daemon_node_id`, not `node_id`).
// Fixture: machine-b has an online daemon that created coder-b; hand-b was started by hand on machine-b;
// lone-c lives on machine-c, which has no daemon; orphan-b's creator daemon is offline.
const nodes = [
  { node_id: "node_cb", alias: "coder-b", hostname: "machine-b", lifecycle_state: "stopped", lifecycle_controllable: true, lifecycle_daemon_node_id: "node_db", role: null, model: "m1" },
  { node_id: "node_cb_old", alias: "coder-b", hostname: "machine-b", lifecycle_state: "active", lifecycle_controllable: true, lifecycle_daemon_node_id: "node_db", role: null },
  { node_id: "n_hand", alias: "hand-b", hostname: "machine-b", lifecycle_state: "active", lifecycle_controllable: false, lifecycle_daemon_node_id: null },
  { node_id: "node_lc", alias: "lone-c", hostname: "machine-c", lifecycle_state: "active", lifecycle_controllable: true, lifecycle_daemon_node_id: "node_dc" },
  { node_id: "node_ob", alias: "orphan-b", hostname: "machine-b", lifecycle_state: "active", lifecycle_controllable: true, lifecycle_daemon_node_id: "node_old" },
  { node_id: "node_db", alias: "daemon-b", hostname: "machine-b", role: "host_supervisor", lifecycle_controllable: true },
];
const sessions = [
  { alias: "coder-b", node_id: "node_cb", status: "offline", host: { hostname: "machine-b" }, last_seen_at: "2026-10-05 10:00:00", model: "m1" },
  { alias: "hand-b", node_id: "n_hand", status: "idle", host: { hostname: "machine-b" } },
  { alias: "lone-c", node_id: "node_lc", status: "idle", host: { hostname: "machine-c" } },
  { alias: "orphan-b", node_id: "node_ob", status: "idle", host: { hostname: "machine-b" } },
];
const daemons = [
  { daemon_node_id: "node_db", alias: "daemon-b", hostname: "machine-b", online: true },
  { daemon_node_id: "node_dc", alias: "daemon-c", hostname: "machine-c", online: false },
  { daemon_node_id: "node_old", alias: "daemon-old", hostname: "machine-x", online: false },
];
const nodesFor = (alias: string) => nodes.filter((n) => n.alias === alias);

describe("#562 parseRemoteArgs", () => {
  test("start / stop / restart: alias + flags", () => {
    expect(parseRemoteArgs("start", ["coder-b", "--remote"])).toMatchObject({ alias: "coder-b", yes: false, waitSeconds: 60, network: null, error: null });
    expect(parseRemoteArgs("stop", ["--remote", "coder-b", "--yes", "--force", "--network", "team", "--wait", "5"]))
      .toMatchObject({ alias: "coder-b", yes: true, force: true, network: "team", waitSeconds: 5, error: null });
    expect(parseRemoteArgs("restart", ["coder-b", "--remote", "-y", "--network=team", "--wait=0"])).toMatchObject({ yes: true, network: "team", waitSeconds: 0, error: null });
  });
  test("edit needs --model; others refuse it", () => {
    expect(parseRemoteArgs("edit", ["coder-b", "--model", "m2", "--remote"])).toMatchObject({ model: "m2", error: null });
    expect(parseRemoteArgs("edit", ["coder-b", "--remote"]).error).toContain("--model");
    expect(parseRemoteArgs("edit", ["coder-b", "--model", "a b", "--remote"]).error).toContain("no whitespace");
    expect(parseRemoteArgs("start", ["coder-b", "--model", "m2", "--remote"]).error).toContain("only applies to edit");
  });
  test("refusals: no alias, two aliases, local-only flags, bad --wait, --force off stop", () => {
    expect(parseRemoteArgs("start", ["--remote"]).error).toContain("which node?");
    expect(parseRemoteArgs("start", ["a", "b", "--remote"]).error).toContain("one node at a time");
    expect(parseRemoteArgs("start", ["a", "--remote", "--tmux"]).error).toContain("--tmux is not supported with --remote");
    expect(parseRemoteArgs("start", ["a", "--remote", "--wait", "abc"]).error).toContain("--wait");
    expect(parseRemoteArgs("start", ["a", "--remote", "--wait", "601"]).error).toContain("--wait");
    expect(parseRemoteArgs("start", ["a", "--remote", "--network"]).error).toContain("--network needs a value");
    expect(parseRemoteArgs("start", ["a", "--remote", "--force"]).error).toContain("--force only applies to stop");
    expect(parseRemoteArgs("start", ["a", "--remote=1"]).error).toContain("takes no value");
  });
  test("isRemoteInvocation", () => {
    expect(isRemoteInvocation(["node", "start", "a", "--remote"])).toBe(true);
    expect(isRemoteInvocation(["node", "start", "a", "--tmux"])).toBe(false);
  });
});

describe("#562 resolveRemoteTarget", () => {
  test("daemon-created node on a machine with an online daemon resolves; the session's row wins over a stale duplicate", () => {
    const r = resolveRemoteTarget("start", "coder-b", nodesFor("coder-b"), sessions, daemons);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target).toMatchObject({ node_id: "node_cb", hostname: "machine-b", lifecycle_state: "stopped", daemon: { node_id: "node_db", alias: "daemon-b", online: true } });
  });
  test("unknown alias", () => {
    const r = resolveRemoteTarget("start", "nope", [], sessions, daemons);
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });
  test("machine without an online daemon → can't be managed remotely, naming the host", () => {
    const r = resolveRemoteTarget("start", "lone-c", nodesFor("lone-c"), sessions, daemons);
    expect(r).toMatchObject({ ok: false, code: "no_daemon_on_host" });
    if (!r.ok) expect(r.message).toContain("this machine can't be managed remotely: no daemon online on machine-c (daemon-c is offline)");
  });
  test("host compare is case-insensitive", () => {
    const r = resolveRemoteTarget("start", "coder-b", nodesFor("coder-b"), sessions, [{ ...daemons[0], hostname: "Machine-B" }]);
    expect(r.ok).toBe(true);
  });
  test("no daemon visible at all (restricted member) → refusal that says why", () => {
    const r = resolveRemoteTarget("start", "coder-b", nodesFor("coder-b"), sessions, []);
    expect(r).toMatchObject({ ok: false, code: "daemons_not_visible" });
    if (!r.ok) expect(r.message).toContain("restricted");
  });
  test("a hand-started node on a daemon machine is not daemon-managed", () => {
    expect(resolveRemoteTarget("stop", "hand-b", nodesFor("hand-b"), sessions, daemons)).toMatchObject({ ok: false, code: "not_daemon_managed" });
    // the hub's explicit flag wins even if a daemon id is present
    const flagged = [{ ...nodesFor("coder-b")[0], lifecycle_controllable: false }];
    expect(resolveRemoteTarget("start", "coder-b", flagged, sessions, daemons)).toMatchObject({ ok: false, code: "not_daemon_managed" });
  });
  test("creator daemon offline even though another daemon on the host is online", () => {
    expect(resolveRemoteTarget("start", "orphan-b", nodesFor("orphan-b"), sessions, daemons)).toMatchObject({ ok: false, code: "creator_daemon_offline" });
  });
  test("a daemon itself is refused", () => {
    expect(resolveRemoteTarget("restart", "daemon-b", nodesFor("daemon-b"), sessions, daemons)).toMatchObject({ ok: false, code: "is_daemon" });
  });
});

const T = (over: Partial<RemoteTarget> = {}): RemoteTarget => ({
  node_id: "node_cb", alias: "coder-b", hostname: "machine-b", lifecycle_state: "active", session_status: "idle",
  session_seen: "2026-10-05 10:00:00", model: "m1", daemon: { node_id: "node_db", alias: "daemon-b", online: true }, ...over,
});

describe("#562 precheck", () => {
  test("start: go from stopped, noop when running, refuse active-but-offline", () => {
    expect(precheck("start", T({ lifecycle_state: "stopped", session_status: "offline" })).kind).toBe("go");
    expect(precheck("start", T()).kind).toBe("noop");
    expect(precheck("start", T({ session_status: "offline" })).kind).toBe("refuse");
  });
  test("stop: noop when stopped, refuse while stopping", () => {
    expect(precheck("stop", T()).kind).toBe("go");
    expect(precheck("stop", T({ lifecycle_state: "stopped" })).kind).toBe("noop");
    expect(precheck("stop", T({ lifecycle_state: "stopping" })).kind).toBe("refuse");
  });
  test("restart/edit need the node up and config_update_capable", () => {
    expect(precheck("restart", T(), { config_update_capable: true }).kind).toBe("go");
    expect(precheck("restart", T({ lifecycle_state: "stopped", session_status: "offline" }), { config_update_capable: true }).kind).toBe("refuse");
    expect(precheck("edit", T(), { config_update_capable: false }).kind).toBe("refuse");
    expect(precheck("edit", T(), { config_update_capable: true }).kind).toBe("go");
  });
});

describe("#562 plan + tool call", () => {
  test("the printed equivalent command is the scriptable remote form", () => {
    expect(remoteCommandArgv({ verb: "edit", alias: "coder-b", networkId: "net1", model: "m2" }))
      .toEqual(["anet", "node", "edit", "coder-b", "--model", "m2", "--remote", "--network", "net1", "--yes"]);
    const p = planRemote({ verb: "start", target: T({ lifecycle_state: "stopped" }), networkId: "net1" });
    expect(p.note).toContain("daemon daemon-b on machine-b start");
  });
  test("the hub tools the app uses, scoped to the network", () => {
    expect(toolCall("start", T(), "net1")).toEqual({ name: "start_node", arguments: { child_node_id: "node_cb", network_id: "net1" } });
    expect(toolCall("stop", T(), "net1", { force: true })).toEqual({ name: "stop_node", arguments: { child_node_id: "node_cb", network_id: "net1", force: true } });
    expect(toolCall("restart", T(), "net1")).toEqual({ name: "restart_node", arguments: { node_id: "node_cb", network_id: "net1" } });
    expect(toolCall("edit", T(), "net1", { model: "m2", baseRevision: 3 }))
      .toEqual({ name: "update_node_config", arguments: { node_id: "node_cb", base_revision: 3, patch: { model: "m2" }, network_id: "net1" } });
  });
  test("hub refusals are surfaced with the hub's code", () => {
    expect(explainHubRefusal("stop", "coder-b", { ok: false, error: "permission_denied", message: "viewer" })).toContain("permission_denied");
    expect(explainHubRefusal("stop", "coder-b", { ok: false, error: "node_busy_in_flight", in_flight_count: 2 })).toContain("--force");
  });
});

const O = (over: Partial<Observation> = {}): Observation => ({
  lifecycle_state: "active", session_status: "idle", session_seen: "2026-10-05 10:00:00", config_revision: 1, model: "m1", ...over,
});

describe("#562 evaluateOutcome", () => {
  const before = O({ lifecycle_state: "stopped", session_status: "offline" });
  test("start: done only once the node re-reported (seen changed) and is active", () => {
    expect(evaluateOutcome("start", T(), before, O({ lifecycle_state: "starting", session_status: "offline" })).state).toBe("pending");
    // active but the session is the old one → still pending
    expect(evaluateOutcome("start", T(), before, O({ session_seen: before.session_seen })).state).toBe("pending");
    expect(evaluateOutcome("start", T(), before, O({ session_seen: "2026-10-05 10:05:00" })).state).toBe("done");
    expect(evaluateOutcome("start", T(), before, O({ lifecycle_state: "stopped" })).state).toBe("failed");
  });
  test("stop: stopped → done, stop_failed → failed", () => {
    expect(evaluateOutcome("stop", T(), O(), O({ lifecycle_state: "stopping" })).state).toBe("pending");
    expect(evaluateOutcome("stop", T(), O(), O({ lifecycle_state: "stopped" })).state).toBe("done");
    expect(evaluateOutcome("stop", T(), O(), O({ lifecycle_state: "stop_failed" })).state).toBe("failed");
  });
  test("restart/edit: config revision moves past the base AND the node re-reported", () => {
    const back = { session_seen: "2026-10-05 10:01:00" };
    expect(evaluateOutcome("restart", T(), O(), O(), { baseRevision: 1 }).state).toBe("pending");
    expect(evaluateOutcome("restart", T(), O(), O({ config_revision: 2, ...back }), { baseRevision: 1 }).state).toBe("done");
    expect(evaluateOutcome("edit", T(), O(), O({ config_revision: 2, model: "m2", ...back }), { baseRevision: 1, model: "m2" }).state).toBe("done");
    expect(evaluateOutcome("edit", T(), O(), O({ config_revision: 2, model: "m1", ...back }), { baseRevision: 1, model: "m2" }).state).toBe("failed");
  });
});

// ── #570: restart / edit no longer need a daemon ──────────────────────────
// Decision table (verb × how the node was started × capability). "self" = hand-started
// (`anet node start`, no create record), "bare" = an agent-node with no exit-75 supervisor
// (pm2/systemd), which reports config_update_capable=false.
describe("#570 restart/edit without a daemon", () => {
  const capable = { config_update_capable: true };
  const resolveOk = (verb: "start" | "stop" | "restart" | "edit", alias: string, ds = daemons) => {
    const r = resolveRemoteTarget(verb, alias, nodesFor(alias), sessions, ds);
    if (!r.ok) throw new Error(`${verb} ${alias}: ${r.code} ${r.message}`);
    return r.target;
  };

  test("hand-started node: restart/edit resolve with no daemon link; start/stop still refuse", () => {
    for (const v of ["restart", "edit"] as const) {
      const t = resolveOk(v, "hand-b");
      expect(t).toMatchObject({ node_id: "n_hand", hostname: "machine-b", daemon: null, session_status: "idle" });
      expect(precheck(v, t, capable).kind).toBe("go");
    }
    for (const v of ["start", "stop"] as const) {
      expect(resolveRemoteTarget(v, "hand-b", nodesFor("hand-b"), sessions, daemons)).toMatchObject({ ok: false, code: "not_daemon_managed" });
    }
  });
  test("restart/edit need no daemon at all: none visible, none on the host, creator offline", () => {
    expect(resolveOk("restart", "hand-b", []).daemon).toBeNull();                  // restricted member sees no daemons
    expect(resolveOk("restart", "lone-c").daemon).toMatchObject({ alias: "daemon-c", online: false }); // machine-c has no online daemon
    expect(resolveOk("edit", "orphan-b").daemon).toMatchObject({ alias: "daemon-old", online: false });
    // ...while start/stop on the same nodes still refuse
    expect(resolveRemoteTarget("stop", "lone-c", nodesFor("lone-c"), sessions, daemons)).toMatchObject({ ok: false, code: "no_daemon_on_host" });
    expect(resolveRemoteTarget("start", "hand-b", nodesFor("hand-b"), sessions, [])).toMatchObject({ ok: false, code: "daemons_not_visible" });
  });
  test("a daemon itself and an unknown alias are still refused for restart/edit", () => {
    expect(resolveRemoteTarget("edit", "daemon-b", nodesFor("daemon-b"), sessions, daemons)).toMatchObject({ ok: false, code: "is_daemon" });
    expect(resolveRemoteTarget("restart", "nope", [], sessions, daemons)).toMatchObject({ ok: false, code: "not_found" });
  });
  test("not config_update_capable (bare agent-node) → restart AND edit refused up front, daemon-created or not", () => {
    for (const t of [resolveOk("restart", "hand-b"), resolveOk("restart", "coder-b")]) {
      for (const cfg of [{ config_update_capable: false }, {}, null, undefined]) {
        const r = precheck("restart", { ...t, lifecycle_state: "active", session_status: "idle" }, cfg as any);
        expect(r.kind).toBe("refuse");
        if (r.kind === "refuse") {
          expect(r.message).toContain("can't be restarted remotely: it doesn't support config updates (started without `anet node start`?)");
          expect(r.message).toContain("restart it on its machine");
        }
      }
      const e = precheck("edit", { ...t, lifecycle_state: "active", session_status: "idle" }, { config_update_capable: false });
      expect(e.kind).toBe("refuse");
      if (e.kind === "refuse") expect(e.message).toContain("it doesn't support config updates");
    }
  });
  test("not running → refused before the capability question", () => {
    const t = { ...resolveOk("restart", "hand-b"), session_status: "offline" };
    const r = precheck("restart", t, capable);
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.message).toContain("is not running");
  });
  test("plan + header say how it will be done", () => {
    const hand = resolveOk("restart", "hand-b");
    expect(planRemote({ verb: "restart", target: hand, networkId: "n" }).note).toContain(`ask "hand-b" on machine-b itself, through the hub, to restart (it's not managed by a daemon)`);
    expect(planRemote({ verb: "edit", target: hand, networkId: "n", model: "m9" }).note).toContain("to switch to model m9");
    expect(planRemote({ verb: "edit", target: hand, networkId: "n", model: "m9" }).note).toContain("(it's not managed by a daemon)");
    expect(planRemote({ verb: "restart", target: T(), networkId: "n" }).note).not.toContain("not managed by a daemon");
    expect(describeTarget("restart", hand)).toBe("Node hand-b — on machine-b, not managed by a daemon; hub state: active / idle");
    expect(describeTarget("edit", resolveOk("edit", "orphan-b"))).toContain("created by daemon daemon-old (offline — not needed for this)");
    expect(describeTarget("stop", T())).toBe("Node coder-b — on machine-b, daemon daemon-b online; hub state: active / idle");
    // the hub call is the same restart_node / update_node_config, addressed to the node
    expect(toolCall("restart", hand, "n")).toEqual({ name: "restart_node", arguments: { node_id: "n_hand", network_id: "n" } });
  });
  test("outcome: a revision bump with the session still offline/unchanged is not 'done'", () => {
    const before = O();
    expect(evaluateOutcome("restart", T(), before, O({ config_revision: 2, session_status: "offline", session_seen: "2026-10-05 10:01:00" }), { baseRevision: 1 }).state).toBe("pending");
    expect(evaluateOutcome("restart", T(), before, O({ config_revision: 2 }), { baseRevision: 1 }).state).toBe("pending");
  });
  test("timeouts are honest about what was seen last", () => {
    expect(timeoutMessage("restart", "hand-b", 30, O({ session_status: "offline" }), "machine-b")).toContain("went offline and has not come back");
    expect(timeoutMessage("edit", "hand-b", 30, O({ session_status: "working" }))).toContain("is still working");
    expect(timeoutMessage("restart", "hand-b", 30, O())).toContain("has not seen \"hand-b\" restart yet");
    expect(timeoutMessage("stop", "x", 30, O({ session_status: "offline" }))).toContain("has not seen \"x\" stop yet");
  });
});
