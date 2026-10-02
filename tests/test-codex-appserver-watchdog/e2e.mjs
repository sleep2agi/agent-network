// testwd —— #461 App Server 看门狗,真链路:真 Hub + 真 `anet node start`(共存,tmux)+ 构建出来的 agent-node
// + 假 codex(tests/test751-codex-copresence-windows/fake-codex.mjs,说 app-server 的 JSON-RPC)。
//
//   1. 共存节点起来,TUI 建出 thread、桥把它提升为节点的 thread。
//   2. SIGKILL 掉 app-server 进程 ⇒ Hub 的 /api/status 出现 degraded(app_server,原因「restarting app-server」),
//      此时派发被拒(node_degraded)。
//   3. 看门狗在原 tmux 会话里按原 argv 重新拉起:同一个 --listen、同一个 CODEX_HOME;桥 resume 同一个 thread。
//   4. 健康翻回 ok ⇒ Hub 不再 degraded,派发被接受(门自己重新打开,没人去点)。
//   5. 再杀到超过窗口内的上限 ⇒ Hub 上保持 degraded,原因「auto-restart gave up …」,过一会儿还是,派发仍被拒。
//   6. `anet node stop` 收得干净:没有残留的 app-server。
import { execFileSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.umask(0o022);
const repo = "/workspace";
const pairedVersion = JSON.parse(readFileSync(join(repo, "agent-node", "package.json"), "utf8")).version;
const runId = process.env.ANET_TESTWD_RUN_ID || "baseline";
const port = Number(process.env.ANET_TESTWD_HUB_PORT);
if (!port || port === 9200) throw new Error("need a throwaway hub port (never 9200)");
const alias = `wd-${runId}`;
const root = `/tmp/testwd-${runId}`;
const project = join(root, "project");
const userHome = join(root, "home");
const bin = join(root, "bin");
const rpcLog = join(root, "rpc.log");
const launches = join(root, "appsrv-launches");
const hub = `http://127.0.0.1:${port}`;
const TIMEOUT = Number(process.env.ANET_TESTWD_TIMEOUT_MS || "40000");
// #465 —— "hung":app-server 活着但卡死(close1006 / silent 两种),验证核对身份后杀掉重拉;以及外来进程绝不杀。
const SCENARIO = process.env.ANET_TESTWD_SCENARIO || "dead";
const modeFile = join(root, "hung-mode");
mkdirSync(project, { recursive: true });
mkdirSync(join(userHome, ".anet"), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexec /usr/bin/tmux -u \"$@\"\n");
chmodSync(join(bin, "tmux"), 0o755);
writeFileSync(join(userHome, ".anet", "config.json"), JSON.stringify({ hub }, null, 2));

// The codex wrapper: app-server launches after the first one wait RELAUNCH_DELAY_S before binding, so the
// degraded window is wide enough to observe on the Hub and to dispatch into. TUI invocations keep the pane alive
// (`tail`, not `sleep` — a sleep pane is the "placeholder" the health probe reports) after the fake returns.
const codexWrapper = `/usr/local/bin/testwd-codex-${runId}`;
writeFileSync(codexWrapper, `#!/bin/bash
if [ "$1" = "app-server" ]; then
  n=$(cat ${JSON.stringify(launches)} 2>/dev/null || echo 0)
  echo $((n + 1)) > ${JSON.stringify(launches)}
  if [ "$n" -ge 1 ]; then sleep "\${ANET_TESTWD_RELAUNCH_DELAY_S:-4}"; fi
  if [ ${JSON.stringify(SCENARIO)} = hung ]; then
    # 本进程(bash,pane 进程)保留原 argv;真正的假 app-server 绑在 port+1,前面挂一个可切换「卡死」的转发。
    echo "wrapper-invoke:$*" >>"$ANET_TEST751_RPC_LOG"; echo "wrapper-home:$CODEX_HOME" >>"$ANET_TEST751_RPC_LOG"
    rm -f ${JSON.stringify(modeFile)}
    args=("$@"); for i in "\${!args[@]}"; do if [ "\${args[$i]}" = "--listen" ]; then listen="\${args[$((i + 1))]}"; li=$((i + 1)); fi; done
    port="\${listen##*:}"; inner=$((port + 1)); args[$li]="ws://127.0.0.1:$inner"
    bun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "\${args[@]}" >>"$ANET_TEST751_RPC_LOG" 2>&1 &
    bun ${JSON.stringify(join(repo, "tests/test-codex-appserver-watchdog/hung-proxy.mjs"))} "$port" "$inner" ${JSON.stringify(modeFile)} >>"$ANET_TEST751_RPC_LOG" 2>&1
    exit $?
  fi
  bun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "$@" >>"$ANET_TEST751_RPC_LOG" 2>&1
  exit $?
fi
bun ${JSON.stringify(join(repo, "tests/test751-codex-copresence-windows/fake-codex.mjs"))} "$@" 2>&1 | tee -a "$ANET_TEST751_RPC_LOG"
exec tail -f /dev/null
`);
chmodSync(codexWrapper, 0o755);

const exactNodeRoot = join("/opt", `testwd-${runId}`, "node_modules", "@sleep2agi", "agent-node");
const exactNodeEntrypoint = join(exactNodeRoot, "dist", "cli.js");
mkdirSync(join(exactNodeRoot, "dist"), { recursive: true });
writeFileSync(join(exactNodeRoot, "package.json"), JSON.stringify({
  name: "@sleep2agi/agent-node", version: pairedVersion, publishConfig: { tag: "preview" }, bin: { "agent-node": "dist/cli.js" },
}));
writeFileSync(exactNodeEntrypoint, `await import(${JSON.stringify(pathToFileURL(join(repo, "agent-node/dist/cli.js")).href)});\n`);
execFileSync("chmod", ["-R", "go-w", exactNodeRoot]);
chmodSync(exactNodeEntrypoint, 0o755);

const env = {
  ...process.env,
  HOME: userHome,
  LANG: "C.utf8",
  LC_ALL: "C.utf8",
  PATH: `${bin}:${process.env.PATH}`,
  ANET_TEST751_RPC_LOG: rpcLog,
  ANET_AGENT_NODE_BIN: exactNodeEntrypoint,
  ANET_CODEX_HEALTH_INTERVAL_MS: "1000",
  ANET_CODEX_APPSERVER_RESTART_MAX: SCENARIO === "hung" ? "3" : "2",
  ANET_CODEX_APPSERVER_RESTART_WINDOW_MS: "600000",
  // hung:M 用默认值(4 次);宽限压到 3s 让测试快,silent 变体照样走到 SIGKILL。
  ...(SCENARIO === "hung" ? { ANET_CODEX_APPSERVER_KILL_GRACE_MS: "3000" } : {}),
};
const cli = join(repo, "agent-network/bin/cli.ts");
const command = (args) => execFileSync("bun", [cli, ...args], { cwd: project, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const commandAsync = (args) => new Promise((resolve, reject) => {
  const child = spawn("bun", [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  child.once("error", reject);
  child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`start exited ${code}\n${out}`))));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (label, predicate, timeoutMs = TIMEOUT) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await sleep(150);
  }
  fail(`timeout waiting for ${label}`);
};
const wire = () => (existsSync(rpcLog) ? readFileSync(rpcLog, "utf8") : "");
// 🔴 `-t =名` 对 CJK 会话名(这里的「-桥」)在 tmux 3.4 上匹配不到:先按名字逐字找出 pane id 再抓。
const bridgeLog = () => {
  try {
    const rows = execFileSync("tmux", ["-u", "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}"], { encoding: "utf8", env }).split("\n");
    const id = rows.map((r) => r.split("\t")).find(([, name]) => name === `${alias}-桥`)?.[0];
    if (!id) return "(no bridge pane)";
    return execFileSync("tmux", ["-u", "capture-pane", "-p", "-J", "-S", "-2000", "-t", id], { encoding: "utf8", env });
  } catch { return "(no bridge pane)"; }
};
const nodeLogs = () => {
  const dir = join(project, ".anet", "nodes", alias, "logs");
  try {
    return execFileSync("bash", ["-c", `ls -la ${JSON.stringify(dir)}; tail -n 80 ${JSON.stringify(dir)}/*.log`], { encoding: "utf8" });
  } catch (e) { return `(no node logs: ${String(e?.message ?? e).slice(0, 200)})`; }
};
const sessions = () => { try { return execFileSync("tmux", ["-u", "list-sessions"], { encoding: "utf8", env }); } catch { return "(no tmux server)"; } };
// agent-node's own run log (the pane only holds what fits on screen).
const nodeLogText = () => {
  const dir = join(project, ".anet", "nodes", alias, "logs");
  try { return execFileSync("bash", ["-c", `cat ${JSON.stringify(dir)}/*.log`], { encoding: "utf8" }); } catch { return ""; }
};
const fail = (msg) => { throw new Error(`${msg}\n--- rpc log ---\n${wire().slice(-3000)}\n--- tmux ---\n${sessions()}\n--- bridge pane ---\n${bridgeLog().slice(-4000)}\n--- node logs ---\n${nodeLogs().slice(-6000)}`); };
const pass = (msg) => console.log(`PASS ${msg}`);
const appServerPids = () => {
  try { return execFileSync("pgrep", ["-f", "fake-codex.mjs app-server"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
};

// ── #465 hung scenario ─────────────────────────────────────────────────────────────────────────
const wrapperInvokes = () => [...wire().matchAll(/^wrapper-invoke:(.*)$/gm)].map((m) => m[1]);
const wrapperHomes = () => [...wire().matchAll(/^wrapper-home:(.*)$/gm)].map((m) => m[1].trim());
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const proxyPids = () => {
  try { return execFileSync("pgrep", ["-f", "hung-proxy.mjs"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
};
async function hungScenario({ statusRow, dispatch, appserverReason, appUrl, codexHome }) {
  const timings = [];
  const variant = async (mode, launchNo, expectKill) => {
    const pidsBefore = appServerPids();
    const t0 = Date.now();
    writeFileSync(modeFile, mode);
    const counting = await waitUntil(`${mode}: hub shows app_server alive-but-not-answering`, async () => {
      const row = await statusRow();
      return /alive but not answering|hung \(alive/.test(appserverReason(row) ?? "") ? appserverReason(row) : null;
    });
    const tDegraded = Date.now() - t0;
    // 进程活着、端口在听:这是「卡死」,不是「死了」
    if (pidsBefore.length !== 1 || !pidAlive(pidsBefore[0])) fail(`${mode}: expected the app-server to be alive while hung`);
    pass(`${mode}: hub degraded while the process is alive — ${counting}`);
    await waitUntil(`${mode}: relaunch #${launchNo}`, () => wrapperInvokes().length === launchNo);
    const tKilled = Date.now() - t0;
    await waitUntil(`${mode}: hung app-server recovered`, async () => {
      const row = await statusRow();
      return row && !row.degraded ? true : null;
    });
    const tRecovered = Date.now() - t0;
    if (pidAlive(pidsBefore[0])) fail(`${mode}: the hung app-server pid ${pidsBefore[0]} is still alive after recovery`);
    if (!nodeLogText().includes(expectKill)) fail(`${mode}: node log lacks "${expectKill}"`);
    // 先数探针(报上去的是「活着但不应答 k/M」),第 M 次才动手
    if (!nodeLogText().includes("app-server is alive but not answering (2/4 failed probes")) fail(`${mode}: the node never reported the hung count before acting`);
    const inv = wrapperInvokes();
    if (inv[launchNo - 1] !== inv[0] || !inv[0].includes(`--listen ${appUrl}`)) fail(`${mode}: relaunch argv drifted:\n${inv.join("\n")}`);
    if (wrapperHomes().some((h) => h !== codexHome)) fail(`${mode}: CODEX_HOME drifted: ${wrapperHomes().join(", ")}`);
    if ((wire().match(/^rpc:thread\/start/gm) || []).length > 0) fail(`${mode}: a new thread was started instead of resuming`);
    const accepted = await dispatch(`after-${mode}`);
    if (!accepted.body?.task_id) fail(`${mode}: dispatch after recovery not accepted: ${JSON.stringify(accepted.body)}`);
    timings.push(`${mode}: degraded ${tDegraded}ms, relaunched ${tKilled}ms, healthy ${tRecovered}ms after the hang began`);
    pass(`${mode}: killed (${expectKill.replace(/^.*\(/, "").replace(/\).*$/, "")}) and relaunched with the same argv / --listen / CODEX_HOME; thread resumed; dispatch accepted`);
  };
  await variant("close1006", 2, "hung app-server stopped (SIGTERM)");
  await variant("silent", 3, "hung app-server stopped (SIGKILL)");
  const resumes = (wire().match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length;
  if (resumes < 3) fail(`expected the bridge to resume thread_windows_e2e after each relaunch (saw ${resumes})`);
  for (const t of timings) console.log(`TIMING ${t}`);

  // ── negative:同名会话被换成一个带外来标记的卡死监听者 —— 绝不杀 ──────────────────────────
  const appsrv = `${alias}-appsrv`;
  const sid = execFileSync("tmux", ["-u", "list-sessions", "-F", "#{session_id}\t#{session_name}"], { encoding: "utf8", env })
    .split("\n").map((l) => l.split("\t")).find(([, n]) => n === appsrv)?.[0];
  if (!sid) fail("no appsrv session to replace");
  const port = new URL(appUrl).port;
  writeFileSync(modeFile, "close1006"); // 握手立刻失败 → 探针每秒一次,8 秒里远超 M 次
  // 一条 tmux 命令里换掉:旧会话一关、同名新会话立刻在,看门狗看不到「没有活 pane」的空档(否则会按 #461 去重拉)。
  // 新进程带外来的 ANET_NODE_MARKER;旧转发还占着端口时重试绑定。
  execFileSync("tmux", ["-u", "kill-session", "-t", sid, ";", "new-session", "-d", "-s", appsrv,
    "-e", "ANET_NODE_MARKER=foreign-0000-marker", "-e", `CODEX_HOME=${codexHome}`,
    "bash", "-lc", `for i in $(seq 1 100); do bun ${join(repo, "tests/test-codex-appserver-watchdog/hung-proxy.mjs")} ${port} 1 ${modeFile}; sleep 0.2; done`], { env });
  const foreign = await waitUntil("foreign pane", () => {
    const row = execFileSync("tmux", ["-u", "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"], { encoding: "utf8", env })
      .split("\n").map((l) => l.split("\t")).find(([n]) => n === appsrv);
    return row ? Number(row[1]) : null;
  });
  await waitUntil("old app-server gone", () => appServerPids().length === 0);
  await waitUntil("foreign listener bound", () => new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: Number(port) });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  }));
  const launchesBefore = wrapperInvokes().length;
  await waitUntil("hub reports the foreign listener as degraded", async () => {
    const row = await statusRow();
    return /not restarting|not killing/.test(appserverReason(row) ?? "") ? true : null;
  });
  await sleep(8_000); // 1 s 一次探针、每次立刻失败:≥ 2 × M 次
  if (!pidAlive(foreign) || proxyPids().length === 0) fail("the foreign-marker process was killed");
  if (wrapperInvokes().length !== launchesBefore) fail("an app-server was relaunched over the foreign process");
  const row = await statusRow();
  if (!row?.degraded) fail("expected the node to stay degraded while a foreign process holds its port");
  pass(`foreign-marker hung listener (pid ${foreign}) never killed after 8 s of failed probes; node stays degraded — ${appserverReason(row)}`);
  execFileSync("kill", ["-KILL", String(foreign), ...proxyPids().map(String)]);
}

try {
  command(["register", "--username", `twd${runId}`, "--password", "pass123456"]);
  command(["login", "--username", `twd${runId}`, "--password", "pass123456"]);
  command(["node", "create", alias, "--runtime", "codex-cli", "--hub", hub]);
  const codexHome = join(project, ".anet", "nodes", alias, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  await commandAsync(["node", "start", alias, "--codex-bin", codexWrapper, "--no-inherit-codex-home", "--accept-dev-channels"]);
  const cfgPath = join(project, ".anet", "nodes", alias, "config.json");
  await waitUntil("thread promoted", () => JSON.parse(readFileSync(cfgPath, "utf8")).codexThreadId === "thread_windows_e2e");
  const appUrl = JSON.parse(readFileSync(cfgPath, "utf8")).codexAppServerUrl;
  await waitUntil("bridge took a launch snapshot", () => nodeLogText().includes("[app-server-watchdog] launch snapshot"));
  pass(`co-presence node up on ${appUrl}, thread promoted, launch snapshot taken`);

  const g = JSON.parse(readFileSync(join(userHome, ".anet", "config.json"), "utf8"));
  const auth = { Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" };
  const statusRow = async () => {
    const r = await fetch(`${hub}/api/status?network_id=${encodeURIComponent(g.network_id)}`, { headers: auth });
    const body = await r.json();
    return (body.sessions ?? []).find((s) => s.alias === alias) ?? null;
  };
  const dispatch = async (tag) => {
    const r = await fetch(`${hub}/api/task`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ alias, from: "twd", network_id: g.network_id, task: `twd-${tag}`, meta: { source: "dashboard-chat", client_request_id: `dreq_${tag.padEnd(32, "x").slice(0, 32)}` } }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const appserverReason = (row) => row?.degraded?.find((d) => d.layer === "app_server")?.reason ?? null;

  if (SCENARIO === "hung") {
    await hungScenario({ statusRow, dispatch, appserverReason, appUrl, codexHome });
  } else {
  const resumesBefore = (wire().match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length;
  const invokesBefore = [...wire().matchAll(/^invoke:(\["app-server".*)$/gm)].map((m) => m[1]);
  if (invokesBefore.length !== 1) fail(`expected exactly one app-server launch before the kill, saw ${invokesBefore.length}`);

  // ── kill #1 → degraded + refused → relaunched → ok + accepted ────────────────────────
  const pids = appServerPids();
  if (pids.length !== 1) fail(`expected one fake app-server process, found ${pids.length}`);
  execFileSync("kill", ["-KILL", String(pids[0])]);
  const degradedRow = await waitUntil("hub shows app_server degraded (restarting)", async () => {
    const row = await statusRow();
    return /^restarting app-server/.test(appserverReason(row) ?? "") ? row : null;
  });
  pass(`hub: degraded app_server — ${appserverReason(degradedRow)}`);
  const refused = await dispatch("during-restart");
  if (refused.body?.error !== "node_degraded") fail(`dispatch during the restart was not refused: ${refused.status} ${JSON.stringify(refused.body)}`);
  pass("dispatch during the restart refused with node_degraded");

  await waitUntil("hub degraded cleared", async () => {
    const row = await statusRow();
    return row && !row.degraded ? true : null;
  });
  const accepted = await dispatch("after-restart");
  if (!accepted.body?.task_id) fail(`dispatch after the restart was not accepted: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  pass("hub: degraded cleared on its own; dispatch accepted again");

  const invokesAfter = [...wire().matchAll(/^invoke:(\["app-server".*)$/gm)].map((m) => m[1]);
  if (invokesAfter.length !== 2 || invokesAfter[1] !== invokesAfter[0]) fail(`relaunch argv drifted:\n${invokesAfter.join("\n")}`);
  if (!invokesAfter[1].includes(JSON.stringify(appUrl))) fail("relaunch did not listen on the original url");
  const homes = [...wire().matchAll(/^appsrv-home:(.+)$/gm)].map((m) => m[1].trim());
  if (homes.length !== 2 || homes.some((h) => h !== codexHome)) fail(`relaunched CODEX_HOME drifted: ${homes.join(", ")} (want ${codexHome})`);
  const resumesAfter = (wire().match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length;
  if (resumesAfter <= resumesBefore) fail("bridge did not resume the original thread after the relaunch");
  if ((wire().match(/^rpc:thread\/start/gm) || []).length > 0) fail("a new thread was started instead of resuming the original one");
  if (!nodeLogText().includes("[app-server-watchdog] bridge re-attached")) fail("bridge did not log its re-attach");
  pass("same argv / --listen / CODEX_HOME, bridge resumed thread_windows_e2e (no thread/start)");

  // ── budget: max 2 in the window → kill #2 restarts, kill #3 gives up and stays degraded ─────
  execFileSync("kill", ["-KILL", String(await waitUntil("second app-server pid", () => appServerPids()[0]))]);
  await waitUntil("second restart healed", async () => {
    const row = await statusRow();
    return (await sleep(0), (wire().match(/^appsrv-home:/gm) || []).length === 3 && row && !row.degraded) ? true : null;
  });
  pass("second kill: restarted again (2/2)");
  execFileSync("kill", ["-KILL", String(await waitUntil("third app-server pid", () => appServerPids()[0]))]);
  const gaveUp = await waitUntil("hub shows gave up", async () => {
    const row = await statusRow();
    return /auto-restart gave up: 2 restarts/.test(appserverReason(row) ?? "") ? row : null;
  });
  pass(`hub: ${appserverReason(gaveUp)}`);
  await sleep(5_000);
  const still = await statusRow();
  if (!/auto-restart gave up/.test(appserverReason(still) ?? "")) fail(`gave-up state did not stick: ${JSON.stringify(still?.degraded)}`);
  if (appServerPids().length !== 0) fail("an app-server was started after giving up");
  if ((wire().match(/^appsrv-home:/gm) || []).length !== 3) fail("more than the budgeted restarts happened");
  const refusedAgain = await dispatch("after-give-up");
  if (refusedAgain.body?.error !== "node_degraded") fail(`dispatch after giving up was not refused: ${JSON.stringify(refusedAgain.body)}`);
  pass("still degraded 5s later, no further restart, dispatch refused");
  }
} finally {
  try { command(["node", "stop", alias]); } catch (e) { console.log(`stop: ${String(e?.message ?? e).slice(0, 300)}`); }
}
await sleep(1_000);
const leftover = (() => { try { return execFileSync("pgrep", ["-f", `testwd-codex-${runId} app-server`], { encoding: "utf8" }).trim(); } catch { return ""; } })();
if (leftover) throw new Error(`app-server left running after node stop: ${leftover}`);
console.log("PASS node stop left no app-server behind");
