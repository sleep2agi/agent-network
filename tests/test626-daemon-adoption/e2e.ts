// Docker only: real Hub + daemon + manually launched agent-node. No model calls.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { minimalEnv, computeChildPath } from "../../agent-node/src/runtime/create-node-daemon.js";

const root = mkdtempSync(join(tmpdir(), "board626-e2e-"));
const home = join(root, "home"), daemonDir = join(home, "supervisor"), workdir = join(home, "manual");
for (const p of [home, daemonDir, workdir]) mkdirSync(p, { recursive: true, mode: 0o700 });
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
  start(["/root/.bun/bin/bun", "run", "src/index.ts"], "/app/server", { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test", COMMHUB_DB: dbPath }, "hub");
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
    writeFileSync(cfg, JSON.stringify({ node_id: id, alias, node_name: alias, network_id: network, hub, token: auth.token, runtime: "claude-agent-sdk", ...(supervisor ? { role: "host_supervisor", adopt_roots: [workdir] } : {}) }), { mode: 0o600 });
    const env = { ...minimalEnv({}, "linux", { HOME: home }), PATH: computeChildPath("linux", "/usr/local/bin/node"), COMMHUB_ALIAS: alias, COMMHUB_NODE_ID: id, COMMHUB_TOKEN: auth.token, COMMHUB_URL: hub, ANET_CONFIG_UPDATE_CAPABLE: "1",
      ...(supervisor ? { ANET_BIN_ABS: "/app/agent-network/dist/bin/cli.js", ANET_DAEMON_ALLOW_ENV_BIN: "1" } : {}) };
    const proc = start(["/usr/local/bin/node", "/app/agent-node/dist/cli.js", "--config", cfg, "--alias", alias, "--runtime", "claude-agent-sdk"], cwd, env, supervisor ? "daemon" : "manual");
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
  check(entry.adopted && entry.node_id === "n_manual_fixture" && entry.launch_mode === "bare", "registry holds exact verified identity");
  check(manual.proc.exitCode === null && readFileSync(join(manual.dir, ".pid"), "utf8") === String(manual.proc.pid), "adopt keeps original PID alive and unchanged");
  check(await cli(["adopted"], daemonDir) === 0, "CLI adopted list");
  check(await cli(["unadopt", "手工演示", "--yes"]) === 0, "CLI revoke accepted");
  await until(() => !JSON.parse(readFileSync(join(daemonDir, ".anet/child-workdirs.json"), "utf8"))["手工演示"], "local revocation");
  check(manual.proc.exitCode === null, "unadopt leaves manual node running");
  db.close();
} catch (e) {
  console.error(e);
  for (const name of ["daemon", "manual", "hub"]) {
    try { console.error(`${name}:`, readFileSync(join(root, `${name}.log`), "utf8").slice(-6000).replace(/(?:ntok|utok)_[A-Za-z0-9_-]+/g, "[redacted]")); } catch {}
  }
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) { child.kill(); await child.exited; }
}
