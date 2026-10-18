// Isolated real Hub + create handler + source CLI + built runtime + V2 TUI.
// Only the loopback model and install-layout launcher are fixtures. No child
// config is edited, no shared flag is added to node_spec, and spawnChild is not
// overridden. Doorbells are invoked directly using the real Hub request ID.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handleCreateNodeDoorbell } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/create-node-daemon.ts";
import { observeHostSharedServe } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-host-shared-observer.ts";
import { childDirNameForCreate } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/child-dir-name.ts";

const root = "/run/test1327", artifact = process.env.ARTIFACT_DIR ?? "/artifacts";
// Child workdirs must obey the real daemon system-directory policy; /run is
// reserved for private runtime state, not user projects.
const home = join(root, "home"), daemonWork = join(root, "daemon"), projects = "/tmp/test1327-projects";
const launches = join(root, "launches"), socket = join(root, "tmux.sock");
for (const dir of [root, artifact, home, daemonWork, projects, launches, join(root, "host-project"), join(root, "host-data"),
  join(home, ".anet"), join(home, ".config/opencode")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
Object.assign(process.env, { HOME: home, USERPROFILE: home, ANET_TMUX_SOCKET: socket,
  ANET_OPENCODE_SAFE_BASE: launches, TERM: "xterm-256color" });
delete process.env.TMUX;
delete process.env.TMUX_PANE;
const hub = "http://127.0.0.1:9327", sharedUrl = "http://127.0.0.1:13270";
const password = "shared-test1327-only", passwordFile = join(root, "host-password");
const registry = join(home, ".anet/opencode-shared-server.json");
const aliases = ["nodeB1327", "nodeC1327", "ownD1327", "fallbackE1327"];
const responsePrefix = "ANSWER1327_";
const children: ChildProcess[] = [];
const captured: string[] = [];
const redact = (s: string) => s.replace(/\b(?:atok|ntok|utok)_[A-Za-z0-9_-]+/g, "[test-token]")
  .replaceAll(password, "[test-password]");
function check(name: string, ok: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) throw new Error(name);
}
const pause = (ms = 100) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return true; await pause(); }
  return false;
}
function start(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", b => captured.push(redact(String(b))));
  child.stderr!.on("data", b => captured.push(redact(String(b))));
  children.push(child);
  return child;
}
async function rest(path: string, token = "", body?: unknown) {
  const response = await fetch(hub + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${redact(await response.text())}`);
  return response.json() as Promise<any>;
}
async function rpc(token: string, name: string, args: unknown) {
  const response = await fetch(hub + "/mcp", { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
    accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${name}: HTTP ${response.status}`);
  const lines = raw.split("\n").filter(line => line.startsWith("data:"));
  const result = JSON.parse(lines.length ? lines.at(-1)!.slice(5).trim() : raw);
  return JSON.parse(result.result.content[0].text);
}
async function cli(args: string[], cwd: string, required = true) {
  const child = Bun.spawn(["bun", "/workspace/agent-network/bin/cli.ts", ...args], {
    cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  captured.push(redact(out + err));
  if (required) check(`real CLI ${args.slice(0, 3).join(" ")}`, exit === 0);
  return exit;
}
const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], {
  env: process.env, encoding: "utf8", timeout: 5000,
});
const projectFor = (alias: string) => join(projects, alias);
const nodeDir = (alias: string) => join(projectFor(alias), ".anet/nodes", childDirNameForCreate(alias, projectFor(alias)));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function register(url: string) {
  writeFileSync(registry, JSON.stringify({ url, passwordFile, clientBinDir: "/usr/local/bin" }), { mode: 0o600 });
}
let ownerToken = "", networkId = "", daemonToken = "";
const daemonId = "n_test1327_daemon", daemonAlias = "daemon1327";
async function heartbeat() {
  const result = await rpc(daemonToken, "report_status", {
    alias: daemonAlias, node_id: daemonId, resume_id: "test1327-daemon", status: "idle", network_id: networkId,
    config_snapshot: { role: "host_supervisor", daemon_capabilities: {
      runtimes_supported: ["opencode-cli"], can_create_nodes: true, default_workdir_root: projects,
    } },
  });
  check("real Hub accepts daemon capability report", result.ok);
}
async function create(alias: string, newServer = false) {
  await heartbeat();
  const queued = await rpc(ownerToken, "create_node", { network_id: networkId, daemon_node_id: daemonId,
    node_spec: { name: alias, runtime: "opencode-cli", model: "stub/stub-model", workdir: projectFor(alias),
      flags: { opencodeGeneration: "v2", opencodeUnsafeTools: true, ...(newServer ? { opencodeNewServer: true } : {}) } },
  });
  check(`${alias}: real Hub queues creation`, queued.ok && typeof queued.request_id === "string");
  let ack: any;
  await handleCreateNodeDoorbell({ request_id: queued.request_id }, {
    workDir: daemonWork, hubUrl: hub, log: line => captured.push(redact(line)), warn: line => captured.push(redact(line)),
    serializeEnvLocal: () => "", allowedRuntimes: ["opencode-cli"],
    callCommHub: async (tool, args) => {
      const result = await rpc(daemonToken, tool, args);
      if (tool === "ack_create_request") ack = { args, result };
      return result;
    },
  });
  captured.push(redact(`${alias}: create ACK ${JSON.stringify(ack)}`));
  check(`${alias}: launch health yields real started ACK`, ack?.args.status === "started"
    && ack.args.launch_verified === true && ack.result.ok === true);
  const config = json(join(nodeDir(alias), "config.json"));
  const health = json(join(nodeDir(alias), "opencode-launch-health.json"));
  const attach = json(join(nodeDir(alias), "opencode-attach.json"));
  check(`${alias}: real TUI rendered`, await until(() => /ctrl\+p/.test(tmux("capture-pane", "-p", "-t", `=${alias}:`).stdout ?? "")));
  return { config, health, attach };
}
async function task(alias: string, text: string) {
  check("response marker is not supplied in task prompt", !text.includes(responsePrefix));
  const sent = await rest("/api/task", ownerToken, { alias, task: text, network_id: networkId });
  check(`${alias}: Hub accepts network task`, sent.ok && sent.message_id);
  let row: any;
  check(`${alias}: task reaches terminal state`, await until(async () => {
    const found = await rest(`/api/tasks?task_id=${encodeURIComponent(sent.message_id)}&network_id=${encodeURIComponent(networkId)}`, ownerToken);
    row = found.tasks?.find((value: any) => (value.task_id ?? value.id) === sent.message_id);
    return ["replied", "failed", "cancelled"].includes(row?.status);
  }, 60_000));
  check(`${alias}: exact task replied`, row.status === "replied");
  return String(row.result ?? "");
}
start("bun", ["src/index.ts"], "/workspace/server", { ...process.env, HOST: "127.0.0.1", PORT: "9327",
  COMMHUB_DB: join(root, "hub.db"), COMMHUB_AUTH_TOKEN: "test1327-bootstrap" });
start("python3", ["/test1327/stub-model.py", "18837", join(artifact, "stub.log"), responsePrefix], root, process.env);
try {
  check("real isolated Hub ready", await until(() => fetch(hub + "/health").then(r => r.ok, () => false)));
  check("loopback model ready", await until(() => fetch("http://127.0.0.1:18837/v1/models").then(r => r.ok, () => false)));
  await rest("/api/auth/register", "", { username: "owner1327", password: "Test1327Password!" });
  ownerToken = (await rest("/api/auth/login", "", { username: "owner1327", password: "Test1327Password!" })).token;
  const network = await rest("/api/networks", ownerToken, { name: "private1327" });
  networkId = network.network?.network_id ?? network.network_id;
  check("private network created", typeof networkId === "string" && networkId.length > 0);
  daemonToken = (await rest("/api/auth/node-token", ownerToken, {
    network_id: networkId, node_name: daemonAlias, node_id: daemonId,
  })).token;
  check("daemon has its own token", typeof daemonToken === "string" && daemonToken.startsWith("ntok_"));
  writeFileSync(join(home, ".anet/config.json"), JSON.stringify({ hub, token: ownerToken, network_id: networkId }), { mode: 0o600 });
  writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({ model: "stub/stub-model", provider: {
    stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: "http://127.0.0.1:18837/v1", apiKey: "test-only" },
      models: { "stub-model": { name: "Stub" } } },
  } }), { mode: 0o600 });
  // A source-layout pin shim forwards every original argument to the REAL CLI.
  // Only runtime path, private tmux and launch base are fixed for this fixture.
  const pinDir = join(root, "cli-install");
  mkdirSync(pinDir, { mode: 0o700 });
  const pinnedCli = join(pinDir, "anet");
  writeFileSync(join(pinDir, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-network", bin: { anet: "anet" } }), { mode: 0o600 });
  writeFileSync(pinnedCli, '#!/bin/sh\nexport ANET_AGENT_NODE_BIN=/opt/node_modules/@sleep2agi/agent-node/dist/cli.js\n'
    + `export ANET_TMUX_SOCKET=${socket}\nexport ANET_OPENCODE_SAFE_BASE=${launches}\nexport TERM=xterm-256color\n`
    + 'exec /usr/local/bin/bun /workspace/agent-network/bin/cli.ts "$@"\n', { mode: 0o755 });
  const pin = join(root, "path.conf");
  writeFileSync(pin, `ANET_BIN_ABS=${pinnedCli}\n`, { mode: 0o600 });
  process.env.ANET_DAEMON_PATH_CONF = pin;
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const host = start("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "13270"], join(root, "host-project"), {
    PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(root, "host-data"),
    OPENCODE_DB: join(root, "host-data/opencode.db"), OPENCODE_SERVER_PASSWORD: password,
  });
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  check("real authenticated host A ready", await until(() => fetch(`${sharedUrl}/api/info`, { headers }).then(r => r.ok, () => false)));
  const observed = observeHostSharedServe(sharedUrl);
  check("host A has observable process identity", observed.ok);
  if (!observed.ok) throw new Error(observed.reason);
  const hostPid = observed.processEvidence.pid;
  register(sharedUrl);
  const b = await create(aliases[0]), c = await create(aliases[1]);
  for (const [label, value] of [["B", b], ["C", c]] as const) {
    check(`${label}: created config defaults to A`, value.config.opencodeSharedServerUrl === sharedUrl
      && value.config.opencodeSharedServerPasswordFile === passwordFile);
    check(`${label}: runtime really borrows A`, value.health.serveOwnership === "shared" && value.health.serve.pid === hostPid
      && value.health.serve.ticks === String(observed.processEvidence.startTicks));
  }
  check("B/C have distinct sessions and Hub identities", b.attach.gen !== c.attach.gen && /^ses_/.test(b.attach.gen)
    && /^ses_/.test(c.attach.gen) && b.config.node_id !== c.config.node_id && b.config.token !== c.config.token);
  check("B network reply has B identity", await task(aliases[0], "Reply with exactly B1327") === `[${aliases[0]}] ${responsePrefix}B1327`);
  check("C network reply has C identity", await task(aliases[1], "Reply with exactly C1327") === `[${aliases[1]}] ${responsePrefix}C1327`);
  await cli(["node", "stop", aliases[0]], projectFor(aliases[0]));
  check("B closes its own TUI", await until(() => tmux("has-session", "-t", `=${aliases[0]}`).status !== 0));
  check("closing B preserves A", host.exitCode === null && host.signalCode === null && process.kill(hostPid, 0));
  check("C works after B closes", await task(aliases[1], "Reply with exactly AFTER_B1327") === `[${aliases[1]}] ${responsePrefix}AFTER_B1327`);
  const own = await create(aliases[2], true);
  check("explicit new-server actually owns a different listener", !own.config.opencodeSharedServerUrl
    && own.health.serveOwnership !== "shared" && own.health.serve.pid !== hostPid);
  register("http://127.0.0.1:13272");
  const fallback = await create(aliases[3]);
  check("dead candidate actually starts an owned server", !fallback.config.opencodeSharedServerUrl
    && !fallback.config.opencodeSharedServerPasswordFile && fallback.health.serveOwnership !== "shared"
    && fallback.health.serve.pid !== hostPid);
  check("fallback network turn completes", await task(aliases[3], "Reply with exactly FALLBACK1327") === `[${aliases[3]}] ${responsePrefix}FALLBACK1327`);
  check("host A still lives after own/fallback creation", host.exitCode === null && host.signalCode === null);
  console.log("PASS: real shared daemon create/start/session/task/close; no production or publication claim");
} finally {
  for (const alias of aliases) {
    if (existsSync(join(nodeDir(alias), "config.json"))) {
      try { await cli(["node", "stop", alias], projectFor(alias), false); } catch { /* preserve original failure */ }
    }
    for (const session of [alias, `${alias}-桥`]) tmux("kill-session", "-t", `=${session}`);
    const log = join(nodeDir(alias), "logs/copresence-bridge.log");
    if (existsSync(log)) writeFileSync(join(artifact, `${alias}.log`), redact(readFileSync(log, "utf8")));
  }
  for (const child of children) { try { child.kill("SIGTERM"); } catch { /* exited */ } }
  writeFileSync(join(artifact, "native.log"), captured.join("\n"));
}
