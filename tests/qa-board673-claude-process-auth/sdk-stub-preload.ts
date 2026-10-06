// Board #673. Stub the SDK query that processWithClaude imports, so the
// real cli.ts loop runs against a scripted upstream instead of Claude CLI.
import { mock } from "bun:test";
import * as fs from "fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CAPTURE = process.env.BOARD673_CAPTURE_FILE || "/tmp/board673-capture.jsonl";

function record(entry: Record<string, unknown>) {
  try {
    fs.appendFileSync(CAPTURE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {
    // The suite reads the hub reply. A capture miss must not hide that.
  }
}

function success(text: string) {
  return {
    type: "result",
    subtype: "success",
    result: text,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.0001,
    num_turns: 1,
  };
}

let calls = 0;

async function* fakeQuery(_args: any) {
  calls += 1;
  const scenario = process.env.BOARD673_SCENARIO || "";
  record({ call: calls, scenario });
  if (scenario === "recover") {
    yield { type: "system", subtype: "api_retry", attempt: 1, error_status: 401, error: "authentication_failed" };
    yield { type: "system", subtype: "init", session_id: "board673-session" };
    yield success("BOARD673_RECOVERED_OK");
    return;
  }
  if (scenario === "auth") {
    yield { type: "system", subtype: "api_retry", attempt: 1, error_status: 401, error: "authentication_failed" };
    yield { type: "system", subtype: "api_retry", attempt: 2, error_status: 401, error: "authentication_failed" };
    // Reached only when the abort branch did not return.
    yield success("BOARD673_SHOULD_HAVE_ABORTED");
    return;
  }
  if (scenario === "region" || scenario === "permission") {
    if (calls >= 3) {
      yield success("BOARD673_LEAKED");
      return;
    }
    const result = scenario === "region"
      ? "Failed to authenticate. API Error: 403 Request not allowed"
      : "Failed to authenticate. API Error: 403 Your API key does not have permission to perform this action";
    throw new Error(`Claude Code returned an error result: ${result}`);
  }
  throw new Error(`board673 stub: unknown scenario ${scenario}`);
}

function fakeCreateSdkMcpServer(cfg: any) {
  return { name: cfg?.name || "stub", version: cfg?.version || "0", instance: {}, tools: cfg?.tools || [] };
}
function fakeTool(..._a: any[]) {
  return {};
}

const sdkFactory = () => ({
  query: fakeQuery,
  createSdkMcpServer: fakeCreateSdkMcpServer,
  tool: fakeTool,
});

const repo = process.env.REPO || "/app";
try {
  const requireFromAgentNode = createRequire(join(repo, "agent-node", "package.json"));
  const resolvedSdk = requireFromAgentNode.resolve("@anthropic-ai/claude-agent-sdk");
  mock.module(resolvedSdk, sdkFactory);
  mock.module(pathToFileURL(resolvedSdk).href, sdkFactory);
} catch {
  // Host debug path may hoist the package. The bare name below still applies.
}
mock.module("@anthropic-ai/claude-agent-sdk", sdkFactory);
