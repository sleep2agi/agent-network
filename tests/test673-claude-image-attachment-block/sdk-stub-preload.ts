// test673 — SDK query stub (bun --preload) for the claude-agent-sdk
// multimodal-wiring gate (#259 Y).
//
// The real cli.ts does `const { query } = await import("@anthropic-ai/
// claude-agent-sdk")` inside processWithClaude, and commhub-mcp.ts does
// `const { createSdkMcpServer, tool } = await import(... )`. We intercept
// that module so:
//   - `query({ prompt, options })` records the *actual* prompt cli.ts
//     built (string vs AsyncIterable<SDKUserMessage>) and, for the
//     iterable path, the resolved user-message content blocks — then
//     yields a minimal success stream so cli's for-await loop completes.
//   - createSdkMcpServer / tool return inert objects so the CommHub MCP
//     wiring constructs without a real SDK or vendor call.
//
// This lets the test assert, against the REAL cli.ts inbound path
// (SSE task → extractImagePaths download → processWithClaude), that an
// image content block carrying the downloaded bytes reaches query().
import { mock } from "bun:test";
import * as fs from "fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CAPTURE = process.env.TEST673_CAPTURE_FILE || "/tmp/test673-capture.json";

async function* fakeQuery(args: any) {
  const prompt = args?.prompt;
  let captured: any = { kind: "unknown", ts: Date.now() };
  try {
    if (typeof prompt === "string") {
      captured = { kind: "string", ts: Date.now(), textPreview: prompt.slice(0, 160) };
    } else if (prompt && typeof prompt[Symbol.asyncIterator] === "function") {
      const messages: any[] = [];
      for await (const m of prompt) messages.push(m);
      const first: any = messages[0];
      const content = first?.message?.content;
      const blocks = Array.isArray(content)
        ? content.map((b: any) =>
            b?.type === "image"
              ? {
                  type: "image",
                  source_type: b?.source?.type,
                  media_type: b?.source?.media_type,
                  data_len: typeof b?.source?.data === "string" ? b.source.data.length : null,
                  data_b64: typeof b?.source?.data === "string" ? b.source.data : null,
                }
              : { type: b?.type, text_preview: typeof b?.text === "string" ? b.text.slice(0, 80) : undefined },
          )
        : content;
      captured = {
        kind: "async-iterable",
        ts: Date.now(),
        message_count: messages.length,
        first_message_type: first?.type,
        parent_tool_use_id: first?.parent_tool_use_id ?? null,
        blocks,
        image_block_count: Array.isArray(blocks) ? blocks.filter((b: any) => b?.type === "image").length : 0,
      };
    }
  } catch (e: any) {
    captured = { kind: "error", ts: Date.now(), error: String(e?.message || e) };
  }
  try {
    fs.writeFileSync(CAPTURE, JSON.stringify(captured, null, 2));
  } catch {}

  // Minimal success stream so cli's loop sets a session and returns a result.
  yield { type: "system", subtype: "init", session_id: "test673-stub-session" } as any;
  const forcedFailure = typeof prompt === "string" && prompt.includes("FORCE_FAILED_STATUS_698");
  const maxLengthReply = typeof prompt === "string" && prompt.includes("MAX_LENGTH_REPLY_698");
  yield {
    type: "result",
    subtype: "success",
    result: forcedFailure
      ? "API error: FORCE_FAILED_STATUS_698"
      : maxLengthReply
        ? "x".repeat(10_000)
        : "TEST673_STUB_OK",
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.0001,
    num_turns: 1,
  } as any;
}

function fakeCreateSdkMcpServer(cfg: any) {
  return { name: cfg?.name || "stub", version: cfg?.version || "0", instance: {}, tools: cfg?.tools || [] } as any;
}
function fakeTool(..._a: any[]) {
  return {} as any;
}

const sdkFactory = () => ({
  query: fakeQuery,
  createSdkMcpServer: fakeCreateSdkMcpServer,
  tool: fakeTool,
});

// Bun keys a module mock by the importer's resolved module identity. The
// bare-name mock is enough in a source checkout whose package is hoisted, but
// the Docker install resolves the CLI import to agent-node/node_modules/.../
// sdk.mjs. Register both the public specifier and the package-root-resolved
// entrypoint so the exact installed SDK cannot silently bypass the harness.
// This is test-only; production module resolution is untouched.
const repo = process.env.REPO || "/app";
try {
  const requireFromAgentNode = createRequire(join(repo, "agent-node", "package.json"));
  const resolvedSdk = requireFromAgentNode.resolve("@anthropic-ai/claude-agent-sdk");
  mock.module(resolvedSdk, sdkFactory);
  mock.module(pathToFileURL(resolvedSdk).href, sdkFactory);
} catch {
  // The host debug path may use a hoisted dependency; the bare registration
  // below remains authoritative there.
}
mock.module("@anthropic-ai/claude-agent-sdk", sdkFactory);
