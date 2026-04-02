# CommHub-Codex Bridge 协议设计

> 日期: 2026-04-02
> 目标: 复用 codex-plugin-cc 验证过的协议，让 CommHub 能给 Codex 派任务并收结果
> 方法: 从 `~/.claude/plugins/marketplaces/openai-codex/` 源码提取完整协议

---

## 1. cc-connect 协议完整解析

### 1.1 连接建立

codex-plugin-cc 通过 `codex app-server` 建立连接。两种方式：

**直连模式** (`SpawnedCodexAppServerClient`):
```javascript
// 源码: lib/app-server.mjs:188
this.proc = spawn("codex", ["app-server"], {
  cwd: this.cwd,
  stdio: ["pipe", "pipe", "pipe"]  // stdin, stdout, stderr 全部 pipe
});
```

**Broker 模式** (`BrokerCodexAppServerClient`):
```javascript
// 源码: lib/app-server.mjs:268
this.socket = net.createConnection({ path: target.path });  // Unix domain socket
```

### 1.2 消息格式

**NDJL (Newline Delimited JSON Lines)**——每行一条 JSON，省略 `jsonrpc` 字段：

```json
// Client → Server (Request, 有 id)
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"CommHub Bridge","version":"1.0.0"},"capabilities":{"experimentalApi":false}}}

// Client → Server (Notification, 无 id)
{"method":"initialized","params":{}}

// Server → Client (Response, 有 id + result)
{"id":1,"result":{"serverInfo":{"name":"codex","version":"0.118.0"}}}

// Server → Client (Notification, 有 method 无 id)
{"method":"turn/completed","params":{"threadId":"t_abc","turn":{"id":"turn_123","status":"completed"}}}

// Server → Client (Error)
{"id":2,"error":{"code":-32001,"message":"Server overloaded; retry later"}}
```

### 1.3 完整通信流程（从源码提取）

```
CommHub Bridge                          codex app-server
     │                                        │
     │  ① initialize                          │
     │  {"id":1,"method":"initialize",        │
     │   "params":{"clientInfo":{...},        │
     │             "capabilities":{...}}}     │
     │───────────────────────────────────────▶│
     │                                        │
     │  ② initialize response                 │
     │  {"id":1,"result":{                    │
     │   "serverInfo":{"name":"codex",...}}}  │
     │◀───────────────────────────────────────│
     │                                        │
     │  ③ initialized notification            │
     │  {"method":"initialized","params":{}}  │
     │───────────────────────────────────────▶│
     │                                        │
     │  ④ thread/start                        │
     │  {"id":2,"method":"thread/start",      │
     │   "params":{"cwd":"/path",             │
     │    "approvalPolicy":"never",           │
     │    "sandbox":"read-only",              │
     │    "ephemeral":true}}                  │
     │───────────────────────────────────────▶│
     │                                        │
     │  ⑤ thread/start response               │
     │  {"id":2,"result":{                    │
     │   "thread":{"id":"t_abc123"}}}         │
     │◀───────────────────────────────────────│
     │                                        │
     │  ⑥ turn/start                          │
     │  {"id":3,"method":"turn/start",        │
     │   "params":{"threadId":"t_abc123",     │
     │    "input":[{"type":"text",            │
     │     "text":"审查这段代码"}]}}            │
     │───────────────────────────────────────▶│
     │                                        │
     │  ⑦ turn/start response                 │
     │  {"id":3,"result":{                    │
     │   "turn":{"id":"turn_xyz",             │
     │    "status":"inProgress"}}}            │
     │◀───────────────────────────────────────│
     │                                        │
     │  ⑧ 流式通知 (多条)                      │
     │  {"method":"turn/started",             │
     │   "params":{"threadId":"t_abc123",     │
     │    "turn":{"id":"turn_xyz"}}}          │
     │◀───────────────────────────────────────│
     │                                        │
     │  {"method":"item/started",             │
     │   "params":{"threadId":"t_abc123",     │
     │    "item":{"type":"commandExecution",  │
     │     "command":"git diff"}}}            │
     │◀───────────────────────────────────────│
     │                                        │
     │  {"method":"item/completed",           │
     │   "params":{"threadId":"t_abc123",     │
     │    "item":{"type":"agentMessage",      │
     │     "text":"审查完成，发现3个问题...",    │
     │     "phase":"final_answer"}}}          │
     │◀───────────────────────────────────────│
     │                                        │
     │  ⑨ turn/completed                      │
     │  {"method":"turn/completed",           │
     │   "params":{"threadId":"t_abc123",     │
     │    "turn":{"id":"turn_xyz",            │
     │     "status":"completed"}}}            │
     │◀───────────────────────────────────────│
     │                                        │
     │  ⑩ 关闭 stdin (结束连接)                │
     │──────────× close ×────────────────────│
```

### 1.4 关键参数详解

**thread/start params** (源码: `codex.mjs:56-66`):
```typescript
{
  cwd: string,              // 工作目录
  model: string | null,     // 模型 (null = 默认)
  approvalPolicy: "never" | "unless-allow-listed" | "always",  // 审批策略
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
  serviceName: "claude_code_codex_plugin",  // 来源标识
  ephemeral: boolean,       // 临时 thread (不持久化)
  experimentalRawEvents: false
}
```

**turn/start params** (源码: `codex.mjs:870-876`):
```typescript
{
  threadId: string,
  input: [{ type: "text", text: string, text_elements: [] }],
  model: string | null,
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null,
  outputSchema: object | null  // JSON Schema for structured output
}
```

**turn/completed notification** 中的 `turn.status`:
- `"completed"` — 正常完成
- `"interrupted"` — 被中断
- `"failed"` — 失败

---

## 2. CommHub-Codex Bridge 架构

### 2.1 定位

Bridge 是一个运行在 Codex 所在机器上的进程，同时连接 CommHub（作为客户端）和 Codex app-server（作为控制器）。

```
CommHub Server                    Codex 所在机器
┌─────────────┐           ┌─────────────────────────────┐
│  CommHub     │           │  codex-bridge.ts             │
│  :9200       │◀── SSE ──│                              │
│              │── task ──▶│  ┌─ SSE 监听 CommHub 任务    │
│              │           │  │                           │
│              │◀── done ──│  ├─ spawn codex app-server   │
│              │           │  │    └─ JSON-RPC over stdio │
│              │           │  │                           │
│              │           │  └─ 结果回报 CommHub          │
└─────────────┘           └─────────────────────────────┘
                                      │ stdio
                                      ▼
                              codex app-server
                                      │
                                      ▼
                               OpenAI API
```

### 2.2 工作流程

1. Bridge 启动，向 CommHub `report_status(alias="codex-1", status="idle")`
2. Bridge 通过 SSE 监听 CommHub 的 `/events/codex-1`
3. CommHub 派任务 → SSE 推送 → Bridge 收到 `new_task` 事件
4. Bridge 调 `get_inbox` 拉取任务内容
5. Bridge spawn `codex app-server`，按 cc-connect 协议执行：
   - `initialize` → `thread/start` → `turn/start`
   - 监听通知流，收集结果
   - `turn/completed` 后提取 `lastAgentMessage`
6. Bridge 调 `report_completion(result=lastAgentMessage)` 回报 CommHub
7. Bridge 关闭 codex app-server，回到 idle 状态

---

## 3. 最小实现

### 3.1 codex-bridge.ts

```typescript
#!/usr/bin/env bun
/**
 * CommHub-Codex Bridge
 *
 * 复用 codex-plugin-cc 的 JSON-RPC 协议，让 CommHub 能给 Codex 派任务。
 * 运行在 Codex 所在机器上。
 */

import { spawn, type ChildProcess } from "child_process";
import { hostname } from "os";
import { createInterface } from "readline";

// ── Config ──────────────────────────────────────────
const COMMHUB_URL = process.env.COMMHUB_URL || "http://127.0.0.1:9200";
const ALIAS = process.env.COMMHUB_ALIAS || `codex-${hostname()}`;
const AUTH_TOKEN = process.env.COMMHUB_TOKEN || "";
const WORK_DIR = process.env.CODEX_CWD || process.cwd();
const SANDBOX = process.env.CODEX_SANDBOX || "read-only";  // read-only | workspace-write

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stderr.write(`[${ts}] [codex-bridge] ${msg}\n`);
}

// ── CommHub API helpers ─────────────────────────────
async function callCommHub(toolName: string, args: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  // Initialize
  await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "codex-bridge", version: "1.0.0" },
      },
    }),
  });

  // Call tool
  const res = await fetch(`${COMMHUB_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
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

// ── Codex App-Server Client ─────────────────────────
// 完全复用 cc-connect 的协议

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
    this.proc = spawn("codex", ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr!.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) {
        p.reject(new Error(`codex app-server exited (${code})`));
      }
      this.pending.clear();
    });

    // 逐行读取 stdout (NDJL)
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch (e) {
        log(`parse error: ${e}`);
      }
    });

    // 握手: initialize → initialized
    await this.request("initialize", {
      clientInfo: { name: "CommHub Bridge", title: "CommHub-Codex Bridge", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
    log("codex app-server connected");
  }

  private handleMessage(msg: any) {
    // Response (有 id, 无 method)
    if (msg.id !== undefined && !msg.method) {
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

    // Notification (有 method, 无 id)
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

  private send(msg: any) {
    this.proc?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  async close() {
    this.proc?.stdin?.end();
    // Grace period then kill
    setTimeout(() => this.proc?.kill("SIGTERM"), 100);
  }
}

// ── Execute a task via Codex (复用 cc-connect 协议) ─
async function executeTask(prompt: string, cwd: string): Promise<{
  status: string;
  result: string;
  threadId: string;
  fileChanges: any[];
}> {
  const client = new CodexClient();
  await client.connect(cwd);

  // thread/start
  const threadResp = await client.request("thread/start", {
    cwd,
    model: null,
    approvalPolicy: "never",
    sandbox: SANDBOX,
    serviceName: "commhub_codex_bridge",
    ephemeral: true,
  });
  const threadId = threadResp.thread.id;
  log(`thread started: ${threadId}`);

  // 收集结果的状态
  let lastAgentMessage = "";
  let turnCompleted = false;
  let turnStatus = "unknown";
  const fileChanges: any[] = [];

  const completion = new Promise<void>((resolve) => {
    client.onNotification((msg) => {
      switch (msg.method) {
        case "item/completed":
          if (msg.params?.item?.type === "agentMessage" && msg.params.item.text) {
            lastAgentMessage = msg.params.item.text;
          }
          if (msg.params?.item?.type === "fileChange") {
            fileChanges.push(msg.params.item);
          }
          break;
        case "turn/completed":
          turnStatus = msg.params?.turn?.status || "completed";
          turnCompleted = true;
          resolve();
          break;
        case "error":
          log(`codex error: ${msg.params?.error?.message}`);
          break;
      }
    });
  });

  // turn/start
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    model: null,
    effort: null,
    outputSchema: null,
  });
  log(`turn started, waiting for completion...`);

  // 等待 turn/completed
  await completion;
  log(`turn completed: ${turnStatus}`);

  await client.close();

  return {
    status: turnStatus,
    result: lastAgentMessage,
    threadId,
    fileChanges,
  };
}

// ── SSE Listener: 监听 CommHub 任务 ─────────────────
async function connectSSE() {
  const url = `${COMMHUB_URL}/events/${encodeURIComponent(ALIAS)}`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  log(`connecting SSE: ${url}`);

  while (true) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`SSE error: ${res.status}`);
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
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        for (const block of blocks) {
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;

          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === "connected") {
              log(`SSE connected as "${ALIAS}"`);
              continue;
            }
            if (event.type === "new_task" || event.type === "broadcast") {
              await handleNewTask();
            }
          } catch (e) {
            log(`SSE parse error: ${e}`);
          }
        }
      }

      log("SSE stream ended, reconnecting...");
    } catch (err) {
      log(`SSE error: ${err}`);
    }

    await Bun.sleep(3000);
  }
}

// ── 处理新任务 ──────────────────────────────────────
let busy = false;

async function handleNewTask() {
  if (busy) {
    log("busy, skipping new task notification");
    return;
  }

  const inbox = await callCommHub("get_inbox", { alias: ALIAS, limit: 1 });
  if (!inbox?.ok || !inbox.messages?.length) return;

  const msg = inbox.messages[0];
  const taskContent = msg.content as string;
  log(`← task: ${taskContent.slice(0, 80)}...`);

  // ACK
  await callCommHub("ack_inbox", { alias: ALIAS, message_id: msg.id });

  // Update status
  busy = true;
  await callCommHub("report_status", {
    alias: ALIAS,
    status: "working",
    task: taskContent.slice(0, 200),
  });

  try {
    // 执行 Codex 任务
    const result = await executeTask(taskContent, WORK_DIR);

    // 回报结果
    await callCommHub("report_completion", {
      alias: ALIAS,
      task: taskContent.slice(0, 200),
      result: result.result || `Codex turn ${result.status}`,
      artifacts: result.fileChanges.length > 0
        ? result.fileChanges.map((fc) => JSON.stringify(fc.changes?.map((c: any) => c.path)))
        : undefined,
    });

    log(`→ completed: ${result.result.slice(0, 80)}...`);
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
  log(`starting: ALIAS=${ALIAS} COMMHUB=${COMMHUB_URL} CWD=${WORK_DIR}`);

  // 注册到 CommHub
  await callCommHub("report_status", {
    alias: ALIAS,
    status: "idle",
    server: hostname(),
    hostname: hostname(),
    agent: "codex",
    project_dir: WORK_DIR,
  });
  log(`registered as "${ALIAS}"`);

  // 启动 SSE 监听
  connectSSE().catch((err) => log(`SSE fatal: ${err}`));

  log("ready — waiting for tasks");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});
```

### 3.2 使用方式

```bash
# 在 Codex 所在机器上
cd agent-orchestra/bridge
bun install

# 启动 bridge
COMMHUB_URL=http://YOUR_COMMHUB_IP:9200 \
COMMHUB_ALIAS=codex-review \
CODEX_CWD=/path/to/project \
CODEX_SANDBOX=read-only \
  bun run codex-bridge.ts

# 然后从 CommHub 或任何 Agent 发任务
# send_task(alias="codex-review", task="审查最近的代码改动，找出 top 3 问题")
```

### 3.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COMMHUB_URL` | `http://127.0.0.1:9200` | CommHub Server 地址 |
| `COMMHUB_ALIAS` | `codex-{hostname}` | 在 CommHub 中的 session 名称 |
| `COMMHUB_TOKEN` | (空) | CommHub 认证 token |
| `CODEX_CWD` | 当前目录 | Codex 工作目录 |
| `CODEX_SANDBOX` | `read-only` | Codex 沙箱模式 |

---

## 4. 协议对照表

| 步骤 | cc-connect 原始实现 | CommHub Bridge 实现 |
|------|--------------------|--------------------|
| 连接 Codex | `spawn("codex", ["app-server"])` | 相同 |
| 握手 | `initialize` → `initialized` | 相同 |
| 创建 thread | `thread/start` | 相同参数 |
| 发送 prompt | `turn/start` + `input` | 相同格式 |
| 接收结果 | `item/completed` (agentMessage) | 相同 |
| 完成判定 | `turn/completed` notification | 相同 |
| 中断任务 | `turn/interrupt` | 可选实现 |
| 关闭连接 | `stdin.end()` | 相同 |

**区别仅在任务来源**：cc-connect 从 Claude Code slash command 获取任务，Bridge 从 CommHub SSE 获取任务。Codex 侧的协议完全相同。

---

## 5. 限制和注意事项

1. **Codex 必须已安装且登录** — Bridge 启动前需确保 `codex login` 已完成
2. **单任务串行** — 当前实现一次只处理一个任务（busy 锁），与 cc-connect 的 Broker 独占访问一致
3. **approvalPolicy: "never"** — 自动批准所有命令执行，适合自动化场景
4. **sandbox: "read-only"** 默认 — 安全起见默认只读，需要写入时设 `CODEX_SANDBOX=workspace-write`
5. **无 Broker 模式** — 最小实现不包含 Broker（每次任务新建 app-server 进程），可后续添加
