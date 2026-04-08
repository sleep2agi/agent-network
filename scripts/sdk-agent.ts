#!/usr/bin/env bun
/**
 * CommHub SDK Agent — 用 Claude Agent SDK 创建持续运行的 Agent
 *
 * 功能：
 * 1. 启动时注册到 CommHub
 * 2. 轮询 inbox 接收任务
 * 3. 用 Claude Agent SDK query() 处理任务（支持 MCP 工具）
 * 4. 自动回报结果
 * 5. Session resume 保持上下文
 *
 * 用法：
 *   ANTHROPIC_API_KEY=xxx bun scripts/sdk-agent.ts --alias SDK马 --url http://47.77.216.1:9200
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY — Anthropic API key（必需）
 *   COMMHUB_URL       — CommHub Server 地址（默认 http://127.0.0.1:9200）
 *   COMMHUB_ALIAS     — Agent 别名
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// ── 参数解析 ──
const args = process.argv.slice(2);
let ALIAS = process.env.COMMHUB_ALIAS || "SDK马";
let COMMHUB_URL = process.env.COMMHUB_URL || "http://127.0.0.1:9200";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--alias") ALIAS = args[++i];
  if (args[i] === "--url") COMMHUB_URL = args[++i];
}

const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [${ALIAS}] ${msg}`);

// ── CommHub API 调用 ──
async function callCommHub(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
  });
  const data = await res.json() as any;
  const text = data?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : data;
}

// ── 注册到 CommHub ──
async function register() {
  const hostname = (await import("os")).hostname();
  const result = await callCommHub("report_status", {
    resume_id: `sdk-${ALIAS}`,
    alias: ALIAS,
    status: "idle",
    server: hostname,
    hostname: hostname,
    agent: "claude-agent-sdk",
    project_dir: process.cwd(),
  });
  log(`registered: ${JSON.stringify(result)}`);
}

// ── 获取 inbox 消息 ──
async function getInbox(): Promise<any[]> {
  const result = await callCommHub("get_inbox", { alias: ALIAS, limit: 5 });
  return result?.messages || [];
}

// ── ACK 消息 ──
async function ackMessage(messageId: string) {
  await callCommHub("ack_inbox", { alias: ALIAS, message_id: messageId });
}

// ── 发送回复 ──
async function sendReply(targetAlias: string, message: string) {
  await callCommHub("send_task", {
    alias: targetAlias,
    task: message,
    priority: "normal",
    from_session: ALIAS,
  });
}

// ── 上报状态 ──
async function reportStatus(status: string, task?: string) {
  await callCommHub("report_status", {
    resume_id: `sdk-${ALIAS}`,
    alias: ALIAS,
    status,
    task: task || undefined,
  });
}

// ── 用 Claude Agent SDK 处理任务 ──
let sessionId: string | undefined;

async function processTask(task: string, from: string): Promise<string> {
  log(`→ processing task from ${from}: ${task.slice(0, 80)}`);
  await reportStatus("working", task.slice(0, 200));

  const prompt = `你是 ${ALIAS}，收到来自 ${from} 的任务：

${task}

执行完后简要汇报结果。`;

  let result = "";

  try {
    const options: any = {
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      mcpServers: {
        commhub: {
          type: "http" as const,
          url: `${COMMHUB_URL}/mcp`,
        },
      },
      allowedMcpTools: ["mcp__commhub__*"],
      permissionMode: "bypassPermissions",
    };

    // 如果有 session，续上之前的上下文
    if (sessionId) {
      options.resume = sessionId;
    }

    for await (const message of query({ prompt, options })) {
      // 捕获 session ID
      if ((message as any).type === "system" && (message as any).subtype === "init") {
        sessionId = (message as any).session_id;
      }
      // 捕获最终结果
      if ((message as any).type === "result" && (message as any).subtype === "success") {
        result = (message as any).result || "任务完成";
      }
      // 捕获错误
      if ((message as any).type === "result" && (message as any).subtype === "error_during_execution") {
        result = `执行出错: ${(message as any).error || "未知错误"}`;
      }
    }
  } catch (err: any) {
    result = `SDK 调用失败: ${err.message}`;
    log(`✗ error: ${err.message}`);
  }

  await reportStatus("idle");
  return result;
}

// ── 处理 inbox 消息 ──
async function processInbox() {
  const messages = await getInbox();
  if (messages.length === 0) return;

  for (const msg of messages) {
    const from = msg.from_session || "hub";
    const content = msg.content || "";
    const msgId = msg.id;

    await ackMessage(msgId);
    log(`← task from=${from}: ${content.slice(0, 60)}`);

    const result = await processTask(content, from);

    try {
      await sendReply(from, `[${ALIAS}] ${result.slice(0, 2000)}`);
      log(`→ replied to ${from}: ${result.slice(0, 60)}`);
    } catch (e: any) {
      log(`reply failed: ${e.message}`);
    }
  }
}

// ── SSE 长连接监听 ──
async function connectSSE() {
  const encodedAlias = encodeURIComponent(ALIAS);
  const sseUrl = `${COMMHUB_URL}/events/${encodedAlias}`;
  let reconnectDelay = 3000;

  while (true) {
    log(`SSE connecting: ${sseUrl}`);
    try {
      const res = await fetch(sseUrl, {
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        log(`SSE connection failed: ${res.status}`);
        await new Promise((r) => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 1.5, 60_000);
        continue;
      }

      reconnectDelay = 3000; // 重连成功，重置延迟
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);

          try {
            const event = JSON.parse(data);

            if (event.type === "connected") {
              log(`SSE connected as "${ALIAS}"`);
              continue;
            }

            if (event.type === "new_task" || event.type === "new_message" || event.type === "broadcast") {
              log(`← SSE ${event.type} from=${event.from || "?"} priority=${event.priority || "normal"}`);
              await processInbox();
            }
          } catch {
            // 忽略非 JSON 行（keepalive 等）
          }
        }
      }
    } catch (err: any) {
      log(`SSE error: ${err.message}`);
    }

    log(`SSE disconnected, reconnecting in ${reconnectDelay / 1000}s...`);
    await new Promise((r) => setTimeout(r, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 1.5, 60_000);
  }
}

// ── 主入口 ──
async function mainLoop() {
  log(`starting: alias=${ALIAS} url=${COMMHUB_URL} mode=SSE`);

  // 注册
  await register();
  log("registered to CommHub");

  // 心跳：每 3 分钟
  setInterval(async () => {
    try {
      await reportStatus("idle");
    } catch (e: any) {
      log(`heartbeat failed: ${e.message}`);
    }
  }, 3 * 60 * 1000);

  // SSE 长连接（阻塞，自动重连）
  await connectSSE();
}

// ── 优雅退出 ──
process.on("SIGINT", async () => {
  log("shutting down...");
  await reportStatus("offline").catch(() => {});
  process.exit(0);
});
process.on("SIGTERM", async () => {
  log("shutting down...");
  await reportStatus("offline").catch(() => {});
  process.exit(0);
});

mainLoop().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
