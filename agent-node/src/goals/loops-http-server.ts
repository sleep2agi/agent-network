// RFC-025 M2 — in-process HTTP MCP server for codex-sdk runtime.
//
// Codex CLI's MCP support accepts streamable HTTP servers
// (`codex mcp add --url ... --bearer-token-env-var ...`, verified
// 2026-06-29). Unlike claude-agent-sdk's in-process SDK McpServer,
// codex spawns the agent CLI as a child process which then calls
// out to this URL — but since the URL is `127.0.0.1:<random>`, we
// stay inside the parent process boundary for the actual handler
// execution, so the 6 self-loop handlers run against the SAME
// `goalStore` + `loopsCancelTimestamps` + `loopsConfirmTokens` as
// the claude path. Safety防线 (cooldown / max / batch-cancel
// confirm-back) preserved cross-runtime — they're not per-process
// counters that reset between codex turns.
//
// Security (通信龙 hard constraints):
//   - localhost-bind ONLY (127.0.0.1) — never 0.0.0.0
//   - random bearer token (crypto.randomBytes 16B) — only handed to
//     codex subprocess via env var `LOOPS_MCP_TOKEN`, never logged,
//     never written to disk
//   - auth no-bypass: missing / wrong token → 401, no fallback
//   - graceful close on parent shutdown

import { randomBytes } from "crypto";
import { SELF_LOOP_TOOL_SPECS } from "./self-loop-tools";
import type { SelfLoopCtx } from "./self-loop-tools";

export interface LoopsHttpServerStarted {
  url: string;        // e.g. "http://127.0.0.1:53412/mcp"
  token: string;      // raw bearer token (only handed to codex subprocess via env)
  port: number;
  close: () => Promise<void> | void;
}

export interface StartOpts {
  ctx: SelfLoopCtx;
  /** Override port. Default 0 = OS picks (random). */
  port?: number;
  /** Override token. Default random 16B base64. */
  token?: string;
}

// MCP JSON-RPC protocol implementation — just enough surface for
// `initialize` / `tools/list` / `tools/call` (the 3 verbs codex CLI
// uses against an MCP server).
//
// We don't pull in the full @modelcontextprotocol/sdk just for this
// shim — the protocol is small enough to inline cleanly and avoids
// dragging another transport layer into agent-node.

function jsonRpcOk(id: any, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcErr(id: any, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// Lazy zod schemas pulled from loops-mcp.ts pattern. Inline minimal
// version here to avoid claude-agent-sdk dependency on codex path.
function describeTool(spec: typeof SELF_LOOP_TOOL_SPECS[number]) {
  // Build a minimal JSON Schema for inputSchema per MCP spec.
  // Codex CLI is lenient about schema details for streamable HTTP
  // (it relays the call regardless), so we hand-roll a relaxed shape.
  const props: Record<string, any> = {};
  if (spec.name === "create_my_loop") {
    props.task = { type: "string" };
    props.interval = { type: "string" };
    props.schedule = { type: "object" };
  } else if (spec.name === "edit_my_loop") {
    props.goal_id = { type: "string" };
    props.task = { type: "string" };
    props.interval = { type: "string" };
    props.schedule = { type: "object" };
    props.paused = { type: "boolean" };
  } else if (spec.name === "reschedule_my_loop") {
    props.goal_id = { type: "string" };
    props.next_wake_in = { type: "string" };
  } else if (spec.name === "complete_my_loop" || spec.name === "cancel_my_loop") {
    props.goal_id = { type: "string" };
    if (spec.name === "cancel_my_loop") props.confirm_token = { type: "string" };
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: props,
      required: spec.name === "list_my_loops" ? [] : ["goal_id"].filter((k) => k in props),
    },
  };
}

async function handleMcpRequest(body: any, ctx: SelfLoopCtx) {
  const { id, method, params } = body || {};
  if (method === "initialize") {
    return jsonRpcOk(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "loops", version: "0.1.0" },
    });
  }
  if (method === "tools/list") {
    return jsonRpcOk(id, { tools: SELF_LOOP_TOOL_SPECS.map(describeTool) });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const spec = SELF_LOOP_TOOL_SPECS.find((s) => s.name === name);
    if (!spec) return jsonRpcErr(id, -32601, `Tool not found: ${name}`);
    const result = await spec.handler(args, ctx);
    // MCP tools/call response shape — content[]
    return jsonRpcOk(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: !result.ok,
    });
  }
  // Unknown method
  return jsonRpcErr(id, -32601, `Method not found: ${method}`);
}

/**
 * Start a localhost-only HTTP MCP server. Returns the started
 * server's url/token/port + close fn. Caller's responsibility to
 * call close() at parent shutdown.
 */
export async function startLoopsHttpServer(opts: StartOpts): Promise<LoopsHttpServerStarted> {
  const token = opts.token ?? randomBytes(16).toString("base64url");
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }
    // Auth — bearer no-bypass per 通信龙 hard constraint #4.
    // No token / wrong token / no Authorization header → 401.
    const auth = req.headers.get("authorization") || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== token) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify(jsonRpcErr(null, -32700, "Parse error")), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    try {
      const result = await handleMcpRequest(body, opts.ctx);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (e: any) {
      return new Response(
        JSON.stringify(jsonRpcErr(body?.id ?? null, -32603, `Internal error: ${e?.message ?? e}`)),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  };

  const server = Bun.serve({
    port: opts.port ?? 0, // 0 = OS picks a random free port
    hostname: "127.0.0.1", // localhost-bind ONLY — never 0.0.0.0
    fetch: handler,
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    token,
    port: server.port,
    close: () => server.stop(true),
  };
}
