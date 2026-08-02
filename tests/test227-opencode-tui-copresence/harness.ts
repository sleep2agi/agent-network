import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOpenCodeCopresenceRuntime } from "/agent-node-src/src/runtime/opencode-copresence/runtime";

const root = mkdtempSync(join(tmpdir(), "anet-test227-"));
chmodSync(root, 0o700);
const project = join(root, "project");
const workDir = join(root, "node");
mkdirSync(project, { recursive: true, mode: 0o700 });
mkdirSync(join(workDir, ".config", "opencode"), { recursive: true, mode: 0o700 });
writeFileSync(
  join(workDir, ".config", "opencode", "opencode.json"),
  JSON.stringify({ model: process.env.OPENCODE_FREE_MODEL || "opencode/north-mini-code-free" }),
  { mode: 0o600 },
);

const tmuxName = "opencode-test227-tui";
let runtime: Awaited<ReturnType<typeof openOpenCodeCopresenceRuntime>> | undefined;
const checks: Record<string, unknown> = {};
const mcpCalls: Array<{ name: string; arguments: unknown }> = [];
let mcpAuthenticated = true;
const mcpToken = "test227-node-token";
const mcpServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${mcpToken}`) {
      mcpAuthenticated = false;
      return new Response("unauthorized", { status: 401 });
    }
    if (request.method === "GET") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const body: any = await request.json();
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const response = (result: unknown) => Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "mcp-session-id": "test227-session" } },
    );
    if (body.method === "initialize") return response({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "test227-commhub", version: "1" },
    });
    if (body.method === "tools/list") return response({ tools: [{
      name: "send_message",
      description: "Send an informational CommHub message",
      inputSchema: {
        type: "object",
        properties: { alias: { type: "string" }, message: { type: "string" } },
        required: ["alias", "message"],
        additionalProperties: false,
      },
    }] });
    if (body.method === "tools/call") {
      mcpCalls.push({ name: body.params?.name, arguments: body.params?.arguments });
      return response({ content: [{ type: "text", text: JSON.stringify({ ok: true, message_id: "test227-message" }) }] });
    }
    if (body.method === "ping") return response({});
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } });
  },
});

function pane(): string {
  return execFileSync("tmux", ["capture-pane", "-e", "-p", "-t", tmuxName, "-S", "-200"], { encoding: "utf8" });
}

async function waitForPane(marker: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pane().includes(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

try {
  runtime = await openOpenCodeCopresenceRuntime({
    cwd: project,
    workDir,
    expectedVersion: process.env.OPENCODE_VERSION_UNDER_TEST || "1.18.1",
    binarySearchPath: process.env.PATH || "",
    model: process.env.OPENCODE_FREE_MODEL || "opencode/north-mini-code-free",
    commhubMcpUrl: `http://127.0.0.1:${mcpServer.port}/mcp`,
    commhubToken: mcpToken,
    commhubAlias: "test227-node",
    startupTimeoutMs: 30_000,
  });
  checks.loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url);
  checks.session = runtime.sessionId;
  checks.launcherMode = statSync(runtime.attachScriptPath).mode & 0o777;
  const launcher = readFileSync(runtime.attachScriptPath, "utf8");
  checks.launcherUsesOfficialAttach = launcher.includes(" attach ") && launcher.includes(runtime.sessionId);
  checks.launcherDoesNotLogPassword = !launcher.includes("set -x");

  execFileSync("tmux", ["new-session", "-d", "-s", tmuxName, "-x", "140", "-y", "45", runtime.attachScriptPath]);
  checks.tuiAliveBefore = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;
  checks.tuiRenderedBefore = await waitForPane("ctrl+p", 15_000);

  const noticeMarker = `NOTICE227_${Date.now().toString(36)}`;
  await runtime.notify(`[dashboard] ${noticeMarker}`, 30_000);
  checks.informationalMessageVisible = await waitForPane(noticeMarker, 5_000);
  checks.tuiAliveAfterNotice = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;

  const outboundMarker = `OUTBOUND227_${Date.now().toString(36)}`;
  const outbound = await runtime.submit(
    `Call commhub_send_message with alias test227-target and message ${outboundMarker}. You must call the tool.`,
    180_000,
  );
  checks.mcpAuthenticated = mcpAuthenticated;
  checks.outboundReplyLength = outbound.replyText.length;
  checks.outboundToolCalled = mcpCalls.some((call) =>
    call.name === "send_message" &&
    (call.arguments as any)?.alias === "test227-target" &&
    (call.arguments as any)?.message === outboundMarker
  );

  const marker = `TUI227_${Date.now().toString(36)}`;
  const first = await runtime.submit(`Reply with exactly ${marker}`, 180_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const firstPane = pane();
  checks.firstReplyLength = first.replyText.length;
  checks.noticeDidNotLeakIntoFirstReply = !first.replyText.includes(noticeMarker);
  checks.sharedTurnVisibleInTui = firstPane.includes(marker);
  checks.tuiAliveAfterFirst = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;

  const second = await runtime.submit("Reply with exactly SECOND_TURN_OK", 180_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  checks.secondReplyLength = second.replyText.length;
  checks.tuiAliveAfterSecond = execFileSync("tmux", ["has-session", "-t", tmuxName]).length === 0;
  checks.runtimeAliveAfterSecond = runtime.isRunning;

  const failed = [
    checks.loopback === true,
    typeof checks.session === "string" && /^ses_/.test(checks.session),
    checks.launcherMode === 0o700,
    checks.launcherUsesOfficialAttach === true,
    checks.launcherDoesNotLogPassword === true,
    checks.tuiAliveBefore === true,
    checks.tuiRenderedBefore === true,
    checks.informationalMessageVisible === true,
    checks.tuiAliveAfterNotice === true,
    checks.mcpAuthenticated === true,
    checks.outboundToolCalled === true,
    Number(checks.outboundReplyLength) > 0,
    Number(checks.firstReplyLength) > 0,
    checks.noticeDidNotLeakIntoFirstReply === true,
    checks.sharedTurnVisibleInTui === true,
    checks.tuiAliveAfterFirst === true,
    Number(checks.secondReplyLength) > 0,
    checks.tuiAliveAfterSecond === true,
    checks.runtimeAliveAfterSecond === true,
  ].some((ok) => !ok);
  console.log(JSON.stringify({ checks, paneTail: firstPane.slice(-2500) }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", tmuxName]); } catch {}
  await runtime?.close();
  mcpServer.stop(true);
  checks.launcherRemoved = runtime ? !existsSync(runtime.attachScriptPath) : false;
  rmSync(root, { recursive: true, force: true });
}
