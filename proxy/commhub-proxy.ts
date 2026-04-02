#!/usr/bin/env bun
/**
 * CommHub MCP Proxy — Long-poll MCP Server for Codex
 *
 * Codex connects to this as a standard MCP Server (stdio).
 * The get_task tool blocks up to 25s waiting for CommHub tasks (long-poll).
 * When a task arrives, it returns immediately. No task = empty response.
 *
 * Inspired by mcp-wechat-server's blocking get_messages pattern.
 *
 * Config (env or ~/.claude/channels/commhub/.env):
 *   COMMHUB_URL, COMMHUB_TOKEN, COMMHUB_ALIAS
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { hostname } from "os";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// ── .env loader ─────────────────────────────────────
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const HOME = process.env.HOME || "~";
loadEnvFile(join(HOME, ".claude/channels/commhub/.env"));

// ── Config ──────────────────────────────────────────
const COMMHUB_URL = process.env.COMMHUB_URL || "http://127.0.0.1:9200";
const ALIAS = process.env.COMMHUB_ALIAS || `codex-${hostname()}`;
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || "";
const RESUME_ID = process.env.COMMHUB_RESUME_ID || crypto.randomUUID();
const TMUX_NAME = (() => { try { return execSync("tmux display-message -p '#S'", { encoding: "utf-8", timeout: 2000 }).trim(); } catch { return ""; } })();
const POLL_MS = 25_000; // 25s per poll round (same as mcp-wechat-server)
const MAX_WAIT_MS = 7 * 24 * 3600_000; // 7 day max (same as mcp-wechat-server)

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [commhub-proxy] ${msg}\n`);
}

// ── CommHub REST/MCP helpers ────────────────────────
async function commhubFetch(endpoint: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  const res = await fetch(`${COMMHUB_URL}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function parseSSEData(text: string): any {
  // Extract last data: line from SSE response
  for (const line of text.split("\n").reverse()) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch { continue; }
    }
  }
  // Try parsing as plain JSON (non-SSE response)
  try { return JSON.parse(text); } catch {}
  return null;
}

async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  // Step 1: Initialize and extract session ID
  const initRes = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "commhub-proxy", version: "1.0.0" },
      },
    }),
  });
  const initText = await initRes.text();
  // Extract Mcp-Session header if present
  const sessionId = initRes.headers.get("mcp-session-id") || initRes.headers.get("Mcp-Session-Id");

  // Step 2: Call tool with session context
  const toolHeaders = { ...headers };
  if (sessionId) toolHeaders["Mcp-Session-Id"] = sessionId;

  const res = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers: toolHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const text = await res.text();
  const parsed = parseSSEData(text);
  if (!parsed) {
    log(`callMcpTool(${toolName}) parse failed: ${text.slice(0, 200)}`);
    return { ok: false, error: "parse failed" };
  }

  // Extract tool result
  const toolText = parsed?.result?.content?.[0]?.text;
  if (toolText) {
    try { return JSON.parse(toolText); } catch { return { ok: true, raw: toolText }; }
  }
  return parsed?.result || parsed;
}

// ── Long-poll for tasks (mcp-wechat-server pattern) ─
async function pollForTask(waitMs: number): Promise<any[]> {
  const deadline = Date.now() + waitMs;
  let backoffMs = POLL_MS;

  while (Date.now() < deadline) {
    try {
      const inbox = await callMcpTool("get_inbox", { alias: ALIAS, limit: 5 });

      if (inbox?.ok && inbox.messages?.length > 0) {
        // ACK all messages
        for (const msg of inbox.messages) {
          await callMcpTool("ack_inbox", { alias: ALIAS, message_id: msg.id }).catch(() => {});
        }
        return inbox.messages;
      }

      backoffMs = POLL_MS; // reset backoff on success
    } catch (err) {
      // Exponential backoff on server errors (cap at 60s)
      log(`poll error: ${err}, backoff ${backoffMs}ms`);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }

    // Sleep before retry
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(backoffMs, remaining)));
  }

  return []; // timeout, no tasks
}

// ── MCP Server ──────────────────────────────────────
const server = new McpServer(
  { name: "commhub-proxy", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Tool 1: get_task — blocks until a task arrives (long-poll)
server.tool(
  "get_task",
  `Poll for new tasks from CommHub. Call with wait=true to block until a task arrives.

IMPORTANT: This is a long-polling call. Set your tool timeout to at least 120 seconds.
When wait=true, it blocks up to 25 seconds per poll round, retrying until a task arrives.
Returns immediately when a task is available.

After receiving a task, process it and call report_result with the outcome.`,
  {
    wait: z.boolean().optional().describe("If true, block until a task arrives (default: true)"),
    timeout_ms: z.number().optional().describe("Max wait time in ms (default: 25000, max: 60000)"),
  },
  async (input) => {
    const wait = input.wait !== false;
    const waitMs = wait ? Math.min(input.timeout_ms || POLL_MS, 60_000) : 5_000;

    // Report status before polling
    await callMcpTool("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: "idle",
      task: "Waiting for tasks...",
    });

    const messages = await pollForTask(waitMs);

    if (messages.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ task_count: 0, tasks: [] }, null, 2),
        }],
      };
    }

    // Update status to working
    await callMcpTool("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: "working",
      task: (messages[0].content as string).slice(0, 200),
    });

    const tasks = messages.map((m) => ({
      task_id: m.id,
      from: m.from_session || "hub",
      priority: m.priority || "normal",
      content: m.content,
      created_at: m.created_at,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ task_count: tasks.length, tasks }, null, 2),
      }],
    };
  },
);

// Tool 2: report_result — report task completion back to CommHub
server.tool(
  "report_result",
  "Report task completion back to CommHub. Call this after finishing a task from get_task.",
  {
    task_id: z.string().describe("The task_id from get_task response"),
    result: z.string().describe("Task result summary"),
    status: z.enum(["completed", "error", "blocked"]).optional().describe("Task status (default: completed)"),
  },
  async (input) => {
    const status = input.status || "completed";

    if (status === "completed") {
      await callMcpTool("report_completion", {
        alias: ALIAS,
        task: input.task_id,
        result: input.result,
      });
    } else {
      await callMcpTool("report_status", {
        resume_id: RESUME_ID,
        alias: ALIAS,
        status: status === "error" ? "error" : "blocked",
        task: input.result.slice(0, 200),
        output: input.result,
      });
    }

    // Back to idle
    await callMcpTool("report_status", { resume_id: RESUME_ID, alias: ALIAS, status: "idle" });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, status, task_id: input.task_id }),
      }],
    };
  },
);

// Tool 3: send_message — send a message to another session via CommHub
server.tool(
  "send_message",
  "Send a task or message to another session via CommHub.",
  {
    to: z.string().describe("Target session alias"),
    message: z.string().describe("Message content"),
    priority: z.enum(["high", "normal", "low"]).optional(),
  },
  async (input) => {
    const result = await callMcpTool("send_task", {
      alias: input.to,
      task: input.message,
      priority: input.priority || "normal",
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result),
      }],
    };
  },
);

// Tool 4: get_status — get all session status from CommHub
server.tool(
  "get_status",
  "Get status of all sessions connected to CommHub.",
  {},
  async () => {
    const result = await callMcpTool("get_all_status", {});
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  },
);

// ── Main ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected: ALIAS=${ALIAS} COMMHUB=${COMMHUB_URL}`);

  // Register with CommHub
  await callMcpTool("report_status", {
    resume_id: RESUME_ID,
    alias: ALIAS,
    status: "idle",
    server: hostname(),
    hostname: hostname(),
    agent: "codex",
    project_dir: process.cwd(),
    tmux_name: TMUX_NAME || undefined,
  }).catch((e) => log(`register warning: ${e}`));

  log("ready — Codex can now call get_task to receive tasks");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});
