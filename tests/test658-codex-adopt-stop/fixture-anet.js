#!/usr/bin/node
// Test double for the pinned `anet` binary. Starts three sleep/listen panes
// with a fresh adoption marker. Not a Codex launcher.
const { appendFileSync, chmodSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

// spawn(anet, ["node","start",alias]) → argv is [node, script, ...userArgs]
const userArgs = process.argv.slice(2);
if (userArgs[0] !== "node" || userArgs[1] !== "start" || userArgs.length !== 3) process.exit(2);
const alias = userArgs[2];
const nodes = join(process.cwd(), ".anet", "nodes");
let nodeDir = "";
let config = null;
for (const id of readdirSync(nodes)) {
  const dir = join(nodes, id);
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  if (cfg.alias === alias) { nodeDir = dir; config = cfg; break; }
}
if (!nodeDir || !config) process.exit(2);
appendFileSync(join(nodeDir, "launch-log"), `${alias}\n`);
const plan = JSON.parse(readFileSync(join(nodeDir, "launch-plan.json"), "utf8"));
if (plan.action === "fail") process.exit(1);
const socket = process.env.ANET_TMUX_SOCKET;
if (!socket) process.exit(3);
const home = join(nodeDir, "codex-home");
const marker = randomUUID();
const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const identity = join(nodeDir, "copresence-identity.json");
writeFileSync(identity, JSON.stringify({ marker, owner_uid: process.getuid(), boot_id: boot }), { mode: 0o600 });
chmodSync(identity, 0o600);
const external = config.codexLaunchLayout === "external-appserver";
const roles = external
  ? { tui: `${alias}-tui`, bridge: alias, appsrv: `${alias}-appsrv` }
  : { tui: alias, bridge: `${alias}-桥`, appsrv: `${alias}-appsrv` };
const port = new URL(config.codexAppServerUrl).port;
function session(name, command) {
  const result = spawnSync("/usr/bin/tmux", ["-S", socket, "new-session", "-d", "-s", name, "-c", process.cwd(), command], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const prefix = `exec env ANET_NODE_MARKER=${marker} CODEX_HOME='${home}'`;
session(roles.tui, `${prefix} /bin/sleep 300`);
session(roles.bridge, `${prefix} /bin/sleep 300`);
session(roles.appsrv, plan.action === "nolisten"
  ? `${prefix} /bin/sleep 300`
  : `${prefix} PORT=${port} /usr/bin/node -e 'const s=require("net").createServer();s.listen({host:"127.0.0.1",port:Number(process.env.PORT),exclusive:true},()=>setInterval(()=>{},1e9))'`);
