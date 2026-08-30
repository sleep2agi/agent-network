import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import pty from "../../agent-network/node_modules/node-pty/lib/index.js";

if (process.platform !== "win32") throw new Error("windows-e2e must run on Windows");
const repo = resolve(import.meta.dirname, "../..");
// 配对版本从 agent-node/package.json 派生。写死在这里的话,每条发版 PR
// (它只改 package.json 的版本和 PAIRED_AGENT_NODE_VERSION) 都会让本门变红:
// cli.ts 拿新版本去校验,而 fixture 还声明着上一个版本。这不是配对失效,
// 是同一个事实被抄了第三份。真实安装出来的包版本就等于 package.json 里那个。
const pairedVersion = JSON.parse(readFileSync(join(repo, "agent-node", "package.json"), "utf8")).version;
const cli = join(repo, "agent-network", "bin", "cli.ts");
const root = join(process.env.RUNNER_TEMP, "anet-test751-e2e");
const project = join(root, "project");
const bin = join(root, "bin");
const userHome = join(root, "home");
const rpcLog = join(root, "rpc.log");
const completeLongTurn = join(root, "complete-long-turn");
const bun = process.env.ANET_TEST751_BUN;
if (!bun) throw new Error("ANET_TEST751_BUN is required");
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(join(userHome, ".anet"), { recursive: true });
writeFileSync(join(userHome, ".anet", "config.json"), JSON.stringify({ hub: "http://127.0.0.1:19351" }));
writeFileSync(join(bin, "codex.cmd"), `@echo off\r\nbun "${join(import.meta.dirname, "fake-codex.mjs")}" %*\r\n`);
writeFileSync(join(bin, "agent-node.cmd"), `@echo off\r\nbun "${join(import.meta.dirname, "fake-agent-node.mjs")}" %*\r\n`);
// Deliberately leave the PATH shim above as a stale-global witness. The Codex
// bridge must use this exact package-owned paired entrypoint instead. The
// package-owned wrapper imports the repository's REAL built agent-node: the
// old Windows gate imported fake-agent-node.mjs (an infinite sleep), so it
// could never prove SSE admission or turn/steer while the TUI was busy.
const exactNodeRoot = join(process.env.RUNNER_TEMP, "anet-test751-exact-pair", "node_modules", "@sleep2agi", "agent-node");
const exactNodeDist = join(exactNodeRoot, "dist");
const exactNodeEntrypoint = join(exactNodeDist, "cli.js");
mkdirSync(exactNodeDist, { recursive: true });
writeFileSync(join(exactNodeRoot, "package.json"), JSON.stringify({
  name: "@sleep2agi/agent-node",
  version: pairedVersion,
  publishConfig: { tag: "preview" },
  bin: { "agent-node": "dist/cli.js" },
}));
writeFileSync(exactNodeEntrypoint, `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.ANET_TEST751_RPC_LOG, \`bridge-home:\${process.env.CODEX_HOME}\\n\`);\nawait import(${JSON.stringify(pathToFileURL(join(repo, "agent-node", "dist", "cli.js")).href)});\n`);
const env = {
  ...process.env, HOME: userHome, USERPROFILE: userHome,
  PATH: `${bin};${process.env.PATH}`, ANET_TEST751_RPC_LOG: rpcLog,
  ANET_TEST751_CODEX_HOME: "",
  ANET_TEST751_COMPLETE_LONG_TURN: completeLongTurn,
  ANET_AGENT_NODE_BIN: exactNodeEntrypoint,
};

function command(args, stdin = "") {
  console.log(`PHASE command: ${args.join(" ")}`);
  const result = spawnSync(bun, [cli, ...args], { cwd: project, env, input: stdin, encoding: "utf8", timeout: 30_000 });
  const output = (result.stdout || "") + (result.stderr || "");
  if (result.status !== 0) throw new Error(`command failed (${args.join(" ")}):\n${output}`);
  return output;
}

function terminal(args, onData, timeoutMs = 45_000) {
  console.log(`PHASE terminal: ${args.join(" ")}`);
  return new Promise((resolvePromise, reject) => {
    const child = pty.spawn(bun, [cli, ...args], { cwd: project, env, cols: 120, rows: 40 });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PTY timeout: ${args.join(" ")}\n${output}`)); }, timeoutMs);
    child.onData((data) => { output += data; onData?.(child, output); });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        const appLog = join(project, ".anet", "nodes", "windows-picker", "windows-appsrv.log");
        // 🔴 #1342 —— 三段诊断原先在文件不存在 / PTY 无输出时**静默降级成空串**,
        //    于是 CI 上只剩 `PTY failed (1): …` 一行。「有诊断」和「诊断为空」
        //    在报错文本里长得一模一样,读的人会以为那一行就是全部信息。
        //    改成显式说明缺席,下一次采样才能分辨「TUI 有输出但没帮助」
        //    还是「TUI 根本没产出任何东西」—— 两者指向完全不同的根因。
        // 🔴 #1342 补第二层(2026-08-31,在 #1623 的一次真实失败里当场看到):
        //    上面只分辨了「文件在不在」。**文件在、但读出来是空串**时,
        //    这里会打印一个只有表头、下面一片空白的段 ——
        //    与「我打印了它,它确实没内容」逐字相同。那一次 `app-server log`
        //    正是 0 字节,而 `fake rpc log` 满的:两段并排,读的人无法判断
        //    前者是「没写」还是「写了但为空」。而这两件事指向不同的根因
        //    (app-server 没起来 vs 起来了不落盘)。
        //    ⚠️ 这是同一个缺陷隔了一层 —— 修 A 分支的人天然不会去看 B 分支。
        const readLog = (label, path) => {
          if (!existsSync(path)) return `\n--- ${label}: 不存在 (${path}) ---`;
          const body = readFileSync(path, "utf8");
          if (body.length === 0) return `\n--- ${label}: 存在但 0 字节 (${path}) ---`;
          return `\n--- ${label} (${body.length} 字节) ---\n${body}`;
        };
        const ptyOutput = output ? `\n--- PTY 输出 (${output.length} 字节) ---\n${output}` : `\n--- PTY 无输出(0 字节) ---`;
        const diagnostics = readLog("app-server log", appLog);
        const rpcDiagnostics = readLog("fake rpc log", rpcLog);
        reject(new Error(`PTY failed (${exitCode}): ${args.join(" ")}${ptyOutput}${diagnostics}${rpcDiagnostics}`));
      }
      else resolvePromise(output);
    });
  });
}

command(["register", "--username", "t751", "--password", "pass123456"]);
command(["login", "--username", "t751", "--password", "pass123456"]);
let selected = false;
const pickerOutput = await terminal(["node", "create", "windows-picker", "--hub", "http://127.0.0.1:19351"], (child, output) => {
  if (!selected && output.includes("选择 runtime:")) {
    selected = true;
    setTimeout(() => child.write("\x1b[B\x1b[B\x1b[B\r"), 150);
  }
});
if (!pickerOutput.includes("Codex 共存 TUI")) throw new Error("interactive picker did not display Codex co-presence");
const configPath = join(project, ".anet", "nodes", "windows-picker", "config.json");
const firstConfig = JSON.parse(readFileSync(configPath, "utf8"));
if (firstConfig.runtime !== "codex-app-server" || firstConfig.codexCopresence !== true) {
  throw new Error(`picker persisted wrong mode: ${JSON.stringify(firstConfig)}`);
}
const codexHome = join(project, ".anet", "nodes", "windows-picker", "codex-home");
env.ANET_TEST751_CODEX_HOME = codexHome;
mkdirSync(codexHome, { recursive: true });
writeFileSync(join(codexHome, "auth.json"), "{}\n");

async function startAndStop(label) {
  console.log(`PHASE ${label}`);
  const out = await terminal(["node", "start", "windows-picker", "--no-inherit-codex-home"], undefined, 60_000);
  if (!out.includes("FAKE_CODEX_TUI_RESUMED thread_windows_e2e")) throw new Error(`${label}: TUI did not resume expected thread\n${out}`);
  const record = join(project, ".anet", "nodes", "windows-picker", "windows-copresence.json");
  if (!existsSync(record)) throw new Error(`${label}: managed process record missing`);
  command(["node", "stop", "windows-picker"]);
  if (existsSync(record)) throw new Error(`${label}: stop left managed process record`);
}

await startAndStop("first start");
await startAndStop("restart");
const calls = readFileSync(rpcLog, "utf8");
if ((calls.match(/^rpc:thread\/start$/gm) || []).length !== 0) throw new Error(`deferred TUI startup created a synthetic thread:\n${calls}`);
if ((calls.match(/^rpc:test\/tui-thread\/create:thread_windows_e2e$/gm) || []).length !== 1) throw new Error(`expected one user-owned TUI thread identity:\n${calls}`);
if ((calls.match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length !== 3) throw new Error(`launcher and real bridge did not resume one persisted thread:\n${calls}`);
if ((calls.match(/^rpc:thread\/read:thread_windows_e2e$/gm) || []).length !== 3) throw new Error(`deferred promotion plus restart did not read exact history:\n${calls}`);
if ((calls.match(/^tui:thread_windows_e2e$/gm) || []).length !== 2) throw new Error(`TUI did not adopt same thread twice:\n${calls}`);
console.log("PASS interactive create -> native start -> stop -> restart resumes same Codex thread");

const globalConfig = JSON.parse(readFileSync(join(userHome, ".anet", "config.json"), "utf8"));
const userToken = globalConfig.token;
const networkId = globalConfig.network_id;
if (typeof userToken !== "string" || !userToken.startsWith("utok_")) throw new Error("test user token missing");
if (typeof networkId !== "string" || !networkId) throw new Error("test network id missing");

async function waitUntil(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function postDashboardTask(priority, suffix) {
  const clientRequestId = `dreq_${suffix.repeat(32).slice(0, 32)}`;
  const response = await fetch("http://127.0.0.1:19351/api/task", {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      alias: "windows-picker",
      from: "t751",
      network_id: networkId,
      priority,
      task: `windows-${priority}-during-long-turn`,
      meta: { source: "dashboard-chat", client_request_id: clientRequestId },
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.task_id) throw new Error(`dashboard task failed ${response.status}: ${JSON.stringify(body)}`);
  return body.task_id;
}

env.ANET_TEST751_LONG_TURN = "1";
let driven = false;
let drivePromise;
let turnStartCountBeforeDashboard = -1;
const longTurnOutput = await terminal(["node", "start", "windows-picker", "--no-inherit-codex-home"], (_child, output) => {
  if (driven || !output.includes("FAKE_CODEX_TUI_LONG_TURN_READY")) return;
  driven = true;
  drivePromise = (async () => {
    const beforeWire = readFileSync(rpcLog, "utf8");
    turnStartCountBeforeDashboard = (beforeWire.match(/^rpc:turn\/start(?::|$)/gm) || []).length;
    const normalTask = await postDashboardTask("normal", "a");
    const highTask = await postDashboardTask("high", "b");
    await waitUntil("two live turn/steer RPCs", () => {
      const wire = existsSync(rpcLog) ? readFileSync(rpcLog, "utf8") : "";
      return (wire.match(/^rpc:turn\/steer:thread_windows_e2e:turn_windows_human$/gm) || []).length === 2;
    });
    writeFileSync(completeLongTurn, "complete\n");
    await waitUntil("both Dashboard tasks terminal", async () => {
      for (const taskId of [normalTask, highTask]) {
        const res = await fetch(`http://127.0.0.1:19351/api/tasks?network_id=${encodeURIComponent(networkId)}&task_id=${encodeURIComponent(taskId)}&skip_stats=1`, {
          headers: { Authorization: `Bearer ${userToken}` },
        });
        if (!res.ok) return false;
        const payload = await res.json();
        const rows = Array.isArray(payload) ? payload : payload.tasks;
        if (!Array.isArray(rows) || !rows.some((row) => row.task_id === taskId && ["completed", "replied"].includes(row.status))) return false;
      }
      return true;
    });
  })().catch((error) => { writeFileSync(completeLongTurn, "abort\n"); throw error; });
}, 90_000);
delete env.ANET_TEST751_LONG_TURN;
if (drivePromise) await drivePromise;
if (!driven || !longTurnOutput.includes("FAKE_CODEX_TUI_LONG_TURN_COMPLETED")) {
  throw new Error(`Windows long-turn steer probe did not complete:\n${longTurnOutput}`);
}
const steerCalls = readFileSync(rpcLog, "utf8");
if ((steerCalls.match(/^rpc:turn\/steer:thread_windows_e2e:turn_windows_human$/gm) || []).length !== 2) {
  throw new Error(`normal/high messages did not both steer the same active turn:\n${steerCalls}`);
}
const turnStartCountAfterDashboard = (steerCalls.match(/^rpc:turn\/start(?::|$)/gm) || []).length;
if (turnStartCountBeforeDashboard < 0 || turnStartCountAfterDashboard !== turnStartCountBeforeDashboard) {
  throw new Error(`Dashboard work opened a second turn: before=${turnStartCountBeforeDashboard} after=${turnStartCountAfterDashboard}\n${steerCalls}`);
}
const longConfig = JSON.parse(readFileSync(configPath, "utf8"));
const tuiRemotes = [...steerCalls.matchAll(/^tui-remote:(.+)$/gm)].map((match) => match[1].trim());
const tuiHomes = [...steerCalls.matchAll(/^tui-home:(.+)$/gm)].map((match) => match[1].trim());
const appServerHomes = [...steerCalls.matchAll(/^appsrv-home:(.+)$/gm)].map((match) => match[1].trim());
const bridgeHomes = [...steerCalls.matchAll(/^bridge-home:(.+)$/gm)].map((match) => match[1].trim());
if (
  longConfig.codexThreadId !== "thread_windows_e2e"
  || tuiRemotes.at(-1) !== longConfig.codexAppServerUrl
  || tuiHomes.at(-1) !== codexHome
  || appServerHomes.at(-1) !== codexHome
  || bridgeHomes.at(-1) !== codexHome
) {
  throw new Error(`long-turn identity drift: ${JSON.stringify(longConfig)}`);
}
const managed = JSON.parse(readFileSync(join(project, ".anet", "nodes", "windows-picker", "windows-copresence.json"), "utf8"));
if (managed.processes.filter((process) => process.role === "bridge").length !== 1) throw new Error("duplicate Windows bridge");
command(["node", "stop", "windows-picker"]);
console.log("PASS Windows real bridge receives normal/high SSE during one human turn and steers the same remote/thread/HOME without duplication");
// node-pty's Windows ConPTY helper can retain an internal pipe handle after
// every child has exited. All assertions and both managed teardowns are done.
process.exit(0);
