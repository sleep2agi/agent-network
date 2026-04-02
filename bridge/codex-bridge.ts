#!/usr/bin/env bun
/**
 * CommHub-Codex Bridge
 *
 * Bridges CommHub task dispatch to Codex app-server using the same
 * JSON-RPC protocol proven by codex-plugin-cc (cc-connect).
 *
 * Flow: CommHub SSE → get_inbox → spawn codex app-server →
 *       JSON-RPC (initialize → thread/start → turn/start) →
 *       collect turn/completed → report_completion back to CommHub
 */

import { spawn, type ChildProcess } from "child_process";
import { hostname } from "os";
import { createInterface } from "readline";

// ── Config ──────────────────────────────────────────
const COMMHUB_URL = process.env.COMMHUB_URL || "http://127.0.0.1:9200";
const ALIAS = process.env.COMMHUB_ALIAS || `codex-${hostname()}`;
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || "";
const WORK_DIR = process.env.CODEX_CWD || process.cwd();
const SANDBOX = process.env.CODEX_SANDBOX || "read-only";

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [codex-bridge] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CommHub MCP API ─────────────────────────────────

async function callCommHub(toolName: string, args: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex-bridge", version: "1.0.0" },
      },
    }),
  });

  const res = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
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
    return json?.result?.content?.[0]?.text
      ? JSON.parse(json.result.content[0].text)
      : json;
  }
  return { ok: false, error: "no response" };
}

// ── Codex App-Server JSON-RPC Client ────────────────
// Protocol extracted from codex-plugin-cc source:
//   ~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/lib/app-server.mjs

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class CodexClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private notificationHandler: ((msg: any) => void) | null = null;
  stderr = "";

  async connect(cwd: string): Promise<void> {
    // Same as SpawnedCodexAppServerClient in cc-connect
    this.proc = spawn("codex", ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    this.proc.on("exit", (code, signal) => {
      const err = new Error(`codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    // NDJL reader (same as cc-connect's readline approach)
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (e) {
        log(`JSON parse error: ${e}`);
      }
    });

    // Handshake: initialize → initialized (same as cc-connect)
    await this.request("initialize", {
      clientInfo: {
        name: "CommHub Bridge",
        title: "CommHub-Codex Bridge",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  private handleMessage(msg: any) {
    // Server Request (has id + method) — auto-reject unsupported
    if (msg.id !== undefined && msg.method) {
      this.send({
        id: msg.id,
        error: { code: -32601, message: `Unsupported: ${msg.method}` },
      });
      return;
    }

    // Response (has id, no method)
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message || "RPC error"));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method && this.notificationHandler) {
      this.notificationHandler(msg);
    }
  }

  request(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: any = {}) {
    this.send({ method, params });
  }

  onNotification(handler: (msg: any) => void) {
    this.notificationHandler = handler;
  }

  async close() {
    this.proc?.stdin?.end();
    await sleep(100);
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }
}

// ── Execute task via Codex app-server ───────────────
// Replicates runAppServerTurn from codex.mjs

async function executeTask(
  prompt: string,
  cwd: string,
): Promise<{ status: string; result: string; threadId: string; touchedFiles: string[] }> {
  const client = new CodexClient();
  await client.connect(cwd);
  log("codex app-server connected");

  // thread/start (same params as cc-connect: codex.mjs:56-66)
  const threadResp = await client.request("thread/start", {
    cwd,
    model: null,
    approvalPolicy: "never",
    sandbox: SANDBOX,
    serviceName: "commhub_codex_bridge",
    ephemeral: true,
    experimentalRawEvents: false,
  });
  const threadId = threadResp.thread.id;
  log(`thread: ${threadId}`);

  // State machine (simplified from cc-connect's captureTurn)
  let lastAgentMessage = "";
  let turnStatus = "unknown";
  const touchedFiles: string[] = [];

  const completion = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Codex turn timed out after 10 minutes"));
    }, 600_000);

    client.onNotification((msg) => {
      switch (msg.method) {
        case "item/started":
          if (msg.params?.item?.type === "commandExecution") {
            log(`  running: ${msg.params.item.command?.slice(0, 80)}`);
          }
          break;
        case "item/completed":
          if (msg.params?.item?.type === "agentMessage" && msg.params.item.text) {
            lastAgentMessage = msg.params.item.text;
          }
          if (msg.params?.item?.type === "fileChange") {
            for (const c of msg.params.item.changes ?? []) {
              if (c.path) touchedFiles.push(c.path);
            }
          }
          break;
        case "turn/completed":
          turnStatus = msg.params?.turn?.status || "completed";
          clearTimeout(timeout);
          resolve();
          break;
        case "error":
          log(`codex error: ${msg.params?.error?.message}`);
          break;
      }
    });
  });

  // turn/start (same params as cc-connect: codex.mjs:870-876)
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    model: null,
    effort: null,
    outputSchema: null,
  });
  log("turn started, waiting...");

  await completion;
  log(`turn ${turnStatus}: ${lastAgentMessage.slice(0, 80)}...`);

  await client.close();

  return { status: turnStatus, result: lastAgentMessage, threadId, touchedFiles };
}

// ── SSE listener for CommHub tasks ──────────────────

async function connectSSE() {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  log(`SSE connecting: ${url}`);

  while (true) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`SSE ${res.status}, retrying...`);
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
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === "connected") {
              log(`SSE connected as "${ALIAS}"`);
            } else if (event.type === "new_task" || event.type === "broadcast") {
              handleNewTask().catch((e) => log(`task handler error: ${e}`));
            }
          } catch {}
        }
      }
      log("SSE stream ended, reconnecting...");
    } catch (err) {
      log(`SSE error: ${err}`);
    }
    await sleep(3000);
  }
}

// ── Task handler ────────────────────────────────────

let busy = false;

async function handleNewTask() {
  if (busy) {
    log("busy, skipping");
    return;
  }

  const inbox = await callCommHub("get_inbox", { alias: ALIAS, limit: 1 });
  if (!inbox?.ok || !inbox.messages?.length) return;

  const msg = inbox.messages[0];
  const task = msg.content as string;
  log(`← task [${msg.id.slice(0, 8)}]: ${task.slice(0, 80)}`);

  await callCommHub("ack_inbox", { alias: ALIAS, message_id: msg.id });

  busy = true;
  await callCommHub("report_status", {
    alias: ALIAS,
    status: "working",
    task: task.slice(0, 200),
  });

  try {
    const result = await executeTask(task, WORK_DIR);

    await callCommHub("report_completion", {
      alias: ALIAS,
      task: task.slice(0, 200),
      result: result.result || `Codex turn ${result.status}`,
      artifacts: result.touchedFiles.length > 0 ? result.touchedFiles : undefined,
    });
    log(`→ done: ${result.result.slice(0, 80)}`);
  } catch (err) {
    log(`task error: ${err}`);
    await callCommHub("report_status", {
      alias: ALIAS,
      status: "error",
      task: `Error: ${err}`,
    });
  }

  busy = false;
  await callCommHub("report_status", { alias: ALIAS, status: "idle" });
}

// ── Main ────────────────────────────────────────────

async function main() {
  log(`ALIAS=${ALIAS} COMMHUB=${COMMHUB_URL} CWD=${WORK_DIR} SANDBOX=${SANDBOX}`);

  await callCommHub("report_status", {
    alias: ALIAS,
    status: "idle",
    server: hostname(),
    hostname: hostname(),
    agent: "codex",
    project_dir: WORK_DIR,
  });
  log(`registered as "${ALIAS}"`);

  connectSSE().catch((err) => log(`SSE fatal: ${err}`));
  log("ready — waiting for CommHub tasks");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
