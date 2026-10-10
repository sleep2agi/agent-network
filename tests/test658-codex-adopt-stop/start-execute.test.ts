import { expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { containerTest as test, fixtureTmux } from "./fixture-tmux.js";
import { pinFixtureAnet } from "./fixture-anet.js";
import { codexTmuxEnv, listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";
import { handleAdoptDoorbell } from "../../agent-node/src/runtime/adopt-daemon.js";
import { handleAdoptedLifecycle } from "../../agent-node/src/runtime/adopt-lifecycle.js";
import { adoptedChild } from "../../agent-node/src/runtime/adopt-registry.js";
import { readAdoptionProc } from "../../agent-node/src/runtime/adopt-proc.js";
import { isHubStopped } from "../../agent-network/src/stopped-receipt.js";

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function ready(scope: any, fixturePanes: Set<string>, release: string) {
  writeFileSync(release, "ready", { mode: 0o600 });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = listCodexPanes(scope).filter(row => fixturePanes.has(row[2]));
    if (rows.length === 4 && rows.every(row => {
      const proc = readAdoptionProc(Number(row[3]));
      return proc?.argv.join(" ") === "sleep 300" && proc.uid === scope.uid && proc.cwd === scope.workdir
        && proc.env.CODEX_HOME === scope.codexHome
        && proc.env.ANET_NODE_MARKER === (row[0] === "start-decoy" ? "foreign" : scope.marker);
    })) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("fixture identity-bearing stages not ready");
}

async function harness(port: number) {
  const workdir = mkdtempSync("/tmp/codex-start-");
  const uid = process.getuid()!;
  const nodeDir = `${workdir}/.anet/nodes/fixture`;
  const daemon = `${workdir}/daemon`;
  mkdirSync(`${nodeDir}/codex-home`, { recursive: true, mode: 0o700 });
  mkdirSync(daemon, { mode: 0o700 });
  const scope = {
    layout: "native" as const, alias: "启动样例", socket: `${workdir}/socket`,
    marker: "22222222-2222-4222-8222-222222222222", codexHome: `${nodeDir}/codex-home`, workdir, uid,
  };
  const config = {
    node_id: "n_fixture", alias: scope.alias, network_id: "net_fixture", hub: "http://127.0.0.1:9999",
    runtime: "codex-app-server", codexCopresence: true, env: { ANET_TMUX_SOCKET: scope.socket },
    codexThreadId: "33333333-3333-4333-8333-333333333333", codexAppServerUrl: `ws://127.0.0.1:${port}`,
  };
  writeFileSync(`${nodeDir}/config.json`, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(`${nodeDir}/copresence-identity.json`, JSON.stringify({
    marker: scope.marker, owner_uid: uid, boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  }), { mode: 0o600 });
  const calls: any[] = [];
  let lists = 0;
  let revoke = false;
  const deps = {
    home: mkdtempSync("/tmp/codex-start-home-"), workDir: daemon, hubUrl: config.hub, networkId: config.network_id,
    adoptRoots: [workdir], uid, daemonEnv: {}, warn: () => {},
    callCommHub: async (tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === "get_adopt_request") return { ok: true, request_id: "adopt_fixture", node_id: config.node_id, alias: scope.alias, network_id: config.network_id, workdir };
      if (tool === "list_my_children") {
        lists += 1;
        const binding = revoke && lists >= 3 ? "other" : "adopt_fixture";
        return { ok: true, children: [{ managed: "adopted", child_node_id: config.node_id, alias: scope.alias, binding_request_id: binding }] };
      }
      return { ok: true };
    },
  };
  const fixture = fixtureTmux(scope.socket);
  const unpin = await pinFixtureAnet(workdir);
  const fixturePanes = new Set<string>();
  const names = [scope.alias, `${scope.alias}-桥`, `${scope.alias}-appsrv`, "start-decoy"];
  const release = `${workdir}/fixture-release`;
  return {
    workdir, nodeDir, daemon, scope, config, calls, deps, fixture, unpin, fixturePanes, names, release,
    armRevoke() { revoke = true; lists = 0; },
  };
}

for (const action of ["ok", "nolisten"] as const)
test(`native codex start ${action}`, async () => {
  const port = await freePort();
  const h = await harness(port);
  const env = codexTmuxEnv(h.scope.socket);
  try {
    for (const name of h.names) h.fixturePanes.add(h.fixture.exec(["new-session", "-d", "-s", name, "-c", h.workdir,
      `while [ ! -f '${h.release}' ]; do sleep 0.01; done; exec env ANET_NODE_MARKER=${name === "start-decoy" ? "foreign" : h.scope.marker} CODEX_HOME=${h.scope.codexHome} sleep 300`], { env }).trim());
    await ready(h.scope, h.fixturePanes, h.release);
    await handleAdoptDoorbell({ request_id: "adopt_fixture" }, h.deps);
    expect(h.calls.at(-1).args.status).toBe("adopted");
    await handleAdoptedLifecycle({ request_id: "stop_fixture", child_node_id: h.config.node_id, child_alias: h.scope.alias, action: "stop" }, h.deps);
    expect(h.calls.at(-1).args.status).toBe("stopped");
    expect(isHubStopped(h.nodeDir, h.config.node_id)).toBe(true);
    const markerBefore = readFileSync(`${h.nodeDir}/copresence-identity.json`);
    const registryBefore = readFileSync(`${h.daemon}/.anet/child-workdirs.json`, "utf8");
    writeFileSync(`${h.nodeDir}/launch-plan.json`, JSON.stringify({ action }), { mode: 0o600 });
    await handleAdoptedLifecycle({ request_id: "start_fixture", child_node_id: h.config.node_id, child_alias: h.scope.alias, action: "start" }, h.deps);
    if (action === "nolisten") {
      expect(h.calls.at(-1).args).toMatchObject({ status: "start_failed", error: "adopt_codex_port_unproven" });
      expect(readFileSync(`${h.nodeDir}/copresence-identity.json`).equals(markerBefore)).toBe(true);
      expect(readFileSync(`${h.daemon}/.anet/child-workdirs.json`, "utf8")).toBe(registryBefore);
      expect(isHubStopped(h.nodeDir, h.config.node_id)).toBe(true);
      expect(listCodexPanes(h.scope).map(row => row[0])).toEqual(["start-decoy"]);
      return;
    }
    expect(h.calls.some(call => call.args?.status === "starting")).toBe(true);
    const appsrv = listCodexPanes(h.scope).find(row => row[0] === `${h.scope.alias}-appsrv`);
    expect(h.calls.at(-1).args).toMatchObject({ status: "started", child_pid: Number(appsrv?.[3]) });
    expect(isHubStopped(h.nodeDir, h.config.node_id)).toBe(false);
    const marker = JSON.parse(readFileSync(`${h.nodeDir}/copresence-identity.json`, "utf8")).marker;
    expect(marker).not.toBe(h.scope.marker);
    expect(adoptedChild(h.daemon, h.scope.alias)?.codex_v2?.marker).toBe(marker);
    expect(listCodexPanes(h.scope).map(row => row[0]).sort()).toEqual([...h.names].sort());
    const proc = readAdoptionProc(Number(appsrv?.[3]));
    expect(proc?.env.ANET_NODE_MARKER).toBe(marker);
    expect(proc?.env.CODEX_HOME).toBe(h.scope.codexHome);
    await handleAdoptedLifecycle({ request_id: "stop_again", child_node_id: h.config.node_id, child_alias: h.scope.alias, action: "stop" }, h.deps);
    expect(h.calls.at(-1).args.status).toBe("stopped");
    expect(listCodexPanes(h.scope).map(row => row[0])).toEqual(["start-decoy"]);
  } finally {
    h.unpin();
    h.fixture.cleanup();
  }
}, 30_000);

test("native codex start rolls back when the binding generation changes", async () => {
  const port = await freePort();
  const h = await harness(port);
  const env = codexTmuxEnv(h.scope.socket);
  try {
    for (const name of h.names) h.fixturePanes.add(h.fixture.exec(["new-session", "-d", "-s", name, "-c", h.workdir,
      `while [ ! -f '${h.release}' ]; do sleep 0.01; done; exec env ANET_NODE_MARKER=${name === "start-decoy" ? "foreign" : h.scope.marker} CODEX_HOME=${h.scope.codexHome} sleep 300`], { env }).trim());
    await ready(h.scope, h.fixturePanes, h.release);
    await handleAdoptDoorbell({ request_id: "adopt_fixture" }, h.deps);
    await handleAdoptedLifecycle({ request_id: "stop_fixture", child_node_id: h.config.node_id, child_alias: h.scope.alias, action: "stop" }, h.deps);
    const markerBefore = readFileSync(`${h.nodeDir}/copresence-identity.json`);
    writeFileSync(`${h.nodeDir}/launch-plan.json`, JSON.stringify({ action: "ok" }), { mode: 0o600 });
    h.armRevoke();
    await handleAdoptedLifecycle({ request_id: "start_fixture", child_node_id: h.config.node_id, child_alias: h.scope.alias, action: "start" }, h.deps);
    expect(h.calls.at(-1).args).toMatchObject({ status: "start_failed", error: "adopt_codex_binding_generation_unproven" });
    expect(readFileSync(`${h.nodeDir}/copresence-identity.json`).equals(markerBefore)).toBe(true);
    expect(adoptedChild(h.daemon, h.scope.alias)?.codex_v2?.marker).toBe(h.scope.marker);
    expect(listCodexPanes(h.scope).map(row => row[0])).toEqual(["start-decoy"]);
    expect(isHubStopped(h.nodeDir, h.config.node_id)).toBe(true);
  } finally {
    h.unpin();
    h.fixture.cleanup();
  }
}, 30_000);
