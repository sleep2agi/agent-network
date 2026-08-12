import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const capturePath = process.env.TEST697_CLAUDE_CAPTURE || "/tmp/test697-claude-capture.json";

async function* fakeQuery(args: any) {
  writeFileSync(capturePath, JSON.stringify({
    model: args?.options?.model ?? null,
    runtime_probe: "claude-agent-sdk",
  }));
  yield { type: "system", subtype: "init", session_id: "test697-claude-session" } as any;
  yield {
    type: "result",
    subtype: "success",
    result: "TEST697_CLAUDE_STUB_OK",
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.0001,
    num_turns: 1,
  } as any;
}

const sdkFactory = () => ({
  query: fakeQuery,
  createSdkMcpServer: (cfg: any) => ({
    name: cfg?.name || "stub", version: cfg?.version || "0", instance: {}, tools: cfg?.tools || [],
  }),
  tool: () => ({}),
});

const repo = process.env.TEST697_ROOT || "/workspace";
try {
  const requireFromAgentNode = createRequire(join(repo, "agent-node", "package.json"));
  const resolvedSdk = requireFromAgentNode.resolve("@anthropic-ai/claude-agent-sdk");
  mock.module(resolvedSdk, sdkFactory);
  mock.module(pathToFileURL(resolvedSdk).href, sdkFactory);
} catch {}
mock.module("@anthropic-ai/claude-agent-sdk", sdkFactory);
