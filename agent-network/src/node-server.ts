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
import { OUTBOUND_TOOL_NAMES } from "./outbound-tool-names";
import { parseCommhubToolResult } from "./commhub-response";
import { randomUUID } from "crypto";
import { join } from "path";
import { hostname } from "os";
import { execSync } from "child_process";
import { encodeCwd } from "./project-key";
import { loadOwnerOnlyEnvFile } from "./owner-env-file";
import {
  defaultControlledUploadRoots,
  uploadControlledLocalFile,
} from "./controlled-upload";

import {
  appendChannelAttachmentPaths,
  channelAttachmentCacheDir,
  downloadChannelAttachments,
} from "./channel-attachments";
import { sendChannelTaskWithTrace } from "./channel-task-trace";

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
// The Grok shared-TUI parent has no bearer token. Its one reviewed MCP child
// receives only this pointer to the launcher's protected credential file.
loadOwnerOnlyEnvFile(process.env.ANET_COMMHUB_ENV_FILE);
const HOME = process.env.HOME || "~";
const COMMHUB_DIR = join(HOME, ".claude/channels/commhub");
loadEnvFile(join(COMMHUB_DIR, ".env"));

// ── Load project-specific config ──────────────────────
// /path/to/your/work → -path-to-your-work (POSIX)
// C:\Users\foo → C--Users-foo (Windows)
// Scheme matches claude-code's own <sanitized-cwd> so ~/.claude/channels/commhub
// and ~/.claude/projects sit side-by-side with matching keys.
const projectPath = encodeCwd(process.cwd());
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
// #203 — ALIAS used to silently fall back to TMUX_NAME (the tmux session name,
// which often outlives the node it was created for) or hostname() (a single
// constant for the whole machine, so every node on the box would attribute to
// the same value). Both fallbacks are the documented #203 attribution-bug
// vector. Now: require an explicit COMMHUB_ALIAS env var; log loudly + use a
// sentinel ("unattributed-<pid>") if missing so outbound from_session is
// obviously broken in the message DB instead of mis-attributing to a previous
// node. `anet node start` always sets COMMHUB_ALIAS at spawn (see
// cli.ts:2307), so the sentinel only fires when a node-server.js is launched
// out-of-band (rare, hand-rolled debugging scenarios).
function resolveAlias(): string {
  if (process.env.COMMHUB_ALIAS && process.env.COMMHUB_ALIAS.trim()) {
    return process.env.COMMHUB_ALIAS.trim();
  }
  // Stay loud on stderr — claude-code MCP loop suppresses stdout but stderr
  // surfaces in tmux pane / agent log so the operator can see this.
  process.stderr.write(
    `[commhub] WARN: COMMHUB_ALIAS env var is unset — outbound from_session ` +
    `would mis-attribute. Refusing to guess from TMUX_NAME=${TMUX_NAME || "(none)"} ` +
    `/ hostname=${hostname()}. Restart node via \`anet node start <alias>\` so ` +
    `the env is set explicitly (#203).\n`,
  );
  return `unattributed-${process.pid}`;
}
const ALIAS = resolveAlias();
const RESUME_ID = process.env.COMMHUB_RESUME_ID || process.env.CLAUDE_RESUME_ID || randomUUID();
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || ANET_CONFIG.token || "";
// Grok co-presence already has one agent-node owner for inbox, lifecycle and
// presence. Its model-facing MCP child must therefore be a pure outbound tool
// client: no channel capability, no SSE subscription, no inbox claim/ack, no
// registration/heartbeat/offline report. Keep the legacy full channel mode as
// the default for Claude Code installations that launch this same artifact.
const OUTBOUND_ONLY = process.env.ANET_COMMHUB_MODE === "outbound-only";

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [commhub] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

log(`ENV: URL=${COMMHUB_URL} ALIAS=${ALIAS} RESUME_ID=${RESUME_ID.slice(0, 8)}... TMUX=${TMUX_NAME || "none"} CWD=${process.cwd()} PROJECT_ENV=${projectPath} MODE=${OUTBOUND_ONLY ? "outbound-only" : "channel"}`);

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
    capabilities: OUTBOUND_ONLY
      ? { tools: {} }
      : { experimental: { "claude/channel": {} }, tools: {} },
    instructions: OUTBOUND_ONLY
      ? [
          `This is the outbound-only CommHub tool client for session alias ${ALIAS}.`,
          `It never receives or acknowledges inbox rows and never owns lifecycle or presence.`,
          `Use commhub_send_task for peer results; commhub_send_message is non-lifecycle chat.`,
        ].join("\n")
      : [
          `Messages from CommHub arrive as <channel source="commhub" task_id="..." priority="..." from="...">`,
          `These are tasks dispatched by the hub or other sessions via the CommHub Server.`,
          `Reply routing (IMPORTANT — the tool you pick determines whether the receiver actually gets woken up):`,
          `  • If the sender is another agent node (from CommHub, from your peer's session alias), reply with commhub_send_task(alias="<their alias>", task="<your reply>"). This creates a new routable task that wakes the peer via new_task SSE so they process it. commhub_reply does NOT wake agent peers — they'd only see it on the next inbox poll (Vincent 2026-07-28 全网规则).`,
          `  • Only use commhub_reply when the sender is the Dashboard/UI (task_id came from a browser chat). Use status="completed" (terminal) so send_reply routes it, updates the task row (Dashboard displays it), and emits new_reply SSE for the live Dashboard viewer. Non-terminal status (in_progress/blocked/error) just updates your session status and does NOT reach the Dashboard.`,
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
      description: "Reply to a Dashboard/UI-originated CommHub task. ⚠ For agent-to-agent replies use commhub_send_task instead — commhub_reply does NOT wake agent peers via SSE (Vincent 2026-07-28 全网规则). status=\"completed\" (terminal) routes to send_reply and emits new_reply SSE for the live Dashboard; non-terminal status (in_progress/blocked/error) only updates session status (report_status) and does NOT reach the Dashboard.",
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
    {
      name: "commhub_upload_file",
      description: "Upload a controlled local file to CommHub (returns file_id for attachments). Max 12 MiB. Rejects path traversal/symlinks/untrusted roots. Cross-host: streams bytes to Hub /api/upload.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Local path under controlled roots" },
          name: { type: "string", description: "Optional display filename" },
          mime: { type: "string", description: "Optional MIME type" },
        },
        required: ["path"],
      },
    },
  ].filter((tool) => !OUTBOUND_ONLY || OUTBOUND_TOOL_NAMES.has(tool.name)),
}));

// Helper: call CommHub MCP endpoint
async function callCommHub(toolName: string, args: Record<string, unknown>): Promise<any> {
  const connectionHeader: Record<string, string> = OUTBOUND_ONLY ? { Connection: "close" } : {};
  const initRes = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...connectionHeader,
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
      ...connectionHeader,
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
    // #1100 — never let an isError / non-JSON body throw here (see
    // commhub-response.ts). Returns a structured {ok:false,error} instead
    // of surfacing an opaque -32603 that hides the real cause.
    return parseCommhubToolResult(json);
  }
  return { ok: false, error: "no response" };
}

mcp.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const { name, arguments: args } = req.params;

  // tools/list is not the security boundary: a client can issue tools/call
  // with an arbitrary name. Reject lifecycle/presence/inbound names before
  // any Hub request so a direct call cannot widen outbound-only mode.
  if (OUTBOUND_ONLY && !OUTBOUND_TOOL_NAMES.has(name)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ ok: false, error: "tool unavailable in outbound-only mode" }),
      }],
    };
  }

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
    const result = await sendChannelTaskWithTrace({
      alias: String(alias || ""), task: String(task || ""), priority,
      fromAlias: ALIAS,
      networkId: process.env.ANET_NETWORK_ID || ANET_CONFIG.network_id || null,
    }, {
      send: (sendArgs) => callCommHub("send_task", sendArgs),
      log: (line) => process.env.ANET_TASK_TRACE_FORMAT === "json"
        ? process.stderr.write(`${line}\n`)
        : log(line),
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

  if (name === "commhub_upload_file") {
    const { path: filePath, name: fileName, mime } = args as any;
    const result = await uploadControlledLocalFile(String(filePath || ""), {
      hubUrl: COMMHUB_URL,
      authToken: AUTH_TOKEN || "",
      alias: ALIAS,
      nodeDir: process.env.ANET_NODE_DIR || undefined,
      allowedRoots: defaultControlledUploadRoots({
        alias: ALIAS,
        nodeDir: process.env.ANET_NODE_DIR || undefined,
      }),
    }, {
      name: typeof fileName === "string" ? fileName : undefined,
      mime: typeof mime === "string" ? mime : undefined,
    });
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  return { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }] };
});

// ── SSE Listener: subscribe to /events/:alias ─────
// #202 — auto-reconnect after hub restart. Exponential backoff 1→2→4→8→30s
// (per issue spec), and re-send register on every successful (re)connect so
// the node reappears on dashboard within ~30s of hub coming back, instead of
// waiting up to one 3-minute heartbeat tick. firstConnect guard prevents the
// boot-time double-register (main() already fires one register at startup).
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const ABANDON_AFTER_MS = 60 * 60 * 1_000;

// Re-register on reconnect. Mirrors the payload main() sends at boot.
async function reregister(): Promise<void> {
  try {
    await callCommHub("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: "idle",
      server: hostname(),
      hostname: hostname(),
      agent: "claude-code",
      project_dir: process.cwd(),
      tmux_name: TMUX_NAME || undefined,
    });
    log(`re-registered as "${ALIAS}" after SSE reconnect`);
  } catch (e) {
    log(`re-register failed: ${e}`);
  }
}

async function connectSSE() {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  log(`connecting to ${url}`);

  let delay = BASE_DELAY_MS;
  let firstConnect = true;
  let downSince: number | null = null;

  while (true) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`SSE error: ${res.status} ${res.statusText}`);
        downSince = downSince ?? Date.now();
        if (Date.now() - downSince > ABANDON_AFTER_MS) {
          log(`SSE 连续 >1h 连不上 hub (${COMMHUB_URL}) — 放弃自动重连。手动 anet node start 恢复。`);
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
        continue;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      delay = BASE_DELAY_MS;

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
            if (event.type === "connected") {
              downSince = null;
              if (!firstConnect) await reregister();
              firstConnect = false;
            }
          } catch (e) {
            log(`parse error: ${e}`);
          }
        }
      }

      log("SSE stream ended, reconnecting...");
    } catch (err) {
      log(`SSE connection error: ${err}`);
    }

    // Read loop exited (stream ended or threw) — start the reconnect timer.
    downSince = downSince ?? Date.now();
    if (Date.now() - downSince > ABANDON_AFTER_MS) {
      log(`SSE 连续 >1h 连不上 hub (${COMMHUB_URL}) — 放弃自动重连。手动 anet node start 恢复。`);
      return;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
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
        let channelContent = String(msg.content || "");
        try {
          const attachments = await downloadChannelAttachments(msg, {
            hubUrl: COMMHUB_URL,
            authToken: AUTH_TOKEN,
            cacheDir: channelAttachmentCacheDir(HOME, ALIAS),
          });
          channelContent = appendChannelAttachmentPaths(channelContent, attachments.paths);
          for (const failure of attachments.failures) {
            log(`attachment ${failure.fileId || "(legacy)"} not surfaced (${failure.code}): ${failure.message}`);
          }
        } catch (error) {
          // Attachments are additive. Never drop or fail the text task when a
          // cache/fetch implementation hits an unexpected host error.
          log(`attachment resolver failed unexpectedly; preserving text-only task: ${error instanceof Error ? error.message : String(error)}`);
        }
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
            content: channelContent,
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

  if (OUTBOUND_ONLY) {
    log("ready — outbound-only tools; no channel/SSE/inbox/lifecycle/presence owner");
    return;
  }

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
  if (OUTBOUND_ONLY) {
    log("shutting down outbound-only MCP client");
  } else {
    log("shutting down, reporting offline...");
    await callCommHub("report_status", {
      resume_id: RESUME_ID,
      alias: ALIAS,
      status: "offline",
      task: "session disconnected",
    }).catch(() => {});
  }
  process.exit(0);
}

process.stdin.on("end", () => gracefulShutdown());
process.on("SIGTERM", () => gracefulShutdown());
process.on("SIGINT", () => gracefulShutdown());

// #180 — parent-alive invariant. This MCP bridge is spawned by claude
// (Claude Code CLI) via stdio; its lifetime MUST NOT outlive claude's.
// If claude dies suddenly (SIGKILL, OOM, crash) before we see stdin EOF,
// we'd otherwise get reparented to PID 1 and keep heart-beating with the
// old COMMHUB_ALIAS → dashboard ghost + commhub ON CONFLICT(resume_id)
// upsert reverts a downstream rename (SDK马 Finding B — the #180 root
// cause). Method-2 defense-in-depth (通信龙 4ce3fe4a): periodic check —
// if our original parent is gone (reparent to PID 1 OR original PPID
// process no longer alive), report offline and self-exit. Method 1
// (agent-network/bin/cli.ts sweepMcpOrphansForAlias) is the primary fix
// on the kill side; this ensures the invariant holds even for parent
// deaths outside a rename (crash / OOM / user kill).
//
// The check is Linux-first (getppid() only meaningful on POSIX) but
// harmless on other platforms — kill(pid, 0) throws consistently.
const _ORIGINAL_PPID = process.ppid;
if (_ORIGINAL_PPID && _ORIGINAL_PPID > 1) {
  const _parentCheckTimer = setInterval(() => {
    // Reparent-to-PID-1 is the canonical Linux orphan signal.
    if (process.ppid === 1 && _ORIGINAL_PPID !== 1) {
      log(`parent claude died (reparented to PID 1 from ${_ORIGINAL_PPID}) — self-exit to avoid ghost heart-beat`);
      gracefulShutdown();
      return;
    }
    // Belt: original PPID no longer alive (some Linux configs may not
    // reparent immediately, or Docker init proxies may hold the ppid link).
    try {
      process.kill(_ORIGINAL_PPID, 0);
    } catch (e: any) {
      if (e?.code === "ESRCH") {
        log(`parent claude pid=${_ORIGINAL_PPID} no longer exists (kill-0 ESRCH) — self-exit to avoid ghost heart-beat`);
        gracefulShutdown();
      }
      // EPERM = parent moved to a different security context but is
      // still alive; not our signal. Any other error is best-effort skip.
    }
  }, 30_000);
  // Never keep the event loop alive just for this check.
  if (typeof _parentCheckTimer.unref === "function") _parentCheckTimer.unref();
}
