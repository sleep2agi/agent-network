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
import { randomUUID } from "crypto";
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
// /path/to/your/work → -path-to-your-work
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

// ── Load ~/.anet/config.json for token fallback ──────
function loadAnetConfig(): Record<string, string> {
  try {
    const p = join(HOME, ".anet", "config.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {}
  return {};
}
const ANET_CONFIG = loadAnetConfig();

const COMMHUB_URL = process.env.COMMHUB_URL || ANET_CONFIG.hub || "http://127.0.0.1:9200";
const TMUX_NAME = process.env.COMMHUB_TMUX || getTmuxSessionName();
const ALIAS = process.env.COMMHUB_ALIAS || TMUX_NAME || hostname();
const RESUME_ID = process.env.COMMHUB_RESUME_ID || process.env.CLAUDE_RESUME_ID || randomUUID();
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || ANET_CONFIG.token || "";

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [commhub] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

log(`ENV: URL=${COMMHUB_URL} ALIAS=${ALIAS} RESUME_ID=${RESUME_ID.slice(0, 8)}... TMUX=${TMUX_NAME || "none"} CWD=${process.cwd()} PROJECT_ENV=${projectPath}`);

// V2: track task_id → originator alias for send_reply routing
const taskOriginators = new Map<string, string>();

// ── MCP Server with Channel capability ──────────────
// name 不要拼 alias！Claude Code 用 meta.user 自动加 "· xxx" 后缀
// 参考: telegram 插件 name 也只是 "telegram"，不是 "telegram · vansinhu"
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
            enum: ["completed", "failed", "cancelled", "blocked", "error", "in_progress"],
            description: "Task outcome: completed/failed/cancelled for final results, blocked/error/in_progress for status updates",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "commhub_report_status",
      description: "Update this session's status in CommHub (working/idle/blocked/error). Returns inbox_count.",
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
    {
      name: "commhub_send_task",
      description: "Send a task to another session via CommHub.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alias: { type: "string", description: "Target session alias" },
          task: { type: "string", description: "Task content" },
          priority: { type: "string", enum: ["high", "normal", "low"], description: "Priority (default: normal)" },
        },
        required: ["alias", "task"],
      },
    },
    {
      name: "commhub_send_message",
      description: "Send a message to another session (no task lifecycle, just chat). Use for replies and status updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alias: { type: "string", description: "Target session alias" },
          message: { type: "string", description: "Message content" },
        },
        required: ["alias", "message"],
      },
    },
    {
      name: "commhub_get_all_status",
      description: "Get status of all sessions from CommHub.",
      inputSchema: {
        type: "object" as const,
        properties: {},
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
  if (!initRes.ok) {
    const errText = await initRes.text();
    log(`CommHub init failed: ${initRes.status} ${errText.slice(0, 100)}`);
    return { ok: false, error: `init failed: ${initRes.status}` };
  }
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

mcp.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params;

  if (name === "commhub_reply") {
    const { task_id, text, status } = args as any;
    // V2: terminal statuses use send_reply to close task lifecycle
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const replyStatus = status === "completed" ? "replied" : status;
      const originator = task_id ? (taskOriginators.get(task_id) || "hub") : "hub";
      const result = await callCommHub("send_reply", {
        alias: originator,
        text,
        in_reply_to: task_id || undefined,
        status: replyStatus,
        from_session: ALIAS,
      });
      if (task_id) taskOriginators.delete(task_id);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    // Non-terminal: update session status
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

  if (name === "commhub_send_task") {
    const { alias, task, priority } = args as any;
    const result = await callCommHub("send_task", {
      alias,
      task,
      priority: priority || "normal",
      from_session: ALIAS,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "commhub_send_message") {
    const { alias, message } = args as any;
    const result = await callCommHub("send_message", {
      alias,
      message,
      from_session: ALIAS,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "commhub_get_all_status") {
    const result = await callCommHub("get_all_status", {});
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

  if (event.type === "new_message") {
    log(`← message from ${event.from}: ${(event.message as string).slice(0, 60)}`);

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: event.message,
        meta: {
          sender: event.from || "hub",
          sender_id: "commhub",
          user: event.from || "hub", // Claude Code 用 meta.user 显示 "commhub · {user}"
          priority: "normal",
        },
      },
    });

    // Auto-ack the message in inbox
    if (event.message_id) {
      await callCommHub("ack_inbox", { alias: ALIAS, message_id: event.message_id });
    }
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
          user: msg.from_session || "hub", // Claude Code 用 meta.user 显示 "commhub · {user}"
          task_id: msg.id,
          priority: msg.priority || "normal",
        };
        // V2: remember who sent this task so send_reply knows the target
        taskOriginators.set(msg.id, msg.from_session || "hub");

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

  // Heartbeat: report_status every 3 minutes to prevent offline timeout
  setInterval(() => {
    callCommHub("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: "idle",
      server: hostname(),
      hostname: hostname(),
      agent: "claude-code",
      project_dir: process.cwd(),
      tmux_name: TMUX_NAME || undefined,
    }).catch((e) => log(`heartbeat failed: ${e}`));
  }, 3 * 60 * 1000);

  log("ready — waiting for events");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});

async function gracefulShutdown() {
  log("shutting down, reporting offline...");
  await callCommHub("report_status", {
    resume_id: RESUME_ID,
    alias: ALIAS,
    status: "offline",
    task: "session disconnected",
  }).catch(() => {});
  process.exit(0);
}

process.stdin.on("end", () => gracefulShutdown());
process.on("SIGTERM", () => gracefulShutdown());
process.on("SIGINT", () => gracefulShutdown());
