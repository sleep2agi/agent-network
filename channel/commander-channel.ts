#!/usr/bin/env bun
/**
 * Commander Channel Plugin for Claude Code
 *
 * Usage:
 *   cd ~/agent-orchestra/channel
 *   claude --dangerously-skip-permissions --dangerously-load-development-channels server:commander
 *
 * Env vars:
 *   COMMANDER_URL      - Commander Server URL (default: http://127.0.0.1:9200)
 *   COMMANDER_SESSION  - This session's name (default: hostname)
 *   COMMANDER_TOKEN    - Auth token (optional, matches COMMANDER_AUTH_TOKEN on server)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const COMMANDER_URL = process.env.COMMANDER_URL || "http://127.0.0.1:9200";
const SESSION_NAME = process.env.COMMANDER_SESSION || (await import("os")).hostname();
const AUTH_TOKEN = process.env.COMMANDER_TOKEN || "";

function log(msg: string) {
  process.stderr.write(`[commander-channel] ${msg}\n`);
}

// ── MCP Server with Channel capability ──────────────
const mcp = new Server(
  {
    name: "commander-channel",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `Messages from Commander arrive as <channel source="commander" task_id="..." priority="..." from="...">`,
      `These are tasks dispatched by the hub or other sessions via the Commander MCP Server.`,
      `Reply using the commander_reply tool to report status or results back.`,
      `You can also use commander_report_status to update your session status.`,
      `Session name: ${SESSION_NAME}`,
    ].join("\n"),
  }
);

// ── Tools ───────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "commander_reply",
      description: "Reply to a Commander task — report completion or send a message back to the hub.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "The task_id from the channel message (or 'hub' for general)" },
          text: { type: "string", description: "Reply text / result summary" },
          status: {
            type: "string",
            enum: ["completed", "blocked", "error", "in_progress"],
            description: "Task status",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "commander_report_status",
      description: "Update this session's status in Commander (working/idle/blocked/error).",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["working", "idle", "blocked", "error"],
          },
          task: { type: "string", description: "Current task description" },
          progress: { type: "number", description: "Progress 0-100" },
        },
        required: ["status"],
      },
    },
  ],
}));

// Helper: call Commander MCP endpoint
async function callCommander(toolName: string, args: Record<string, unknown>): Promise<any> {
  // Initialize + call tool in one flow (stateless mode)
  const initRes = await fetch(`${COMMANDER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "commander-channel", version: "0.1.0" },
      },
    }),
  });
  // Read the SSE response (just need to consume it)
  await initRes.text();

  // Now call the tool
  const res = await fetch(`${COMMANDER_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const text = await res.text();
  // Parse SSE event: "event: message\ndata: {...}\n\n"
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) {
    const json = JSON.parse(dataLine.slice(6));
    return json?.result?.content?.[0]?.text ? JSON.parse(json.result.content[0].text) : json;
  }
  return { ok: false, error: "no response" };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "commander_reply") {
    const { task_id, text, status } = args as any;
    // Report completion if status is completed
    if (status === "completed") {
      const result = await callCommander("report_completion", {
        session_name: SESSION_NAME,
        task: task_id || "task",
        result: text,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    // Otherwise update status
    const result = await callCommander("report_status", {
      session_name: SESSION_NAME,
      status: status === "blocked" ? "blocked" : status === "error" ? "error" : "working",
      task: text.slice(0, 200),
      output: text,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "commander_report_status") {
    const { status, task, progress } = args as any;
    const result = await callCommander("report_status", {
      session_name: SESSION_NAME,
      status,
      task,
      progress,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }] };
});

// ── SSE Listener: subscribe to /events/:session ─────
async function connectSSE() {
  const url = `${COMMANDER_URL}/events/${encodeURIComponent(SESSION_NAME)}`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  log(`connecting to ${url}`);

  while (true) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`SSE error: ${res.status} ${res.statusText}`);
        await Bun.sleep(5000);
        continue;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const block of lines) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          try {
            const event = JSON.parse(dataLine.slice(6));
            await handleSSEEvent(event);
          } catch (e) {
            log(`parse error: ${e}`);
          }
        }
      }

      log("SSE stream ended, reconnecting...");
    } catch (err) {
      log(`SSE connection error: ${err}`);
    }

    await Bun.sleep(3000);
  }
}

async function handleSSEEvent(event: any) {
  if (event.type === "connected") {
    log(`SSE connected as "${SESSION_NAME}"`);
    return;
  }

  if (event.type === "new_task" || event.type === "broadcast") {
    log(`← ${event.type}: inbox_count=${event.inbox_count} priority=${event.priority || "normal"}`);

    // Fetch actual task content from inbox
    const inbox = await callCommander("get_inbox", {
      session_name: SESSION_NAME,
      limit: 5,
    });

    if (inbox?.ok && inbox.messages?.length > 0) {
      for (const msg of inbox.messages) {
        // Inject into Claude Code conversation via Channel protocol
        const meta: Record<string, string> = {
          sender: msg.from_session || "hub",
          sender_id: "commander",
          task_id: msg.id,
          priority: msg.priority || "normal",
        };

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta,
          },
        });

        log(`→ injected task ${msg.id.slice(0, 8)} from ${msg.from_session}: ${(msg.content as string).slice(0, 60)}`);

        // Auto-ack
        await callCommander("ack_inbox", {
          session_name: SESSION_NAME,
          message_id: msg.id,
        });
      }
    }
  }
}

// ── Main ────────────────────────────────────────────
async function main() {
  // 1. Connect MCP stdio first (Claude Code expects handshake immediately)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP stdio connected");

  // 2. Report initial status to Commander
  try {
    await callCommander("report_status", {
      session_name: SESSION_NAME,
      status: "idle",
      server: (await import("os")).hostname(),
    });
    log(`registered as "${SESSION_NAME}"`);
  } catch (e) {
    log(`warning: could not register with Commander: ${e}`);
  }

  // 3. Start SSE listener (background, auto-reconnect)
  connectSSE().catch((err) => log(`SSE fatal: ${err}`));

  log("ready — waiting for Commander events");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});

// Graceful shutdown
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
