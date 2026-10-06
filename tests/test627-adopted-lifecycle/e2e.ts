// Docker only: real Hub + daemon + manually launched agent-node. No model calls.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { minimalEnv, computeChildPath } from "../../agent-node/src/runtime/create-node-daemon.js";
import { execTmux } from "../../agent-node/src/tmux.js";
import { processStamp } from "../../agent-node/src/runtime/adopt-process-tree.js";

const root = mkdtempSync(join(tmpdir(), "board627-e2e-"));
const home = join(root, "home"), daemonDir = join(home, "supervisor"), workdir = join(home, "manual");
const tmuxMode = process.env.TEST627_TMUX === "1", socket = join(home, "private-tmux", "socket");
for (const p of [home, daemonDir, workdir]) mkdirSync(p, { recursive: true, mode: 0o700 });
if (tmuxMode) {
  mkdirSync(join(home, "private-tmux"), { mode: 0o700 });
  execTmux(["new-session", "-d", "-s", "fixture-keeper", "sleep 300"], { env: { ...process.env, ANET_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined } });
}
const reserve = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = reserve.port; reserve.stop(true);
const hub = `http://127.0.0.1:${port}`, dbPath = join(root, "hub.db");
const children: ReturnType<typeof Bun.spawn>[] = [];
const start = (cmd: string[], cwd: string, env: Record<string, string | undefined>, label: string) => {
  const p = Bun.spawn(cmd, { cwd, env, stdout: Bun.file(join(root, `${label}.log`)), stderr: Bun.file(join(root, `${label}.log`)) });
  children.push(p); return p;
};
const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); console.log(`PASS ${message}`); };
async function until(fn: () => Promise<any> | any, message: string) {
  for (let i = 0; i < 80; i++) { try { if (await fn()) return; } catch {} await Bun.sleep(250); }
  throw Error(`timeout: ${message}`);
}
try {
  start(["/root/.bun/bin/bun", "run", "src/index.ts"], "/app/server", { ...process.env, HOME: home, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test", COMMHUB_DB: dbPath }, "hub");
  await until(async () => (await fetch(`${hub}/health`)).ok, "Hub health");
  const reg: any = await (await fetch(`${hub}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "adoptfixture", password: "Fixture_Only_123456!", email: "fixture@example.test" }) })).json();
  check(reg.token?.startsWith("utok_"), "human registration");
  const headers = { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" };
  const me: any = await (await fetch(`${hub}/api/auth/me`, { headers })).json();
  const network = me.networks[0].network_id;
  mkdirSync(join(home, ".anet"), { mode: 0o700 });
  writeFileSync(join(home, ".anet/config.json"), JSON.stringify({ hub, token: reg.token, network_id: network }), { mode: 0o600 });
  const node = async (alias: string, id: string, cwd: string, supervisor = false) => {
    const auth: any = await (await fetch(`${hub}/api/auth/node-token`, { method: "POST", headers, body: JSON.stringify({ network_id: network, node_name: alias }) })).json();
    check(auth.token?.startsWith("ntok_"), `node token ${alias}`);
    const dir = join(cwd, ".anet/nodes", id); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ node_id: id, alias, node_name: alias, network_id: network, hub, token: auth.token, runtime: "claude-agent-sdk", ...(supervisor ? { role: "host_supervisor", adopt_roots: [workdir] } : tmuxMode ? { env: { ANET_TMUX_SOCKET: socket } } : {}) }), { mode: 0o600 });
    const env = { ...minimalEnv({}, "linux", { HOME: home }), PATH: computeChildPath("linux", "/usr/local/bin/node"), COMMHUB_ALIAS: alias, COMMHUB_NODE_ID: id, COMMHUB_TOKEN: auth.token, COMMHUB_URL: hub, ANET_CONFIG_UPDATE_CAPABLE: "1",
      ...(supervisor ? { ANET_BIN_ABS: "/app/agent-network/dist/bin/anet.cjs", ANET_DAEMON_ALLOW_ENV_BIN: "1" } : {}) };
    const cmd = ["/usr/local/bin/node", "/app/agent-node/dist/cli.js", "--config", cfg, "--alias", alias, "--runtime", "claude-agent-sdk"];
    if (tmuxMode && !supervisor) {
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      const vars = { ...env, ANET_TMUX_SOCKET: socket };
      const command = `exec env -i ${Object.entries(vars).filter(([,v]) => v !== undefined).map(([k,v]) => `${k}=${q(v!)}`).join(" ")} TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${cmd.map(q).join(" ")} >${q(join(root, "manual.log"))} 2>&1`;
      const pid = Number(execTmux(["new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", "fixture-manual", "-c", cwd, command], { encoding: "utf8", env: { ...process.env, ANET_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined } }).trim());
      writeFileSync(join(dir, ".pid"), String(pid), { mode: 0o600 });
      const proc = { pid, get exitCode() { return processStamp(pid) ? null : 0; }, get exited() { return until(() => !processStamp(pid), "tmux manual exited"); } };
      return { proc, dir };
    }
    const proc = start(cmd, cwd, env, supervisor ? "daemon" : "manual");
    writeFileSync(join(dir, ".pid"), String(proc.pid), { mode: 0o600 });
    return { proc, dir };
  };
  const daemon = await node("fixture-supervisor", "n_supervisor_fixture", daemonDir, true);
  const manual = await node("手工演示", "n_manual_fixture", workdir);
  const db = new Database(dbPath, { readonly: true });
  await until(() => {
    const d: any = db.query("SELECT config_snapshot FROM nodes WHERE node_id='n_supervisor_fixture'").get();
    return d && JSON.parse(d.config_snapshot).daemon_capabilities?.adopt_capable === true && db.query("SELECT node_id FROM nodes WHERE node_id='n_manual_fixture'").get();
  }, "registered nodes and adoption capability");
  check(daemon.proc.exitCode === null && manual.proc.exitCode === null, "both real agent-node processes alive");
  const cli = async (args: string[], cwd = workdir) => {
    const p = Bun.spawn(["/usr/local/bin/node", "/app/agent-network/dist/bin/cli.js", "daemon", ...args], { cwd,
      env: { ...minimalEnv({}, "linux", { HOME: home }), PATH: computeChildPath("linux", "/usr/local/bin/node") }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    console.log(out); if (code) console.error(err); return code;
  };
  check(await cli(["adopt", "手工演示", "--daemon", "n_supervisor_fixture"]) === 0, "CLI dry plan");
  check((db.query("SELECT count(*) AS n FROM node_daemon_bindings").get() as any).n === 0, "plan writes no binding");
  check(await cli(["adopt", "手工演示", "--daemon", "n_supervisor_fixture", "--yes"]) === 0, "CLI request accepted");
  await until(() => {
    const row: any = db.query("SELECT status,error FROM node_daemon_bindings WHERE node_id='n_manual_fixture'").get();
    if (row?.status === "refused") { console.log(`daemon refusal: ${row.error}`); }
    return row?.status === "active";
  }, "daemon activates binding");
  const entry = JSON.parse(readFileSync(join(daemonDir, ".anet/child-workdirs.json"), "utf8"))["手工演示"];
  check(entry.adopted && entry.node_id === "n_manual_fixture" && entry.launch_mode === (tmuxMode ? "tmux" : "bare"), "registry holds exact verified identity");
  check(manual.proc.exitCode === null && readFileSync(join(manual.dir, ".pid"), "utf8") === String(manual.proc.pid), "adopt keeps original PID alive and unchanged");
  check(await cli(["adopted"], daemonDir) === 0, "CLI adopted list");
  const tool = async (name: string, args: object, allowRefusal = false) => {
    const response = await fetch(`${hub}/mcp`, { method: "POST", headers: { ...headers, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, network_id: network } } }) });
    const raw = await response.text(), lines = raw.split("\n").filter(l => l.startsWith("data:"));
    const envelope = JSON.parse(lines.length ? lines.at(-1)!.slice(5) : raw);
    const result = JSON.parse(envelope.result.content[0].text);
    if (!result.ok && !allowRefusal) throw Error(`${name}: ${result.error}`);
    return result;
  };
  const refusedRestart = await tool("restart_node", { node_id: "n_manual_fixture" }, true);
  check(refusedRestart.ok === false && refusedRestart.error === "adopted_restart_requires_daemon", "adopted restart refused without exit-75 supervisor proof");
  check((db.query("SELECT count(*) AS n FROM node_config_updates WHERE node_id='n_manual_fixture'").get() as any).n === 0 && manual.proc.exitCode === null,
    "restart refusal writes no update and leaves manual process alive");
  // Seed only isolated test rows; invoke the production route over real HTTP.
  const seed = new Database(dbPath);
  for (const [id, alias] of [["n_ordinary_fixture", "ordinary-fixture"], ["node_createdfixture", "created-fixture"]]) {
    seed.query("INSERT INTO nodes(node_id,node_name,alias,network_id,lifecycle_state) VALUES(?,?,?,?,'active')").run(id, alias, alias, network);
  }
  seed.query("INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token,child_node_id) VALUES('cr_createdfixture','n_supervisor_fixture','created-fixture',?,'claude-agent-sdk','{}','[]','created',?,'fixture','node_createdfixture')").run(network, Date.now());
  seed.close();
  for (const id of ["n_ordinary_fixture", "node_createdfixture"]) {
    const restart = await tool("restart_node", { node_id: id });
    check(restart.ok && restart.apply_mode === "restart_only" && typeof restart.update_id === "string", `legacy restart accepted: ${id}`);
    check((db.query("SELECT status FROM node_config_updates WHERE update_id=?").get(restart.update_id) as any)?.status === "pending", `legacy restart queued: ${id}`);
  }
  const stopped = await tool("stop_node", { child_node_id: "n_manual_fixture", force: true });
  await until(() => (db.query("SELECT status FROM node_stop_requests WHERE request_id=?").get(stopped.request_id) as any)?.status === "stopped", "remote stop");
  await manual.proc.exited;
  check(existsSync(join(manual.dir, ".hub-stopped")), "stop writes hub-stopped marker");
  check(manual.proc.exitCode !== null, "original manual process exited");
  if (tmuxMode) {
    execTmux(["has-session", "-t", "=fixture-keeper"], { env: { ...process.env, ANET_TMUX_SOCKET: socket, TMUX: undefined, TMUX_PANE: undefined } });
    check(true, "unrelated private tmux session survives stop");
  }
  const beforePid = readFileSync(join(manual.dir, ".pid"), "utf8");
  const scan = Bun.spawn(["/usr/local/bin/node", "/app/agent-network/dist/bin/cli.js", "project", "up"], { cwd: workdir,
    env: { ...minimalEnv({}, "linux", { HOME: home }), PATH: computeChildPath("linux", "/usr/local/bin/node") }, stdout: "pipe", stderr: "pipe" });
  console.log(await new Response(scan.stdout).text());
  await scan.exited;
  check(readFileSync(join(manual.dir, ".pid"), "utf8") === beforePid && existsSync(join(manual.dir, ".hub-stopped")), "boot project scan preserves stopped PID and marker");
  const bootBin = join(root, "boot-bin"); mkdirSync(bootBin, { mode: 0o700 });
  writeFileSync(join(bootBin, "tmux"), '#!/bin/sh\nunset TMUX TMUX_PANE\nexec /usr/bin/tmux -S "$TEST627_SOCKET" "$@"\n', { mode: 0o700 });
  writeFileSync(join(bootBin, "anet"), '#!/bin/sh\nexec /usr/local/bin/node /app/agent-network/dist/bin/cli.js "$@"\n', { mode: 0o700 });
  const boot = Bun.spawn(["bash", "/app/deploy/fleet/anet-nodes-boot.sh"], { cwd: workdir,
    env: { ...process.env, HOME: home, PATH: `${bootBin}:${process.env.PATH}`, HUB_PORT: String(port), TEST627_SOCKET: socket,
      TMUX: undefined, TMUX_PANE: undefined, STAGGER: "0", LATE_GREEN_GRACE: "0", MAX_ROUNDS: "1" }, stdout: "pipe", stderr: "pipe" });
  const bootOutput = await new Response(boot.stdout).text();
  const bootError = await new Response(boot.stderr).text();
  const bootCode = await boot.exited;
  if (bootCode) console.error(bootOutput, bootError);
  check(bootCode === 0 && bootOutput.includes("hub-stopped") && readFileSync(join(manual.dir, ".pid"), "utf8") === beforePid && !processStamp(manual.proc.pid),
    "real boot sweep honors Hub stop without clearing PID or restarting");
  const started = await tool("start_node", { child_node_id: "n_manual_fixture" });
  await until(() => (db.query("SELECT status FROM node_start_requests WHERE request_id=?").get(started.request_id) as any)?.status === "started", "remote start");
  check(!existsSync(join(manual.dir, ".hub-stopped")), "start removes marker");
  const newPid = Number(readFileSync(join(manual.dir, ".pid"), "utf8"));
  check(newPid !== manual.proc.pid && existsSync(`/proc/${newPid}`), "new generation is alive");
  if (tmuxMode) {
    const proof = JSON.parse(readFileSync(join(daemonDir, ".anet/child-workdirs.json"), "utf8"))["手工演示"].launch_evidence;
    check(proof.mode === "tmux" && proof.socket === socket && proof.session === "fixture-manual", "start restored exact private socket and original session");
  }
  await until(() => {
    const row: any = db.query("SELECT status FROM sessions WHERE alias=?").get("手工演示");
    return row?.status === "idle";
  }, "same alias online");
  check(true, "same alias online after remote start");

  check(await cli(["unadopt", "手工演示", "--yes"]) === 0, "CLI revoke accepted");
  await until(() => !JSON.parse(readFileSync(join(daemonDir, ".anet/child-workdirs.json"), "utf8"))["手工演示"], "local revocation");
  check(existsSync(`/proc/${newPid}`), "unadopt leaves restarted node running");
  db.close();
} catch (e) {
  console.error(e);
  const diagnostic = new Database(dbPath, { readonly: true });
  console.error("start results", diagnostic.query("SELECT status,error FROM node_start_requests").all());
  diagnostic.close();
  for (const name of ["daemon", "manual", "hub"]) {
    try { console.error(`${name}:`, readFileSync(join(root, `${name}.log`), "utf8").slice(-6000).replace(/(?:ntok|utok)_[A-Za-z0-9_-]+/g, "[redacted]")); } catch {}
  }
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) { child.kill(); await child.exited; }
}
