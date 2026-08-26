import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.umask(0o022);

const repo = "/workspace";
const runId = process.env.ANET_TEST1191_RUN_ID || "baseline";
const port = Number(process.env.ANET_TEST1191_HUB_PORT || "19352");
const alias = `linux-steer-${runId}`;
const root = `/tmp/test1191-linux-${runId}`;
const project = join(root, "project");
const userHome = join(root, "home");
const bin = join(root, "bin");
const rpcLog = join(root, "rpc.log");
const completeLongTurn = join(root, "complete-long-turn");
const hub = `http://127.0.0.1:${port}`;
mkdirSync(project, { recursive: true });
mkdirSync(join(userHome, ".anet"), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexec /usr/bin/tmux -u \"$@\"\n");
chmodSync(join(bin, "tmux"), 0o755);
writeFileSync(join(userHome, ".anet", "config.json"), JSON.stringify({ hub }, null, 2));

const codexWrapper = "/usr/local/bin/test1191-codex";
writeFileSync(codexWrapper, `#!/bin/bash\nset -o pipefail\nbun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "$@" 2>&1 | tee -a "$ANET_TEST751_RPC_LOG"\nrc=$?\necho "wrapper-rc:$rc" >> "$ANET_TEST751_RPC_LOG"\nexit "$rc"\n`);
chmodSync(codexWrapper, 0o755);
const anetWrapper = "/usr/local/bin/anet";
writeFileSync(anetWrapper, `#!/bin/bash\nset -o pipefail\nbun ${JSON.stringify(join(repo, "agent-network/bin/cli.ts"))} "$@" 2>&1 | tee -a "$ANET_TEST751_RPC_LOG"\nexit \${PIPESTATUS[0]}\n`);
chmodSync(anetWrapper, 0o755);

// The production resolver rejects every world-writable ancestor; /tmp is
// intentionally 01777, so a faithful exact-package fixture must live below a
// root-owned immutable prefix just like a real global npm payload.
const exactNodeRoot = join(`/opt/test1191-${runId}`, "node_modules", "@sleep2agi", "agent-node");
const exactNodeDist = join(exactNodeRoot, "dist");
const exactNodeEntrypoint = join(exactNodeDist, "cli.js");
mkdirSync(exactNodeDist, { recursive: true });
writeFileSync(join(exactNodeRoot, "package.json"), JSON.stringify({
  name: "@sleep2agi/agent-node",
  version: "2.5.0-preview.33",
  publishConfig: { tag: "preview" },
  bin: { "agent-node": "dist/cli.js" },
}));
writeFileSync(exactNodeEntrypoint, `import { appendFileSync } from "node:fs";\nawait new Promise((resolve) => setTimeout(resolve, Number(process.env.ANET_TEST1191_BRIDGE_DELAY_MS || "0")));\nappendFileSync(process.env.ANET_TEST751_RPC_LOG, \`bridge-home:\${process.env.CODEX_HOME}\\n\`);\nawait import(${JSON.stringify(pathToFileURL(join(repo, "agent-node/dist/cli.js")).href)});\n`);
execFileSync("chmod", ["-R", "go-w", exactNodeRoot]);
chmodSync(exactNodeEntrypoint, 0o755);

const env = {
  ...process.env,
  HOME: userHome,
  LANG: "C.utf8",
  LC_ALL: "C.utf8",
  PATH: `${bin}:${process.env.PATH}`,
  ANET_TEST751_RPC_LOG: rpcLog,
  ANET_TEST751_COMPLETE_LONG_TURN: completeLongTurn,
  ANET_TEST751_LONG_TURN: "1",
  ANET_TEST1191_BRIDGE_DELAY_MS: "1500",
  ANET_AGENT_NODE_BIN: exactNodeEntrypoint,
};
const cli = join(repo, "agent-network/bin/cli.ts");
const command = (args, input = "") => execFileSync("bun", [cli, ...args], {
  cwd: project, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
});
const commandAsync = (args) => new Promise((resolve, reject) => {
  const child = spawn("bun", [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve(stdout);
    else reject(new Error(`start exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
  });
});
const waitUntil = async (label, predicate, timeoutMs = Number(process.env.ANET_TEST1191_TIMEOUT_MS || "30000")) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
};
const wire = () => existsSync(rpcLog) ? readFileSync(rpcLog, "utf8") : "";

let hubProcess;
try {
  command(["register", "--username", `t1191${runId}`, "--password", "pass123456"]);
  command(["login", "--username", `t1191${runId}`, "--password", "pass123456"]);
  command(["node", "create", alias, "--runtime", "codex-cli", "--hub", hub]);
  const codexHome = join(project, ".anet", "nodes", alias, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{}\n");

  let startOutput;
  try {
    startOutput = await commandAsync(["node", "start", alias, "--codex-bin", codexWrapper, "--no-inherit-codex-home", "--accept-dev-channels"]);
  } catch (error) {
    error.message += `\nrpc log:\n${wire()}`;
    try {
      error.message += `\napp-server pane:\n${execFileSync("tmux", ["capture-pane", "-p", "-S", "-200", "-t", `=${alias}-appsrv`], { encoding: "utf8" })}`;
    } catch {}
    throw error;
  }
  if (!startOutput.includes("bridge READY") || !startOutput.includes(`共存节点 ${alias} 就绪`)) {
    throw new Error(`launcher claimed no protocol readiness:\n${startOutput}`);
  }
  await waitUntil("human turn", () => wire().includes("rpc:test/human-turn/start:thread_windows_e2e"));

  const globalConfig = JSON.parse(readFileSync(join(userHome, ".anet", "config.json"), "utf8"));
  const userToken = globalConfig.token;
  const networkId = globalConfig.network_id;
  const postTask = async (priority, suffix) => {
    const response = await fetch(`${hub}/api/task`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        alias, from: "t1191-linux", network_id: networkId, priority,
        task: `linux-${priority}-during-long-turn`,
        meta: { source: "dashboard-chat", client_request_id: `dreq_${suffix.repeat(32)}` },
      }),
    });
    const body = await response.json();
    if (!response.ok || !body.task_id) throw new Error(`task post failed: ${response.status} ${JSON.stringify(body)}`);
    return body.task_id;
  };

  const before = (wire().match(/^rpc:turn\/start(?::|$)/gm) || []).length;
  const taskIds = [await postTask("normal", "a"), await postTask("high", "b")];
  await waitUntil("two live steers", () => (wire().match(/^rpc:turn\/steer:thread_windows_e2e:turn_windows_human$/gm) || []).length === 2);
  writeFileSync(completeLongTurn, "complete\n");
  await waitUntil("terminal dashboard tasks", async () => {
    for (const taskId of taskIds) {
      const response = await fetch(`${hub}/api/tasks?network_id=${encodeURIComponent(networkId)}&task_id=${encodeURIComponent(taskId)}&skip_stats=1`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!response.ok) return false;
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : payload.tasks;
      if (!Array.isArray(rows) || !rows.some((row) => row.task_id === taskId && ["completed", "replied"].includes(row.status))) return false;
    }
    return true;
  });
  const finalWire = wire();
  const after = (finalWire.match(/^rpc:turn\/start(?::|$)/gm) || []).length;
  if (after !== before) throw new Error(`Dashboard steering created turn/start: before=${before} after=${after}\n${finalWire}`);

  const config = JSON.parse(readFileSync(join(project, ".anet", "nodes", alias, "config.json"), "utf8"));
  if (finalWire.indexOf("bridge-home:") < 0 || finalWire.indexOf("tui-home:") < finalWire.indexOf("bridge-home:")) {
    throw new Error(`TUI launched before the delayed real bridge reached its ready boundary:\n${finalWire}`);
  }
  const last = (pattern) => [...finalWire.matchAll(pattern)].map((match) => match[1].trim()).at(-1);
  if (
    config.codexThreadId !== "thread_windows_e2e"
    || last(/^tui-remote:(.+)$/gm) !== config.codexAppServerUrl
    || last(/^appsrv-home:(.+)$/gm) !== codexHome
    || last(/^bridge-home:(.+)$/gm) !== codexHome
    || last(/^tui-home:(.+)$/gm) !== codexHome
  ) throw new Error(`Linux app-server/bridge/TUI identity drift:\n${finalWire}`);
  console.log("PASS Linux real Hub + built agent-node steers normal/high into one human turn with zero extra turn/start and one HOME/remote/thread");
} finally {
  try { command(["node", "stop", alias]); } catch {}
  if (hubProcess) hubProcess.kill();
}
