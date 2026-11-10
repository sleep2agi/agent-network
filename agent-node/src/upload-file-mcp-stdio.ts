#!/usr/bin/env bun
/**
 * #693 — minimal stdio MCP server exposing only `upload_file`.
 * Used by Grok ACP (stdio McpServer variant) and other runtimes that
 * cannot host in-process SDK tools. Path safety is local; Hub only
 * receives multipart bytes via /api/upload.
 *
 * Env:
 *   COMMHUB_URL / COMMHUB_TOKEN (required)
 *   COMMHUB_ALIAS / ANET_UPLOAD_ALIAS (optional, for root derivation)
 *   ANET_NODE_DIR (optional)
 *   ANET_UPLOAD_ROOTS (optional colon list)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { requireEnv } from "./env-required.js";
import {
  defaultControlledUploadRoots,
  uploadControlledLocalFile,
} from "./controlled-upload.js";

const _env = requireEnv(process.env as Record<string, string | undefined>);
if (!_env.ok) {
  console.error(`[upload-file-mcp] 缺少必填环境变量：${_env.missing.join(", ")}`);
  console.error("[upload-file-mcp] 拒绝启动：把工具列出来再在第一次调用时失败，等于把配置错误留给运行期");
  process.exit(2);
}
const HUB = _env.hub;
const TOKEN = _env.token;
const ALIAS = process.env.ANET_UPLOAD_ALIAS || process.env.COMMHUB_ALIAS || "";
const NODE_DIR = process.env.ANET_NODE_DIR || "";

const server = new Server(
  { name: "commhub-upload", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "upload_file",
      description:
        "Upload a controlled local file (generated image/attachment under this node's allowlisted dirs) to CommHub. Returns {file_id,name,mime,size} for send_reply attachments. Rejects arbitrary paths, traversal, and symlinks. Max 12 MiB. Cross-host safe: bytes stream to Hub; do not pass raw paths into send_reply.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to a file under this node's controlled roots (e.g. Grok images/, .anet cache attachments)",
          },
          name: { type: "string", description: "Optional display filename (basename only)" },
          mime: { type: "string", description: "Optional MIME type hint" },
        },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name !== "upload_file") {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown_tool" }) }],
      isError: true,
    };
  }
  const args = (req.params.arguments || {}) as { path?: string; name?: string; mime?: string };
  const result = await uploadControlledLocalFile(String(args.path || ""), {
    hubUrl: HUB,
    authToken: TOKEN,
    alias: ALIAS || undefined,
    nodeDir: NODE_DIR || undefined,
    allowedRoots: defaultControlledUploadRoots({
      alias: ALIAS || undefined,
      nodeDir: NODE_DIR || undefined,
    }),
  }, { name: args.name, mime: args.mime });

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: !result.ok,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
