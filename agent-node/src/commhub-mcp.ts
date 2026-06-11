// In-process SDK-instance MCP server that proxies commhub tool calls to the
// commhub HTTP /mcp endpoint. Workaround for #102 root-cause: the claude
// binary's `--mcp-config` flag does not reliably register HTTP MCP servers
// at runtime — empirically (smoke test 2026-05-15) the binary received the
// `{type:"http", url:...}` config from `mcpServers` but never issued a
// single `/mcp` initialize / tools/list / tools/call from its subprocess,
// so the LLM saw an empty MCP tool list.
//
// Option A (通信龙-confirmed): keep the claude binary subprocess unchanged
// and instead pass an *in-process* McpServer instance via the SDK's
// `mcpServers: { commhub: { type: "sdk", instance, ... } }` path. The
// SDK proxies the binary's tool calls to this in-process instance over the
// already-working SDK transport channel; each registered tool handler then
// forwards the call to commhub's HTTP `/mcp` endpoint using the same Bearer
// auth + JSON-RPC protocol the parent process already uses (cli.ts:2634+).
//
// Net effect for the LLM: tools `mcp__commhub__send_task` /
// `..._get_all_status` / `..._send_message` / `..._send_reply` /
// `..._get_session_status` / `..._get_task` / `..._list_tasks` are visible
// and callable. The naming follows `mcp__<server>__<tool>` with server name
// "commhub" and the bare tool name (e.g. "send_task"), matching the
// commhub server's own registration (server/src/tools.ts).

// Dynamic-import the SDK to keep `--external @anthropic-ai/claude-agent-sdk`
// effective at bundle time — a static import here pulled bun into the SDK's
// optional-dependency resolution graph and copied the 222 MB linux-x64
// claude binary as a bundle asset, blowing up the published package size.
// (The original cli.ts already uses `await import("@anthropic-ai/claude-agent-sdk")`
// inside processWithClaude for the same reason — keep that pattern.)
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

interface CallToolContent { type: "text"; text: string }

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// One JSON-RPC initialize + tools/call against commhub /mcp per LLM tool
// invocation. Stateless: each call gets a fresh MCP session (commhub-server
// has no per-session sticky state for tool calls). Slight overhead (2 HTTP
// roundtrips per LLM call) but predictable and isolated.
async function forwardToCommhub(
  hubUrl: string, token: string | undefined,
  toolName: string, args: unknown,
  ): Promise<{ content: CallToolContent[]; isError?: boolean }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // commhub's WebStandardStreamableHTTPServerTransport requires
      // Accept including both application/json and text/event-stream.
      "Accept": "application/json, text/event-stream",
      ...authHeaders(token),
    };
    // Initialize the MCP session (commhub returns session id in mcp-session-id header).
    const initRes = await fetch(`${hubUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "agent-node-mcp-proxy", version: "1.0" },
        },
      }),
    });
    if (!initRes.ok) {
      const t = await initRes.text().catch(() => "");
      return { isError: true, content: [{ type: "text", text: `commhub MCP initialize failed: HTTP ${initRes.status} ${t.slice(0, 200)}` }] };
    }
    const sessionId = initRes.headers.get("mcp-session-id") || initRes.headers.get("Mcp-Session-Id");
    const callHeaders = { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
    const callRes = await fetch(`${hubUrl}/mcp`, {
      method: "POST",
      headers: callHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: toolName, arguments: args ?? {} },
      }),
    });
    const raw = await callRes.text();
    // commhub's response may be SSE-framed (text/event-stream) or plain JSON.
    // Extract the JSON-RPC envelope either way.
    let envelope: any = null;
    try {
      envelope = JSON.parse(raw);
    } catch {
      // SSE frames: lines starting with `data: <json>`
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^data:\s*(\{.*\})\s*$/);
        if (m) { try { envelope = JSON.parse(m[1]); break; } catch {} }
      }
    }
    if (!envelope) {
      return { isError: true, content: [{ type: "text", text: `commhub MCP tools/call: empty response (HTTP ${callRes.status})` }] };
    }
    if (envelope.error) {
      return { isError: true, content: [{ type: "text", text: `commhub MCP error: ${JSON.stringify(envelope.error).slice(0, 400)}` }] };
    }
    const result = envelope.result;
    if (result && Array.isArray(result.content)) {
      // Pass commhub's content blocks through verbatim (preserves the
      // existing JSON-stringified payloads from commhub tools).
      return { content: result.content as CallToolContent[], isError: result.isError === true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result ?? envelope) }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: "text", text: `commhub MCP transport error: ${e?.message || String(e)}` }] };
  }
}

const OUTBOUND_FROM_TOOLS = new Set(["send_task", "send_message", "send_reply"]);

export function injectAgentFromSession(toolName: string, args: unknown, agentAlias?: string): unknown {
  const alias = agentAlias?.trim();
  if (!alias || !OUTBOUND_FROM_TOOLS.has(toolName)) return args ?? {};
  const base = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return { ...base, from_session: alias };
}

// Create the in-process SDK MCP server. The tool list is the agent-facing
// subset of commhub's 17 tools — i.e. everything an LLM legitimately needs
// to coordinate other agents. Excluded:
//   - report_status / report_completion / get_inbox / ack_inbox
//     → agent-node parent already handles those over its own MCP channel
//   - retry_task / cancel_task / reassign_task / broadcast
//     → admin / hub-side; not exposing them to the LLM by default
export async function createCommhubSdkMcpServer(
  hubUrl: string, token: string | undefined,
  // #146 PR-4 — accept three forms:
  //   - undefined         (test / legacy callers without identity)
  //   - static string     (legacy callers; alias never changes)
  //   - sync getter       () => string (cache-only read, legacy)
  //   - async getter      () => Promise<string> (the live-alias path)
  // For an unbounded-staleness-safe path the caller should pass the
  // async getter (e.g. cli.ts wires `() => aliasResolver.refresh()` so
  // every tool invocation revalidates the cache against the server
  // within the 30 s window). 通信牛 PR #228 二审 catch — without this
  // a long LLM turn that doesn't fire any sender-side commhub call
  // could read a permanently stale closure-captured alias.
  agentAliasOrGetter?: string | (() => string) | (() => Promise<string>),
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
  const resolveAlias = async (): Promise<string | undefined> => {
    if (agentAliasOrGetter === undefined) return undefined;
    if (typeof agentAliasOrGetter !== "function") return agentAliasOrGetter;
    const value = agentAliasOrGetter();
    return value && typeof (value as any).then === "function"
      ? await (value as Promise<string>)
      : (value as string);
  };
  const fwd = (name: string) =>
    (async (args: unknown) => forwardToCommhub(hubUrl, token, name, injectAgentFromSession(name, args, await resolveAlias())));

  return createSdkMcpServer({
    name: "commhub",
    version: "0.1.0",
    tools: [
      tool(
        "send_task",
        "Dispatch a task to another agent (by alias). Returns task_id. Pass parent_task_id so the hub can chain replies back to the originator.",
        {
          alias: z.string().describe("Target agent alias"),
          task: z.string().describe("Task content"),
          priority: z.enum(["high", "normal", "low"]).optional(),
          parent_task_id: z.string().optional().describe("Parent task this dispatch is on behalf of"),
          ttl_seconds: z.number().optional(),
          context: z.string().optional(),
          meta: z.any().optional().describe("Optional structured metadata, e.g. image attachments."),
        },
        fwd("send_task"),
      ),
      tool(
        "send_message",
        "Send a chat message to another agent (no task lifecycle). Use for status updates / casual coordination.",
        {
          alias: z.string().describe("Target agent alias"),
          message: z.string().describe("Message content"),
        },
        fwd("send_message"),
      ),
      tool(
        "send_reply",
        "Send a reply to a task. Linked to task_id via in_reply_to. Does NOT trigger agent re-processing.",
        {
          task_id: z.string().describe("Task to reply to"),
          text: z.string().describe("Reply content"),
          status: z.enum(["replied", "failed", "cancelled"]).optional(),
        },
        fwd("send_reply"),
      ),
      tool(
        "get_all_status",
        "Get status of all sessions in the current network (or globally for admin tokens). Use this to see who is online before send_task.",
        {},
        fwd("get_all_status"),
      ),
      tool(
        "get_session_status",
        "Get detailed status of a specific session by alias (inbox_pending, recent completions).",
        { alias: z.string() },
        fwd("get_session_status"),
      ),
      tool(
        "get_task",
        "Get task details by task_id — status, result, timestamps. Poll this to wait for a sub-task to finish.",
        { task_id: z.string() },
        fwd("get_task"),
      ),
      tool(
        "list_tasks",
        "List tasks with filters (e.g. your own pending/running).",
        {
          to_name: z.string().optional(),
          from_name: z.string().optional(),
          status: z.string().optional(),
          limit: z.number().optional(),
        },
        fwd("list_tasks"),
      ),
    ],
  });
}
