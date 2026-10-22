import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import pty from "../../agent-network/node_modules/node-pty/lib/index.js";
import { verifyResumeContinuity, formatVerdict } from "./resume-verdict.mjs";

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
  // Bounded evidence uses existing queries/kills, not extra probes or retries.
  ANET_WINDOWS_STOP_DIAGNOSTICS: "1",
  PATH: `${bin};${process.env.PATH}`, ANET_TEST751_RPC_LOG: rpcLog,
  ANET_TEST751_CODEX_HOME: "",
  ANET_TEST751_COMPLETE_LONG_TURN: completeLongTurn,
  ANET_AGENT_NODE_BIN: exactNodeEntrypoint,
};

function command(args, stdin = "") {
  console.log(`PHASE command: ${args.join(" ")}`);
  const result = spawnSync(bun, [cli, ...args], { cwd: project, env, input: stdin, encoding: "utf8", timeout: 30_000 });
  // Keep successful first-stop evidence too, instead of discarding its stderr.
  if (args[0] === "node" && args[1] === "stop" && result.status === 0) {
    for (const line of (result.stderr || "").split(/\r?\n/)) {
      if (line.startsWith("[anet-stop-evidence] ")) console.log(line);
    }
  }
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
      else {
        // 🔴 #1342 —— 成功路径上把**耗时那一行**捞出来。
        //
        //   cli.ts 已经有意把 probeMs 打在成功路径上(那里的注释写着:「一个只在
        //   坏的时候说话的仪表,没法告诉你好是不是真的变好了」),但它写在 PTY
        //   输出里,而 PTY 输出**只在失败时**被 dump —— 于是那half 好意在这里被
        //   吞掉了:仪表说了话,收集它的人没转述。
        //
        //   量成本的数必须两侧都有样本,否则「改完之后变快了没有」永远答不了。
        for (const line of String(output).split(/\r?\n/)) {
          if (line.includes("client-health") && line.includes("probeMs")) {
            console.log(`  [health] ${line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim()}`);
          }
        }
        resolvePromise(output);
      }
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
// Start with a genuinely unmaterialized TUI-owned identity. After stop, the
// next Windows generation must discard that pending identity rather than try
// to resume a thread which never acquired a rollout.
delete env.ANET_TEST751_MATERIALIZE_ON_CREATE;
mkdirSync(codexHome, { recursive: true });
// #535 — co-presence start now stops at needs-login (exit 3) when the node's CODEX_HOME has no usable
// login; `{}` is "not logged in". A clearly fake API key is a usable login shape; nothing here calls a model.
writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-fake-test751-windows" }) + "\n");

async function startAndStop(label) {
  console.log(`PHASE ${label}`);
  const out = await terminal(["node", "start", "windows-picker", "--no-inherit-codex-home"], undefined, 60_000);
  if (!out.includes("FAKE_CODEX_TUI_RESUMED thread_windows_e2e")) throw new Error(`${label}: TUI did not resume expected thread\n${out}`);
  const record = join(project, ".anet", "nodes", "windows-picker", "windows-copresence.json");
  if (!existsSync(record)) throw new Error(`${label}: managed process record missing`);
  command(["node", "stop", "windows-picker"]);
  if (existsSync(record)) throw new Error(`${label}: stop left managed process record`);
}

await startAndStop("unmaterialized first start");
const unmaterializedConfig = JSON.parse(readFileSync(configPath, "utf8"));
if (!unmaterializedConfig.codexPendingThread || unmaterializedConfig.codexThreadId) {
  throw new Error(`first stopped generation did not retain only the deferred candidate: ${JSON.stringify(unmaterializedConfig)}`);
}
// Reset the wire transcript so the persisted-thread assertions below retain
// exact counts while the second start proves the stale candidate was dropped.
writeFileSync(rpcLog, "");
env.ANET_TEST751_MATERIALIZE_ON_CREATE = "1";
await startAndStop("first start after dropping unmaterialized candidate");
await startAndStop("restart");
const calls = readFileSync(rpcLog, "utf8");
if ((calls.match(/^rpc:thread\/start$/gm) || []).length !== 0) throw new Error(`deferred TUI startup created a synthetic thread:\n${calls}`);
if ((calls.match(/^rpc:test\/tui-thread\/create:thread_windows_e2e$/gm) || []).length !== 1) throw new Error(`expected one user-owned TUI thread identity:\n${calls}`);
if ((calls.match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length !== 3) throw new Error(`launcher and real bridge did not resume one persisted thread:\n${calls}`);
if ((calls.match(/^rpc:thread\/read:thread_windows_e2e$/gm) || []).length !== 3) throw new Error(`deferred promotion plus restart did not read exact history:\n${calls}`);
if ((calls.match(/^tui:thread_windows_e2e$/gm) || []).length !== 2) throw new Error(`TUI did not adopt same thread twice:\n${calls}`);
console.log("PASS interactive create -> native start -> stop -> restart resumes same Codex thread");

// #1462 — the positive above is a set of inline counts. Route the same
// observations through the shared acceptance criterion so the *criterion* is
// what passed, not a bespoke assertion, and then prove the criterion has
// discrimination with negative controls derived from this run's real transcript.
const finalConfig = JSON.parse(readFileSync(configPath, "utf8"));
const realContinuity = verifyResumeContinuity({
  expectedThreadId: "thread_windows_e2e",
  config: finalConfig,
  transcript: calls,
  tuiLines: calls,
});
if (realContinuity.verdict !== "pass") {
  throw new Error(`continuity criterion rejected the real positive path: ${JSON.stringify(realContinuity)}`);
}
console.log(`PASS test1462 continuity verdict — ${formatVerdict("positive", realContinuity)}`);

// Negative 1 — config still echoes the expected id, but the wire went fresh.
const freshOnWire = `rpc:thread/start\n${calls}`;
const freshVerdict = verifyResumeContinuity({
  expectedThreadId: "thread_windows_e2e",
  config: finalConfig,
  transcript: freshOnWire,
  tuiLines: calls,
});
if (freshVerdict.verdict !== "fail" || !freshVerdict.reasons.some((r) => r.startsWith("fresh_thread_start"))) {
  throw new Error(`fresh/fork path was not rejected: ${JSON.stringify(freshVerdict)}`);
}
console.log(`PASS test1462-NEG fresh-wire rejected — ${formatVerdict("negative-fresh", freshVerdict)}`);

// Negative 2 — config still echoes the expected id, but resume/read addressed
// another thread (same shape as the fixture's wire log, different identity).
const otherThread = calls.split("thread_windows_e2e").join("thread_windows_other");
const wrongVerdict = verifyResumeContinuity({
  expectedThreadId: "thread_windows_e2e",
  config: finalConfig,
  transcript: otherThread,
  tuiLines: otherThread,
});
if (wrongVerdict.verdict !== "fail" || !wrongVerdict.reasons.some((r) => r.startsWith("resume_wrong_thread"))) {
  throw new Error(`wrong-thread resume was not rejected: ${JSON.stringify(wrongVerdict)}`);
}
console.log(`PASS test1462-NEG wrong-thread rejected — ${formatVerdict("negative-wrong-thread", wrongVerdict)}`);

// Negative 3 — resume happened but no history read / no identity evidence:
// that is `unknown`, never a verified resume.
const noHistory = calls
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("rpc:thread/read") && !line.startsWith("tui:"))
  .join("\n");
const unknownVerdict = verifyResumeContinuity({
  expectedThreadId: "thread_windows_e2e",
  config: finalConfig,
  transcript: noHistory,
  tuiLines: "",
});
if (unknownVerdict.verdict !== "unknown") {
  throw new Error(`missing evidence was not kept unknown: ${JSON.stringify(unknownVerdict)}`);
}
console.log(`PASS test1462-NEG missing-evidence stays unknown — ${formatVerdict("negative-unknown", unknownVerdict)}`);

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
// Exercise health reporting during this turn, rather than winning the race
// against the first monitor snapshot on a fast runner.
env.ANET_CODEX_HEALTH_INTERVAL_MS = "1000";
env.ANET_STATUS_HEARTBEAT_MS = "1000";
let driven = false;
let drivePromise;
let turnStartCountBeforeDashboard = -1;
const longTurnOutput = await terminal(["node", "start", "windows-picker", "--no-inherit-codex-home"], (_child, output) => {
  if (driven || !output.includes("FAKE_CODEX_TUI_LONG_TURN_READY")
    || !output.includes("client-health role=tui codex_home=exact remote=exact thread=exact connection=pid-attributed")) return;
  driven = true;
  drivePromise = (async () => {
    let observedHealth;
    let observedIdentity;
    await waitUntil("Hub app-server health after native TUI PID attribution", async () => {
      const receiptPath = join(project, ".anet", "nodes", "windows-picker", "windows-tui-health.json");
      const recordPath = join(project, ".anet", "nodes", "windows-picker", "windows-copresence.json");
      if (!existsSync(receiptPath) || !existsSync(recordPath)) return false;
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      const currentConfig = JSON.parse(readFileSync(configPath, "utf8"));
      observedIdentity = { marker: receipt.marker === record.marker, node: receipt.nodeId === currentConfig.node_id, remote: receipt.remote === currentConfig.codexAppServerUrl };
      // The directory alias is deliberately different from immutable config.node_id.
      // Wait for this generation's atomic receipt; never accept the stopped one.
      if (!observedIdentity.marker) return false;
      if (!observedIdentity.node || !observedIdentity.remote) throw new Error(`native TUI receipt identity mismatch: ${JSON.stringify(observedIdentity)}`);
      const res = await fetch(`http://127.0.0.1:19351/api/status?network_id=${encodeURIComponent(networkId)}&alias=windows-picker`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!res.ok) throw new Error(`Hub status failed ${res.status}`);
      const payload = await res.json();
      const row = payload.sessions?.find((s) => s.alias === "windows-picker" && s.network_id === networkId);
      observedHealth = row?.health;
      if (!observedHealth) return false;
      return observedHealth.bridge === "ok" && observedHealth.app_server?.ok === true
        && observedHealth.tui?.ok === true && observedHealth.tui?.reason === "running"
        && !["revoked", "expired"].includes(observedHealth.model_auth)
        && Number.isFinite(row.health_observed_ms_ago) && row.health_observed_ms_ago < 5000;
    }).catch((error) => {
      console.error(`native-health evidence at failure: ${JSON.stringify({ observedIdentity, observedHealth })}`);
      throw error;
    });
    console.log(`PASS Hub current health before Dashboard: app_server=ok; native TUI PID attributed; ongoing tui=running; model_auth=${observedHealth.model_auth}`);
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
// #1337 —— 真实 CLI 停止「失败副作用」隔离见证（**纯测试夹具**）：拆到独立模块以便审阅，
// 且只有 run.ps1 编译出夹具（ANET_TEST1337_SHIM_DIR 存在）时才加载。
if (process.env.ANET_TEST1337_SHIM_DIR) {
  const { runStopEffectsScenarios } = await import("./windows-stop-effects.mjs");
  await runStopEffectsScenarios({ cli, env, project, root, userHome, join, terminal });
}

// node-pty's Windows ConPTY helper can retain an internal pipe handle after
// every child has exited. All assertions and both managed teardowns are done.
process.exit(0);
