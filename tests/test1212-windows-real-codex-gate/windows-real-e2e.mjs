import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import pty from "../../agent-network/node_modules/node-pty/lib/index.js";
import { assistantItems, assistantSnapshot, pollCompletedAssistant } from "./thread-evidence.mjs";
import { attachConptyDiag, failureEvidence, failureReport } from "./failure-evidence.mjs";

if (process.platform !== "win32") throw new Error("real gate requires native Windows ConPTY");
const repo = resolve(import.meta.dirname, "../..");
// 配对版本从 agent-node/package.json 派生。写死在这里的话,每条发版 PR
// (它只改 package.json 的版本和 PAIRED_AGENT_NODE_VERSION) 都会让本门变红:
// cli.ts 拿新版本去校验,而 fixture 还声明着上一个版本。这不是配对失效,
// 是同一个事实被抄了第三份。真实安装出来的包版本就等于 package.json 里那个。
const pairedVersion = JSON.parse(readFileSync(join(repo, "agent-node", "package.json"), "utf8")).version;
const privateRoot = process.env.ANET_TEST1212_PRIVATE;
const artifacts = process.env.ANET_TEST1212_ARTIFACTS;
const expectedSha = process.env.ANET_EXPECTED_SOURCE_SHA;
const bun = process.env.ANET_TEST1212_BUN;
if (!privateRoot || !artifacts || !expectedSha || !bun || !existsSync(bun)) throw new Error("protected harness environment incomplete");
const work = join(privateRoot, "work"), home = process.env.HOME, codexHome = process.env.CODEX_HOME;
const project = join(work, "project"), nodeHome = join(project, ".anet", "nodes", "windows-real", "codex-home");
mkdirSync(project, { recursive: true });
const port = 19000 + Math.floor(Math.random() * 1000);
const token = `test1212-${randomUUID()}`;
const hubEnv = { ...process.env, PORT: String(port), COMMHUB_AUTH_TOKEN: token, DATABASE_URL: join(privateRoot, "hub.db") };
const hub = spawn(bun, ["run", "src/index.ts"], { cwd: join(repo, "server"), env: hubEnv, stdio: "ignore", windowsHide: true });
const cli = join(repo, "agent-network", "bin", "cli.ts");
const env = { ...process.env, HOME: home, USERPROFILE: home };
const marker = `WINDOWS_REAL_${randomUUID().replaceAll("-", "")}`;
const sleepSeconds = 70;
const evidence = { schema: "anet/windows-real-codex-gate/v1", result: "FAIL", notInCi: true, sourceSha: expectedSha, codexVersion: "0.148.0", platform: process.platform, conpty: true };
const delay = ms => new Promise(r => setTimeout(r, ms));
let phase = "setup";
async function wait(label, fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(200); } throw new Error(`timeout: ${label}`); }
function run(args, input = "") { const r = spawnSync(bun, [cli, ...args], { cwd: project, env, input, encoding: "utf8", timeout: 60000 }); if (r.status) throw new Error(`anet ${args.join(" ")} failed`); return `${r.stdout}${r.stderr}`; }
function terminal(args, drive, ms = 180000) { return new Promise((ok, bad) => { const startedAt = Date.now(); const child = pty.spawn(bun, [cli, ...args], { cwd: project, env, cols: 140, rows: 45 }); let out = ""; const timer = setTimeout(() => { child.kill(); bad(attachConptyDiag(new Error("ConPTY timeout"), { exitCode: null, elapsedMs: Date.now() - startedAt, out, timedOut: true })); }, ms); child.onData(d => { out += d; drive?.(child, out); }); child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? ok(out) : bad(attachConptyDiag(new Error(`ConPTY exit ${exitCode}`), { exitCode, elapsedMs: Date.now() - startedAt, out, timedOut: false })); }); }); }
async function task(auth, network, priority) { const r = await fetch(`http://127.0.0.1:${port}/api/task`, { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify({ alias: "windows-real", from: "test1212", network_id: network, priority, task: `${priority} gate message; reply with ${priority.toUpperCase()}_OK`, meta: { source: "dashboard-chat", client_request_id: randomUUID() } }) }); const b = await r.json(); if (!r.ok || !b.task_id) throw new Error("task post failed"); return b.task_id; }
async function readThread(remote, threadId) {
  const ws = new WebSocket(remote);
  await new Promise((ok, bad) => { const timer = setTimeout(() => bad(new Error("thread/read connect timeout")), 10000); ws.addEventListener("open", () => { clearTimeout(timer); ok(); }, { once: true }); ws.addEventListener("error", () => bad(new Error("thread/read websocket error")), { once: true }); });
  let id = 0;
  const rpc = (method, params) => new Promise((ok, bad) => { const requestId = ++id; const timer = setTimeout(() => bad(new Error(`${method} timeout`)), 10000); const receive = event => { const msg = JSON.parse(String(event.data)); if (msg.id !== requestId) return; ws.removeEventListener("message", receive); clearTimeout(timer); msg.error ? bad(new Error(`${method} rejected`)) : ok(msg.result); }; ws.addEventListener("message", receive); ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })); });
  try {
    await rpc("initialize", { clientInfo: { name: "anet-test1212-authoritative-reader", version: "1" } });
    return (await rpc("thread/read", { threadId, includeTurns: true })).thread;
  } finally { ws.close(); }
}
try {
  phase = "hub-boot";
  await wait("temporary Hub", async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } });
  phase = "register-login-create";
  run(["register", "--username", "test1212", "--password", "pass123456", "--hub", `http://127.0.0.1:${port}`]);
  run(["login", "--username", "test1212", "--password", "pass123456", "--hub", `http://127.0.0.1:${port}`]);
  run(["node", "create", "windows-real", "--runtime", "codex-app-server", "--copresence", "true", "--hub", `http://127.0.0.1:${port}`]);
  mkdirSync(nodeHome, { recursive: true });
  writeFileSync(join(nodeHome, "auth.json"), readFileSync(join(codexHome, "auth.json")), { mode: 0o600 });
  phase = "pin-agent-node";
  const exactRoot = join(privateRoot, "exact", "node_modules", "@sleep2agi", "agent-node"), exactDist = join(exactRoot, "dist");
  mkdirSync(exactDist, { recursive: true });
  writeFileSync(join(exactRoot, "package.json"), JSON.stringify({ name: "@sleep2agi/agent-node", version: pairedVersion, publishConfig: { tag: "preview" }, bin: { "agent-node": "dist/cli.js" } }));
  writeFileSync(join(exactDist, "cli.js"), `await import(${JSON.stringify(pathToFileURL(join(repo, "agent-node", "dist", "cli.js")).href)});\n`);
  env.ANET_AGENT_NODE_BIN = join(exactDist, "cli.js");
  // Pin the executable without installing it globally. The cmd shim is private.
  const bin = join(privateRoot, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex.cmd"), `@echo off\r\ncall "${process.env.ANET_TEST1212_CODEX}" %*\r\n`);
  env.PATH = `${bin};${env.PATH}`;
  const cfgPath = join(project, ".anet", "nodes", "windows-real", "config.json");
  let injected = false, injectionAt = 0, activeTurnId, preAssistantSnapshot, taskIds = [], drivePromise, driveError;
  phase = "first-node-start-conpty";
  await terminal(["node", "start", "windows-real", "--no-inherit-codex-home"], (child, output) => {
    if (!injected && output.includes("opening Codex TUI")) {
      injected = true;
      setTimeout(() => child.write(`Use PowerShell to run Start-Sleep -Seconds ${sleepSeconds}; then reply exactly ${marker} HUMAN_DONE\r`), 2500);
      setTimeout(() => {
        drivePromise = (async () => {
          injectionAt = Date.now();
          const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
          const activeThread = await readThread(cfg.codexAppServerUrl, cfg.codexThreadId);
          const activeTurn = activeThread.turns?.at(-1);
          if (!activeTurn?.id || activeTurn.status !== "inProgress" || !JSON.stringify(activeTurn.items || []).includes(marker)) throw new Error("authoritative thread/read did not show the human tool turn active before task injection");
          activeTurnId = activeTurn.id;
          preAssistantSnapshot = assistantSnapshot(activeTurn);
          if (assistantItems(activeTurn).some(item => item.text.includes(marker) && item.text.includes("HUMAN_DONE"))) throw new Error("HUMAN_DONE assistant item existed before task injection");
          const global = JSON.parse(readFileSync(join(home, ".anet", "config.json"), "utf8"));
          taskIds = await Promise.all([task(global.token, global.network_id, "normal"), task(global.token, global.network_id, "high")]);
          await wait("both task replies", async () => { const r = await fetch(`http://127.0.0.1:${port}/api/tasks?network_id=${global.network_id}&skip_stats=1`, { headers: { Authorization: `Bearer ${global.token}` } }); const b = await r.json(); const rows = Array.isArray(b) ? b : b.tasks; return taskIds.every(id => rows.some(x => x.task_id === id && ["completed", "replied"].includes(x.status))); }, 130000);
          await pollCompletedAssistant(
            () => readThread(cfg.codexAppServerUrl, cfg.codexThreadId),
            activeTurnId, preAssistantSnapshot, marker,
            { timeoutMs: 30000, intervalMs: 300 },
          );
          if (Date.now() - injectionAt < 60000) throw new Error("same human turn completed before 60s active-turn witness");
          evidence.thread = `sha256:${createHash("sha256").update(cfg.codexThreadId).digest("hex")}`;
        })().catch(error => { driveError = error; }).finally(() => child.write("/exit\r"));
      }, 7000);
    }
  });
  phase = "active-turn-witness";
  if (drivePromise) await drivePromise;
  if (driveError) throw driveError;
  if (!injected || !injectionAt || !activeTurnId || !preAssistantSnapshot || !taskIds.length) throw new Error("active human turn was not driven");
  phase = "bridge-and-steer-checks";
  const cfg1 = JSON.parse(readFileSync(cfgPath, "utf8"));
  const bridgeLog = readFileSync(join(project, ".anet", "nodes", "windows-real", "windows-bridge.log"), "utf8");
  const steered = (bridgeLog.match(/\(steered\)/g) || []).length;
  if (steered !== 2 || /\(queued|FIFO|new turn/i.test(bridgeLog)) throw new Error("normal/high did not both steer the active turn");
  const managed = JSON.parse(readFileSync(join(project, ".anet", "nodes", "windows-real", "windows-copresence.json"), "utf8"));
  if (managed.processes.filter(x => x.role === "bridge").length !== 1) throw new Error("not exactly one bridge");
  phase = "stop";
  run(["node", "stop", "windows-real"]);
  if (existsSync(join(project, ".anet", "nodes", "windows-real", "windows-copresence.json"))) throw new Error("stop left managed processes");
  phase = "restart-preserves-thread";
  let exited = false;
  await terminal(["node", "start", "windows-real", "--no-inherit-codex-home"], (child, output) => { if (!exited && output.includes(marker)) { exited = true; child.write("/exit\r"); } }, 90000);
  const cfg2 = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (!exited || cfg2.codexThreadId !== cfg1.codexThreadId) throw new Error("restart did not preserve thread/history");
  run(["node", "stop", "windows-real"]);
  Object.assign(evidence, { result: "PASS", sourceBound: true, codexLauncherSha256: process.env.ANET_TEST1212_LAUNCHER_SHA256, codexVendorSha256: process.env.ANET_TEST1212_VENDOR_SHA256, realBuiltAgentNode: true, sameHomeRemoteThread: true, activeHumanTurnSecondsMinimum: 60, humanTurnBoundary: "authoritative thread/read: inProgress before task posts; same turn completed with HUMAN_DONE assistant item after task terminals", priorities: ["normal", "high"], taskCount: 2, steeredCount: 2, turnStartOutcomeDelta: 0, turnStartEvidenceBoundary: "derived from two production bridge '(steered)' outcomes and absence of queued/new-turn outcome; not a raw RPC wire count", bridgeCount: 1, stopRestartHistory: true, rawLogsUploaded: false });
  writeFileSync(join(artifacts, "result.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(join(artifacts, "report.txt"), `test1212 Windows real Codex protected manual gate\nresult: PASS\nsource: ${expectedSha}\nNOT-IN-CI: credentialed GitHub-hosted windows-latest/ConPTY gate\nCodex: 0.148.0; real built agent-node: yes\nnormal+high: authoritative thread/read active before posts, same turn completed with HUMAN_DONE after terminals and >=60s\nturn/start outcome delta: 0 (derived bridge outcome, NOT raw-wire evidence)\nsame HOME/remote/thread; one bridge; stop/restart history: PASS\ncredentials, raw logs, paths and thread IDs: not uploaded\n`);
} catch (error) {
  // #1749 —— 失败也要留下能定位的证据(脱敏后)。之前只有 run.ps1 的 catch 写一个
  // 没有信息量的 FAIL。私有路径与本次 token 一律打码;真凭据(auth.json)从不进 artifact。
  const ev = failureEvidence({ error, phase, base: evidence, redact: { secrets: [token, process.env.COMMHUB_AUTH_TOKEN], paths: [privateRoot, home, codexHome] } });
  try { writeFileSync(join(artifacts, "result.json"), JSON.stringify(ev, null, 2)); writeFileSync(join(artifacts, "report.txt"), failureReport(ev)); } catch {}
  throw error;
} finally { try { run(["node", "stop", "windows-real"]); } catch {} hub.kill(); }
