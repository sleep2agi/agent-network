// Docker only. Real upstream OpenCode and full ANet chain; only the model is a
// deterministic loopback stub. No production token, model call, or daemon.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "/run/test827";
const project = join(root, "project");
mkdirSync(project, { recursive: true, mode: 0o700 });
const hub = "http://127.0.0.1:9287";
const artifact = process.env.ARTIFACT_DIR!;
const responsePrefix = "ANSWER827_";
const env = { ...process.env, TERM: "xterm-256color" };
const pause = (ms = 200) => new Promise(r => setTimeout(r, ms));
function check(name: string, ok: unknown, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(name);
}
async function until(fn: () => Promise<boolean> | boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await pause(); }
  return false;
}
async function cli(args: string[], required = true) {
  const child = Bun.spawn(["bun", "/workspace/agent-network/bin/cli.ts", ...args], {
    cwd: project, env, stdin: new Blob(["\n"]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Do not copy registration tokens into public test evidence.
  const output = (stdout + stderr).replace(/\b(?:atok|ntok|utok)_[A-Za-z0-9_-]+/g, "[test-token]");
  console.log(`CLI ${args.slice(0, 3).join(" ")}: exit=${code}\n${output}`);
  if (required) check(`CLI ${args.slice(0, 3).join(" ")}`, code === 0);
  return { code, output };
}
const tmux = (...args: string[]) => spawnSync("tmux", ["-S", env.ANET_TMUX_SOCKET!, ...args], { env, encoding: "utf8" });
const pane = () => tmux("capture-pane", "-p", "-t", "=oc827:", "-S", "-200").stdout ?? "";
let token = "";
let networkId = "";
async function api(path: string, body?: unknown) {
  const r = await fetch(hub + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${await r.text()}`);
  return r.json() as Promise<any>;
}
async function task(text: string, failed = false) {
  check("response-only marker is absent from network prompt", !text.includes(responsePrefix));
  const sent = await api("/api/task", { alias: "oc827", task: text, network_id: networkId });
  check("Hub accepts task with concrete id", sent.ok && sent.message_id);
  let row: any;
  check("Hub records terminal state", await until(async () => {
    const found = await api(`/api/tasks?task_id=${encodeURIComponent(sent.message_id)}&network_id=${encodeURIComponent(networkId)}`);
    row = found.tasks?.find((t: any) => t.task_id === sent.message_id || t.id === sent.message_id) ?? found.tasks?.[0];
    return ["replied", "failed", "cancelled"].includes(row?.status);
  }, 60_000), sent.message_id);
  check("terminal state belongs to this task", (row.task_id ?? row.id) === sent.message_id, JSON.stringify(row));
  check(failed ? "provider error is failed, not replied" : "task replied", row.status === (failed ? "failed" : "replied"));
  return String(row.result ?? "");
}
const server = spawn("bun", ["src/index.ts"], {
  cwd: "/workspace/server", env: { ...env, PORT: "9287", COMMHUB_DB: join(root, "hub.db"), COMMHUB_AUTH_TOKEN: "test827-bootstrap" }, stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
server.stdout!.on("data", b => { hubLog += b; });
server.stderr!.on("data", b => { hubLog += b; });
const stub = spawn("python3", ["/test827/stub-model.py", "18827", join(artifact, "stub.log"), responsePrefix], { stdio: "inherit" });
let cfgPath = "";
try {
  console.log("L0 environment");
  check("exact real OpenCode V2", spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim() === "opencode v2.0.22");
  check("Hub health", await until(async () => fetch(hub + "/health").then(r => r.ok, () => false)));
  check("loopback model available", await until(async () => fetch("http://127.0.0.1:18827/v1/models").then(r => r.ok, () => false)));
  console.log("L1 authentication and CLI create");
  check("Hub rejects unauthenticated task dispatch", (await fetch(hub + "/api/task", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: "oc827", task: "must not run" }),
  })).status === 401);
  await cli(["init", "--hub", hub]);
  await cli(["register", "--username", "t827", "--password", "test827-password"]);
  await cli(["login", "--username", "t827", "--password", "test827-password"]);
  const created = await cli(["node", "create", "oc827", "--runtime", "opencode-cli", "--opencode-generation", "v2", "--opencode-unsafe-tools", "--model", "stub/stub-model"]);
  check("V2 create names its exact package, not V1", created.output.includes("@opencode/cli@2.0.22") && !created.output.includes("npm install -g opencode-ai@"));
  check("V2 create does not promise Claude/ACP policy", !/Claude Code preset|question DISABLED|not given CommHub MCP tools/.test(created.output));
  cfgPath = join(project, ".anet/nodes/oc827/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  token = JSON.parse(readFileSync(join(process.env.HOME!, ".anet/config.json"), "utf8")).token;
  networkId = cfg.network_id;
  check("CLI persists V2 explicit opt-in", cfg.opencodeGeneration === "v2" && cfg.opencodeMode === "copresence" && cfg.flags.opencodeUnsafeTools === true);
  const providerDir = join(project, ".anet/nodes/oc827/.config/opencode");
  mkdirSync(providerDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(providerDir, "opencode.json"), JSON.stringify({
    model: "stub/stub-model", provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: "http://127.0.0.1:18827/v1", apiKey: "test-only" }, models: { "stub-model": { name: "Stub" } } } },
  }), { mode: 0o600 });
  console.log("L2 single-command startup, real bridge and TUI");
  await cli(["node", "start", "oc827", "--copresence"]);
  check("TUI actually rendered", await until(() => /ctrl\+p/.test(pane())), pane().slice(-1000));
  // #832: exercise the actual packaged runtime's generated observer, not a
  // test plugin substituted into a manually launched OpenCode process.
  const launcherPath = join(project, ".anet/nodes/oc827/opencode-attach.sh");
  const launcher = readFileSync(launcherPath, "utf8");
  const dataRoot = /^export XDG_DATA_HOME='([^']+)'$/m.exec(launcher)?.[1];
  check("packaged V2 launcher owns an isolated data root", typeof dataRoot === "string" && dataRoot.startsWith("/run/"));
  const observers = readdirSync(dataRoot!).filter(name => name.startsWith("anet-commhub-registry-"));
  check("packaged runtime installed exactly one registry observer", observers.length === 1);
  const observerDir = join(dataRoot!, observers[0]);
  check("observer directory is private", (statSync(observerDir).mode & 0o777) === 0o700);
  check("observer is generated from bundled registry implementation", readFileSync(join(observerDir, "index.js"), "utf8").includes("ctx.tool.list()"));
  console.log("L3 Hub task -> model -> task receipt -> same TUI");
  const reply = await task("Reply with exactly NET827A");
  check("exact network reply with Hub sender envelope", reply === `[oc827] ${responsePrefix}NET827A`, reply);
  check("assistant network reply visible in human TUI", await until(() => pane().includes(`${responsePrefix}NET827A`)));
  console.log("L4 human turn and queued network task");
  check("human types in real TUI", tmux("send-keys", "-t", "=oc827:", "-l", "STUB_DELAY_3 Reply with exactly HUMAN827").status === 0);
  await pause(500);
  tmux("send-keys", "-t", "=oc827:", "Enter");
  check("human turn reached model before network dispatch", await until(() => readFileSync(join(artifact, "stub.log"), "utf8").includes("HUMAN827")));
  check("queued task gets its own answer", await task("Reply with exactly QUEUED827") === `[oc827] ${responsePrefix}QUEUED827`);
  check("assistant human reply remains visible in shared TUI", await until(() => pane().includes(`${responsePrefix}HUMAN827`)));
  console.log("L5 provider failure and recovery");
  const error = await task("STUB_FAIL now", true);
  check("upstream error preserved", error.includes("stub provider refused"), error);
  check("session recovers", await task("Reply with exactly NET827B") === `[oc827] ${responsePrefix}NET827B`);
  console.log("L6 policy refusal preserves the existing live generation");
  const originalConfig = readFileSync(cfgPath, "utf8");
  const safe = JSON.parse(originalConfig);
  delete safe.flags.opencodeUnsafeTools;
  const safeConfig = JSON.stringify(safe);
  writeFileSync(cfgPath, safeConfig, { mode: 0o600 });
  const panePid = tmux("display-message", "-p", "-t", "=oc827:", "#{pane_pid}").stdout;
  const liveRefused = await cli(["node", "start", "oc827", "--copresence"], false);
  check("unsafe opt-in cannot be bypassed on re-start", liveRefused.code !== 0 && liveRefused.output.includes("opencodeUnsafeTools"));
  check("refusal did not replace the live TUI", tmux("display-message", "-p", "-t", "=oc827:", "#{pane_pid}").stdout === panePid);
  check("refusal did not rewrite the profile", readFileSync(cfgPath, "utf8") === safeConfig);
  writeFileSync(cfgPath, originalConfig, { mode: 0o600 });
  check("existing bridge still handles tasks", await task("Reply with exactly PRESERVED827") === `[oc827] ${responsePrefix}PRESERVED827`);
  writeFileSync(join(artifact, "tui-live.txt"), pane());
  console.log("L7 lifecycle and cold fail-closed safe mode");
  await cli(["node", "stop", "oc827"]);
  check("both node tmux sessions gone", await until(() => tmux("has-session", "-t", "=oc827").status !== 0 && tmux("has-session", "-t", "=oc827-桥").status !== 0));
  check("no OpenCode or bridge process remains", await until(() => {
    const p = spawnSync("pgrep", ["-af", "opencode/cli|agent-node/dist/cli.js"], { encoding: "utf8" });
    return !p.stdout.trim();
  }));
  check("stop removes generated registry observer and launcher", await until(() => !existsSync(observerDir) && !existsSync(launcherPath)));
  writeFileSync(cfgPath, JSON.stringify(safe), { mode: 0o600 });
  const rejected = await cli(["node", "start", "oc827", "--copresence"], false);
  check("default safe mode refuses with actionable reason", rejected.code !== 0 && rejected.output.includes("opencodeUnsafeTools"));
  check("policy rejection is not mislabeled as launcher timeout", !rejected.output.includes("30s") && !rejected.output.includes("attach launcher"));
  check("refusal leaves no tmux session", tmux("list-sessions").status !== 0);
  console.log("PASS: all test827 layers");
} finally {
  writeFileSync(join(artifact, "tui.txt"), pane());
  if (cfgPath) {
    const bridgeLog = join(project, ".anet/nodes/oc827/logs/copresence-bridge.log");
    if (existsSync(bridgeLog)) writeFileSync(join(artifact, "bridge.log"), readFileSync(bridgeLog));
  }
  for (const session of ["oc827", "oc827-桥"]) tmux("kill-session", "-t", `=${session}`);
  server.kill("SIGTERM"); stub.kill("SIGTERM");
  writeFileSync(join(artifact, "hub.log"), hubLog);
}
