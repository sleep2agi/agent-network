import { spawn } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertGrokCommhubMcpDoctor } from "../../agent-node/src/runtime/grok-build-cli-home";

type RpcResult = Record<string, unknown>;

function request(child: ReturnType<typeof spawn>, payload: Record<string, unknown>): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC_TIMEOUT:${payload.method}`)), 5_000);
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== payload.id) continue;
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        if (message.error) reject(new Error(`RPC_ERROR:${JSON.stringify(message.error)}`));
        else resolve(message.result || {});
        return;
      }
    };
    child.stdout?.on("data", onData);
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
  });
}

const root = mkdtempSync(join(tmpdir(), "test813-"));
const envFile = join(root, "commhub.env");
writeFileSync(envFile, "COMMHUB_URL=http://127.0.0.1:9\nCOMMHUB_TOKEN=fixture-token\n", { mode: 0o600 });
chmodSync(root, 0o700);

const child = spawn("bun", ["agent-network/src/node-server.ts"], {
  cwd: "/workspace",
  env: {
    ...process.env,
    ANET_COMMHUB_ENV_FILE: envFile,
    ANET_COMMHUB_MODE: "outbound-only",
    COMMHUB_ALIAS: "test813-dog",
    COMMHUB_RESUME_ID: "test813-resume",
    HOME: root,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

try {
  const initialized = await request(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test813", version: "1.0.0" },
    },
  });
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed: any = await request(child, {
    jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
  });
  const tools = (listed.tools || []).map((tool: any) => tool?.name).sort();
  const expected = [
    "commhub_get_all_status",
    "commhub_send_message",
    "commhub_send_task",
    "commhub_upload_file",
  ];
  if (JSON.stringify(tools) !== JSON.stringify(expected)) {
    throw new Error(`TOOL_SET_MISMATCH expected=${expected.join(",")} actual=${tools.join(",")}`);
  }
  if (!(initialized as any).serverInfo) throw new Error("INITIALIZE_HANDSHAKE_MISSING");

  const healthy = JSON.stringify({
    servers: [{
      name: "commhub",
      transport: "stdio",
      healthy: true,
      checks: [
        { label: "command found", passed: true },
        { label: "server started", passed: true },
        { label: "handshake OK", passed: true },
        { label: `${tools.length} tools discovered`, passed: true },
      ],
    }],
    healthy_count: 1,
    failing_count: 0,
  });
  assertGrokCommhubMcpDoctor(healthy);

  const stale = JSON.parse(healthy);
  stale.servers[0].checks[3].label = "3 tools discovered";
  let staleRejected = false;
  try { assertGrokCommhubMcpDoctor(JSON.stringify(stale)); } catch (error) {
    staleRejected = String(error).includes("4 tools discovered");
  }
  if (!staleRejected) throw new Error("STALE_THREE_TOOL_DOCTOR_ACCEPTED");
  process.stdout.write(`MCP_READINESS_PASS tools=${tools.join(",")}\n`);
} finally {
  child.stdin?.end();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  rmSync(root, { recursive: true, force: true });
}

if (stderr.includes("fatal:")) throw new Error(`MCP_CHILD_FATAL:${stderr}`);
