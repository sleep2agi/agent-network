#!/usr/bin/env bun
/**
 * CommHub Channel Plugin for Claude Code
 *
 * Alias resolution (priority order):
 *   1. COMMHUB_ALIAS env var
 *   2. Project .env: ~/.claude/channels/commhub/{project-path}/.env
 *   3. tmux session name
 *   4. hostname
 *
 * Shared config from: ~/.claude/channels/commhub/.env
 *   COMMHUB_URL, COMMHUB_TOKEN
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { hostname } from "os";
import { execSync } from "child_process";

// ── .env loader helper ────────────────────────────────
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

// ── Load shared config ────────────────────────────────
const HOME = process.env.HOME || "~";
const COMMHUB_DIR = join(HOME, ".claude/channels/commhub");
loadEnvFile(join(COMMHUB_DIR, ".env"));

// ── Load project-specific config ──────────────────────
// /home/vansin/vincent → -home-vansin-vincent
const projectPath = process.cwd().replace(/\//g, "-");
loadEnvFile(join(COMMHUB_DIR, projectPath, ".env"));

// ── Get tmux session name ─────────────────────────────
function getTmuxSessionName(): string {
  try {
    return execSync("tmux display-message -p '#S'", { encoding: "utf-8", timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

// ── Resolve config ────────────────────────────────────
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const COMMHUB_URL = process.env.COMMHUB_URL || "http://127.0.0.1:9200";
const TMUX_NAME = process.env.COMMHUB_TMUX || getTmuxSessionName();
const ALIAS = process.env.COMMHUB_ALIAS || TMUX_NAME || hostname();
const RESUME_ID = process.env.COMMHUB_RESUME_ID || process.env.CLAUDE_RESUME_ID || crypto.randomUUID();
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || "";

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [commhub] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

log(`ENV: URL=${COMMHUB_URL} ALIAS=${ALIAS} RESUME_ID=${RESUME_ID.slice(0, 8)}... TMUX=${TMUX_NAME || "none"} CWD=${process.cwd()} PROJECT_ENV=${projectPath}`);

// ── MCP Server with Channel capability ──────────────
const mcp = new Server(
  {
    name: "commhub-channel",
    version: "0.3.0",
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      `Messages from CommHub arrive as <channel source="commhub" task_id="..." priority="..." from="...">`,
      `These are tasks dispatched by the hub or other sessions via the CommHub Server.`,
      `Reply using the commhub_reply tool to report status or results back.`,
      `You can also use commhub_report_status to update your session status.`,
      `Session alias: ${ALIAS}`,
    ].join("\n"),
  }
);

// ── Tools ───────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "commhub_reply",
      description: "Reply to a CommHub task — report completion or send a message back to the hub.",
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
      name: "commhub_report_status",
      description: "Update this session's status in CommHub (working/idle/blocked/error).",
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

// Helper: call CommHub MCP endpoint
async function callCommHub(toolName: string, args: Record<string, unknown>): Promise<any> {
  const initRes = await fetch(`${COMMHUB_URL}/mcp`, {
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
        clientInfo: { name: "commhub-channel", version: "0.3.0" },
      },
    }),
  });
  await initRes.text();

  const res = await fetch(`${COMMHUB_URL}/mcp`, {
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
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) {
    const json = JSON.parse(dataLine.slice(6));
    return json?.result?.content?.[0]?.text ? JSON.parse(json.result.content[0].text) : json;
  }
  return { ok: false, error: "no response" };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "commhub_reply") {
    const { task_id, text, status } = args as any;
    if (status === "completed") {
      const result = await callCommHub("report_completion", {
        alias: ALIAS,
        task: task_id || "task",
        result: text,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    const result = await callCommHub("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: status === "blocked" ? "blocked" : status === "error" ? "error" : "working",
      task: text.slice(0, 200),
      output: text,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "commhub_report_status") {
    const { status, task, progress } = args as any;
    const result = await callCommHub("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status,
      task,
      progress,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }] };
});

// ── SSE Listener: subscribe to /events/:alias ─────
async function connectSSE() {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  log(`connecting to ${url}`);

  while (true) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`SSE error: ${res.status} ${res.statusText}`);
        await sleep(5000);
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

    await sleep(3000);
  }
}

async function handleSSEEvent(event: any) {
  if (event.type === "connected") {
    log(`SSE connected as "${ALIAS}"`);
    return;
  }

  if (event.type === "new_task" || event.type === "broadcast") {
    log(`← ${event.type}: inbox_count=${event.inbox_count} priority=${event.priority || "normal"}`);

    const inbox = await callCommHub("get_inbox", {
      alias: ALIAS,
      limit: 5,
    });

    if (inbox?.ok && inbox.messages?.length > 0) {
      for (const msg of inbox.messages) {
        const meta: Record<string, string> = {
          sender: msg.from_session || "hub",
          sender_id: "commhub",
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

        await callCommHub("ack_inbox", {
          alias: ALIAS,
          message_id: msg.id,
        });
      }
    }
  }
}

// ── Main ────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP stdio connected");

  log("starting SSE listener...");
  connectSSE().catch((err) => log(`SSE fatal: ${err}`));

  callCommHub("report_status", {
    resume_id: RESUME_ID,
    alias: ALIAS,
    status: "idle",
    server: hostname(),
    hostname: hostname(),
    agent: "claude-code",
    project_dir: process.cwd(),
    tmux_name: TMUX_NAME || undefined,
  })
    .then(() => log(`registered as "${ALIAS}" (${RESUME_ID.slice(0, 8)})`))
    .catch((e) => log(`warning: could not register: ${e}`));

  log("ready — waiting for events");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
