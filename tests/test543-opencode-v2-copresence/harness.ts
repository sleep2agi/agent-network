// #543 — OpenCode V2 (@opencode/cli) co-presence PREVIEW against the REAL
// binary and a loopback stub model. Docker only: private tmux socket
// (-L test543), throwaway HOME/work dirs, no Hub, no credentials.
//
// Layers (a layer only runs when the one before it passed):
//   1  why the gate exists: real V2 serve ignores the V1 safety env
//   2  the gate: production entry + agent-node CLI refuse V2 under the safe preset
//   3  opt-in runtime: real serve + package gate, CommHub MCP connects
//   4  shared TUI: real `opencode --server … --session …`, network turn visible
//   5  arbitration: human turn in the TUI first, queued network turn gets its own answer
//   6  provider error fails the task (not a false "replied")
//   7  lifecycle: close stops serve + TUI, no background service

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/agent-node-src/src/runtime/opencode-copresence/runtime";
import { OPENCODE_V2_BACKEND } from "/agent-node-src/src/runtime/opencode-backend";
import { OpenCodeProviderError } from "/agent-node-src/src/runtime/opencode-provider-error";

const STUB_PORT = 18543;
const STUB_LOG = "/tmp/test543-stub.log";
const SOCK = "test543";
const TUI = "oc2-tui";
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
const tmuxRunner = (args: string[]) => tmux(...args);
let failures = 0;
let layerFailed = false;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) { failures++; layerFailed = true; }
}
function layer(title: string): boolean {
  if (layerFailed) {
    console.log(`\n## ${title}\nSKIP: an earlier layer failed`);
    return false;
  }
  console.log(`\n## ${title}`);
  return true;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function stubLog(): Array<{ path: string; tools: string[]; user: string }> {
  if (!existsSync(STUB_LOG)) return [];
  return readFileSync(STUB_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function opencodeProcs(): string[] {
  const r = spawnSync("pgrep", ["-af", "opencode/cli"], { encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n").filter((l) => l && !l.includes("pgrep"));
}
function pane(): string {
  try { return tmux("capture-pane", "-p", "-t", TUI, "-S", "-300"); } catch { return ""; }
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(200); }
  return pred();
}

const stub = spawn("python3", ["/test543/stub-model.py", String(STUB_PORT), STUB_LOG], { stdio: "inherit" });
const PROVIDER = {
  stub: {
    npm: "@ai-sdk/openai-compatible",
    name: "Stub",
    options: { baseURL: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: "stub-not-a-secret" },
    models: { "stub-model": { name: "Stub" } },
  },
};
const MODEL = "stub/stub-model";
const binary = execFileSync("bash", ["-c", "readlink -f \"$(command -v opencode)\""], { encoding: "utf8" }).trim();

const mcpToken = "test543-node-token";
const mcpSeen: string[] = [];
const mcpMethods: string[] = [];
const mcp = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    mcpSeen.push(`${request.method} ${request.headers.get("authorization") === `Bearer ${mcpToken}` ? "auth-ok" : "auth-bad"}`);
    if (request.headers.get("authorization") !== `Bearer ${mcpToken}`) return new Response("unauthorized", { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body: any = await request.json().catch(() => ({}));
    mcpMethods.push(String(body.method ?? ""));
    if (String(body.method ?? "").startsWith("notifications/")) return new Response(null, { status: 202 });
    const r = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "s543" } });
    if (body.method === "initialize") return r({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test543-commhub", version: "1" } });
    // This fixture verifies transport/startup, not tool execution. Match the
    // minimum real CommHub task contract required by the product readiness
    // gate; do not weaken that gate to accommodate an incomplete fake.
    if (body.method === "tools/list") return r({ tools: [
      { name: "send_message", description: "send", inputSchema: { type: "object", properties: { alias: { type: "string" } } } },
      { name: "send_task", description: "dispatch a task", inputSchema: { type: "object", properties: { alias: { type: "string" }, task: { type: "string" } }, required: ["alias", "task"] } },
      { name: "get_task", description: "read a task receipt", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
    ] });
    if (body.method === "ping") return r({});
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nf" } });
  },
});

let runtime: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
const root = mkdtempSync(join(tmpdir(), "anet-test543-"));
chmodSync(root, 0o700);
try {
  await sleep(500);
  console.log(`binary: ${binary}`);
  console.log(`version: ${execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()}`);

  // ── Layer 1 ────────────────────────────────────────────────────────────
  if (layer("Layer 1 — real V2 serve ignores the V1 safety env (why V2 needs the gate)")) {
    const home = join(root, "raw-home");
    const ws = join(root, "raw-ws");
    mkdirSync(home, { recursive: true }); mkdirSync(ws, { recursive: true });
    const port = 24543;
    const env = {
      PATH: process.env.PATH!, HOME: home, OPENCODE_PASSWORD: "pw",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: PROVIDER, model: MODEL }),
      // The V1 safe preset's deny-all levers:
      OPENCODE_PERMISSION: JSON.stringify({ "*": "deny", bash: "deny", edit: "deny", read: "deny", write: "deny" }),
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    };
    const serve = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: ws, env, stdio: "ignore" });
    const auth = { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`, "content-type": "application/json" };
    const base = `http://127.0.0.1:${port}`;
    await waitFor(() => spawnSync("curl", ["-sf", "-o", "/dev/null", "-u", "opencode:pw", `${base}/api/info`]).status === 0, 20_000);
    const sid = (await (await fetch(`${base}/api/session`, { method: "POST", headers: auth, body: JSON.stringify({ title: "raw", model: { providerID: "stub", id: "stub-model" } }) })).json() as any).data.id;
    const before = stubLog().length;
    await fetch(`${base}/api/session/${sid}/prompt`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Reply with exactly RAW543", delivery: "queue" }) });
    await waitFor(() => stubLog().length > before, 20_000);
    const offered = stubLog().at(-1)?.tools ?? [];
    console.log(`tools offered under OPENCODE_PERMISSION deny-all + OPENCODE_PURE=1: ${JSON.stringify(offered)}`);
    check("V2 still offers shell/edit/write/read to the model despite the V1 deny-all env", ["shell", "edit", "write", "read"].every((t) => offered.includes(t)));
    serve.kill("SIGKILL");
    await sleep(300);
  }

  // ── Layer 2 ────────────────────────────────────────────────────────────
  if (layer("Layer 2 — the gate refuses V2 under the default safe preset")) {
    const work = join(root, "node-safe");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const procsBefore = opencodeProcs().length;
    const error: any = await openOpenCodeCopresenceRuntime({
      backend: OPENCODE_V2_BACKEND, cwd: work, workDir: work, model: MODEL, unsafeTools: false,
      binarySearchPath: process.env.PATH!, startupTimeoutMs: 20_000,
    }).then((s) => { void s.close(); return null; }, (e) => e);
    check("production entry refuses (safe preset)", /default safe preset/.test(error?.message ?? ""), error?.message);
    check("…with one line naming flags.opencodeUnsafeTools=true", !String(error?.message).includes("\n") && /flags\.opencodeUnsafeTools=true/.test(error?.message ?? ""));
    check("…and spawned no opencode process", opencodeProcs().length === procsBefore);

    // agent-node CLI: same refusal at boot, before any Hub contact.
    const cliDir = join(root, "cli-node");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    const cfg = join(cliDir, "config.json");
    writeFileSync(cfg, JSON.stringify({
      runtime: "opencode-cli", alias: "t543", hub: "http://127.0.0.1:9", model: MODEL,
      opencodeGeneration: "v2", opencodeMode: "copresence", flags: {}, channels: [], env: {},
    }, null, 2) + "\n", { mode: 0o600 });
    const cli = spawnSync("bun", ["/agent-node-src/src/cli.ts", "--config", cfg, "--alias", "t543", "--runtime", "opencode-cli"], {
      cwd: cliDir, encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: cliDir },
    });
    const out = `${cli.stdout}\n${cli.stderr}`;
    const refusalLine = out.split("\n").find((l) => l.includes("Refusing OpenCode v2"));
    check("agent-node CLI exits 1 for a V2 node without the flag", cli.status === 1, `status=${cli.status}`);
    check("…printing the one-line refusal with the config path", Boolean(refusalLine?.includes(cfg)), refusalLine ?? out.slice(-600));
  }

  // ── Layer 3 ────────────────────────────────────────────────────────────
  let workDir = "";
  let launchRoot = "";
  if (layer("Layer 3 — opt-in (flags.opencodeUnsafeTools=true): real serve, package gate, CommHub MCP")) {
    workDir = join(root, "node-v2");
    mkdirSync(join(workDir, ".config", "opencode"), { recursive: true, mode: 0o700 });
    writeFileSync(join(workDir, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: PROVIDER, model: MODEL }), { mode: 0o600 });
    const project = join(root, "project");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    const modelCallsBeforeStartup = stubLog().length;
    runtime = await openOpenCodeCopresenceRuntime({
      backend: OPENCODE_V2_BACKEND, cwd: project, workDir, model: MODEL, unsafeTools: true,
      binarySearchPath: process.env.PATH!, startupTimeoutMs: 30_000,
      commhubMcpUrl: `http://127.0.0.1:${mcp.port}/mcp`, commhubToken: mcpToken, commhubAlias: "test543-node",
      tmuxRunner, log: (m) => console.log(`  log: ${m}`), warn: (m) => console.log(`  warn: ${m}`),
    });
    check("loopback serve", /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url), runtime.url);
    check("V2 session id", /^ses_/.test(runtime.sessionId), runtime.sessionId);
    const launcher = readFileSync(runtime.attachScriptPath, "utf8");
    // Read only the generated test path, never log the credential-bearing script.
    const dataRoot = launcher.match(/^export XDG_DATA_HOME='([^']+)'$/m)?.[1];
    launchRoot = dataRoot ? dirname(dataRoot) : "";
    check("captured existing private launch root", Boolean(launchRoot) && existsSync(launchRoot));
    check("launcher joins with --server/--session (no attach, no --pure)",
      launcher.includes(`--server '${runtime.url}' --session '${runtime.sessionId}'`) && !launcher.includes(" attach ") && !launcher.includes("--pure"));
    check("launcher spawns the gated package binary", launcher.includes(`exec '${binary}'`));
    check("MCP tools discovered before ready, without a model warmup", mcpMethods.includes("tools/list") && stubLog().length === modelCallsBeforeStartup);
    check("no unauthenticated MCP startup call", !mcpSeen.some((s) => s.endsWith("auth-bad")));
  }

  // ── Layer 4 ────────────────────────────────────────────────────────────
  if (runtime && layer("Layer 4 — real human TUI attached; a network turn is visible in it")) {
    tmux("new-session", "-d", "-s", TUI, "-x", "150", "-y", "45", runtime.attachScriptPath);
    check("TUI rendered", await waitFor(() => /ctrl\+p/.test(pane()), 30_000), pane().slice(-600));
    const r1 = await runtime.submit("Reply with exactly NET543A", 60_000, "test543-peer");
    check("network task reply", r1.replyText === "NET543A", r1.replyText);
    check("network turn visible in the TUI", await waitFor(() => pane().includes("NET543A"), 10_000));
    check("sender provenance visible in the TUI", pane().includes("[来自 test543-peer]"));
    // Startup now waits for the final registry; retain the after-turn auth
    // check to detect an unexpected credential change during actual use.
    check("CommHub MCP connected with the node bearer token", await waitFor(() => mcpSeen.some((s) => s.startsWith("POST auth-ok")), 15_000), mcpSeen.join(","));
    check("no unauthenticated MCP call", !mcpSeen.some((s) => s.endsWith("auth-bad")));
  }

  // ── Layer 5 ────────────────────────────────────────────────────────────
  if (runtime && layer("Layer 5 — human turn first, network turn queued behind it gets its OWN answer")) {
    tmux("send-keys", "-t", TUI, "-l", "STUB_DELAY_3 Reply with exactly HUMAN543");
    await sleep(800);
    tmux("send-keys", "-t", TUI, "Enter");
    await sleep(1_200);
    const r2 = await runtime.submit("Reply with exactly NET543B", 60_000);
    check("queued network turn answered with its own text (not the human's)", r2.replyText === "NET543B", r2.replyText);
    check("human turn answered in the TUI", await waitFor(() => pane().includes("HUMAN543"), 10_000));
    const order = stubLog().map((e) => e.user).filter((u) => /HUMAN543|NET543B/.test(u));
    check("model saw the human turn before the network turn", order.findIndex((u) => u.includes("HUMAN543")) < order.findIndex((u) => u.includes("NET543B")), JSON.stringify(order));

    // Observation (reverse order): the human types WHILE a network turn runs.
    // Whatever the TUI does (queue or steer), a human answer must never be
    // claimed as the network reply.
    const pending = runtime.submit("STUB_DELAY_3 Reply with exactly NET543C", 60_000).then((r) => ({ r }), (e) => ({ e }));
    await sleep(1_000);
    tmux("send-keys", "-t", TUI, "-l", "Reply with exactly HUMAN543D");
    await sleep(500);
    tmux("send-keys", "-t", TUI, "Enter");
    const c: any = await pending;
    console.log(`observation: human typed mid network turn → ${c.r ? `reply=${c.r.replyText}` : `error=${c.e?.ownershipReason ?? c.e?.message}`}`);
    check("a human answer is never returned as the network reply", c.r ? c.r.replyText === "NET543C" : Boolean(c.e?.ownershipReason), JSON.stringify(c.r ?? c.e?.message));
    await waitFor(() => pane().includes("HUMAN543D"), 10_000);
  }

  // ── Layer 6 ────────────────────────────────────────────────────────────
  if (runtime && layer("Layer 6 — provider error fails the task with the upstream text")) {
    const e: any = await runtime.submit("STUB_FAIL now", 60_000).then(() => null, (x) => x);
    check("OpenCodeProviderError", e instanceof OpenCodeProviderError, e?.message);
    check("…carrying the upstream message", /stub provider refused: STUB_FAIL requested/.test(e?.message ?? ""), e?.message);
    const after = await runtime.submit("Reply with exactly NET543E", 60_000);
    check("session keeps working after the error", after.replyText === "NET543E", after.replyText);
  }

  // ── Layer 7 ────────────────────────────────────────────────────────────
  if (runtime && layer("Layer 7 — lifecycle")) {
    const launcherPath = runtime.attachScriptPath;
    await runtime.close();
    check("runtime reports stopped", runtime.isRunning === false);
    check("launcher removed", !existsSync(launcherPath));
    check("serve + TUI processes gone", await waitFor(() => opencodeProcs().length === 0, 10_000), opencodeProcs().join(" | "));
    check("close reclaimed private launch root including registry observer", Boolean(launchRoot) && !existsSync(launchRoot));
    check("no per-user background service was started", !opencodeProcs().some((p) => p.includes("--service"))
      && spawnSync("curl", ["-s", "-o", "/dev/null", "--max-time", "2", "http://127.0.0.1:49374/api/info"]).status !== 0);
    runtime = undefined;
  }
} catch (error: any) {
  check("harness ran to completion", false, `${error?.stack ?? error}\n${error?.startupOutput ?? ""}`);
} finally {
  await runtime?.close().catch(() => {});
  try { tmux("kill-session", "-t", `=${TUI}`); } catch {}
  mcp.stop(true);
  stub.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}
console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
