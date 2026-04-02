# Codex App-Server 调研报告

> 日期: 2026-04-02
> 版本: Codex CLI v0.118.0
> 状态: 实验性 (experimental) — 协议可能随版本变化

---

## 一句话总结

Codex app-server 是 Codex 的**无头后端模式**——把 Codex agent 引擎暴露为可编程服务。它是**单兵控制器**（精确控制一个 Codex 实例），不是**消息总线**（不能路由、不能广播、不能多 Agent 编排）。

---

## 1. 协议概述

### 1.1 传输层

| 传输 | 启动方式 | 格式 | 状态 |
|------|---------|------|------|
| **stdio** (默认) | `codex app-server` | JSONL (每行一条 JSON) | 稳定 |
| **WebSocket** | `codex app-server --listen ws://0.0.0.0:PORT` | 每个 WS 帧一条 JSON | 实验性 |

WebSocket 模式额外提供两个 HTTP 端点：
- `GET /readyz` — 监听器就绪检查
- `GET /healthz` — 健康检查

**注意：没有 HTTP REST API。** 所有 Agent 交互走 JSON-RPC（stdio 或 WebSocket），不是 HTTP 请求。

### 1.2 消息协议

双向 JSON-RPC 2.0，但**省略了 `"jsonrpc":"2.0"` 字段**（刻意简化）。

消息分三类：
- **Client Request** (59 种) — 客户端发给 server，需要 response
- **Server Request** (9 种) — server 发给客户端，需要 response（如审批请求）
- **Server Notification** (51 种) — server 单向通知客户端（如流式输出）

### 1.3 初始化握手（必需）

每个连接必须先完成握手才能发其他请求：

```json
// 1. 客户端 → server: initialize
{"method": "initialize", "id": 0, "params": {
  "clientInfo": {"name": "my-client", "title": "My App", "version": "1.0.0"},
  "capabilities": {"experimentalApi": true}
}}

// 2. server → 客户端: 返回 server info、codexHome、平台信息

// 3. 客户端 → server: initialized 通知（无 id）
{"method": "initialized", "params": {}}
```

### 1.4 认证（非本地连接）

WebSocket 非 loopback 连接支持两种认证：
- **capability-token** — 基于文件的 token
- **signed-bearer-token** — JWT (issuer/audience/skew 验证)

通过 WebSocket 握手的 `Authorization: Bearer <token>` 头传递。

---

## 2. 核心能力

### 2.1 Thread（对话容器）

Thread 是一个完整的对话上下文，包含配置（模型、工作目录、沙箱策略）和多个 Turn。

| 操作 | 方法 | 说明 |
|------|------|------|
| 创建 | `thread/start` | 开始新对话 |
| 恢复 | `thread/resume` | 恢复已有对话 |
| 分叉 | `thread/fork` | 从某个点分叉出新对话 |
| 列表 | `thread/list` | 查看所有 thread |
| 回滚 | `thread/rollback` | 回滚到之前的状态 |
| 压缩 | `thread/compact/start` | 压缩上下文 |
| 归档 | `thread/archive` | 归档不活跃的 thread |

### 2.2 Turn（一轮交互）

Turn = 一次"用户提问 → Agent 完整响应"周期。

| 操作 | 方法 | 说明 |
|------|------|------|
| 开始 | `turn/start` | 发送 prompt，启动一轮执行 |
| 引导 | `turn/steer` | 中途给 Agent 补充指令 |
| 中断 | `turn/interrupt` | 中断当前执行 |
| 完成 | `turn/completed` (通知) | Agent 完成，状态: completed/interrupted/failed |

Turn 执行期间，server 通过通知流式输出进度：
- `item/started` / `item/completed` — 每个工作单元的开始和结束
- `item/agentMessage/delta` — Agent 文本流式输出
- `item/commandExecution/outputDelta` — 命令执行输出
- `item/fileChange/outputDelta` — 文件修改输出

### 2.3 Item（工作原子单元）

Item 是 Turn 内的最小工作单元，类型包括：

| 类型 | 说明 |
|------|------|
| `userMessage` | 用户消息 |
| `agentMessage` | Agent 回复 |
| `plan` | 执行计划 |
| `reasoning` | 推理过程 |
| `commandExecution` | Shell 命令执行 |
| `fileChange` | 文件修改 |
| `mcpToolCall` | MCP 工具调用 |
| `webSearch` | 网页搜索 |

### 2.4 Command（独立命令执行）

不在 Thread 上下文中的独立命令执行：

| 方法 | 说明 |
|------|------|
| `command/exec` | 执行命令 |
| `command/exec/write` | 向正在执行的命令写入 stdin |
| `command/exec/terminate` | 终止命令 |
| `command/exec/resize` | 调整终端大小 |

### 2.5 其他能力

- **文件系统操作**: `fs/readFile`, `fs/writeFile`, `fs/readDirectory` 等
- **配置管理**: `config/read`, `config/value/write`
- **模型管理**: `model/list`
- **Skills/插件**: `skills/list`, `plugin/install`, `plugin/uninstall`
- **MCP 集成**: `mcpServer/oauth/login`, `mcpServerStatus/list`
- **代码审查**: `review/start`

---

## 3. 局限性

### 3.1 不是消息总线

App-server 是**一对一的 Agent 控制接口**。它不能：
- 在多个 Agent 之间路由消息
- 广播给多个 subscriber
- 提供 pub/sub 语义
- 实现消息队列

### 3.2 不是编排器

一个 app-server 实例 = 一个 Codex agent 引擎。它不能：
- 生成子 Agent
- Fan-out 到多个模型
- 协调多 Agent 工作流
- 管理任务分发和聚合

### 3.3 不是多租户

没有用户隔离。多个 WebSocket 连接可以订阅同一个 thread，但没有权限分级。

### 3.4 审批流是同步阻塞的

Agent 需要命令/文件修改审批时，发送 server request 并**阻塞等待**客户端响应。客户端必须实现审批 UI。

### 3.5 实验性质

CLI 标记为 `[experimental]`——协议随版本变化。用 `codex app-server generate-ts` 生成匹配当前版本的类型定义。

---

## 4. 混合方案：CommHub + App-Server

### 4.1 定位区分

| 维度 | CommHub | Codex App-Server |
|------|---------|-----------------|
| **角色** | 队伍管理器 | 单兵控制器 |
| **管什么** | 30 个 Session 的状态、任务分发、结果收集 | 1 个 Codex 实例的 thread/turn/command |
| **协议** | MCP Streamable HTTP | JSON-RPC 2.0 (stdio/WebSocket) |
| **通信模式** | 多对多（通过中心 hub） | 一对一 |
| **消息队列** | 有（SQLite inbox） | 无 |
| **跨服务器** | 支持 | 不支持（单机进程） |
| **跨模型** | Claude + Codex + 任意 MCP | 仅 Codex |

### 4.2 混合架构

```
                    ┌─────────────────────────────────┐
                    │     CommHub Server               │
                    │     管队伍：状态 / 任务 / 结果    │
                    └──────────┬────────────────────────┘
                               │ MCP Streamable HTTP
          ┌────────┬───────┬───┴───┬───────┬────────┐
          │        │       │       │       │        │
       Claude   Claude  Claude  Codex   Codex   Claude
       Code #1  Code #2 Code #N  #1      #2     Code #M
                                  │       │
                            ┌─────┴─┐ ┌───┴───┐
                            │  app  │ │  app  │
                            │server │ │server │
                            │(WS)   │ │(WS)   │
                            └───────┘ └───────┘
                            控单兵：    控单兵：
                            thread     thread
                            turn       turn
                            command    command
```

**CommHub 管队伍**：
- Hub 通过 `send_task()` 派任务给 Codex session
- Codex session 通过 `report_status()` / `report_completion()` 回报
- CommHub 负责跨服务器路由、消息队列、状态追踪

**App-server 控单兵**（可选增强）：
- 对需要精细控制的 Codex 实例，启动 app-server 模式
- 通过 WebSocket 发送 `turn/start`，流式获取执行过程
- 实现审批流（自动 approve 或人工审批）
- 获取 item 级别的执行细节

### 4.3 什么时候需要 App-Server？

| 场景 | 用 CommHub MCP | 用 App-Server |
|------|---------------|---------------|
| 给 Codex 派一个任务，等结果 | 够用 | 不需要 |
| 需要看 Codex 实时执行过程 | 看不到 | 可以（item streaming） |
| 需要中途引导/打断 Codex | 不能 | 可以（turn/steer, turn/interrupt） |
| 需要管理 Codex 的对话历史 | 不能 | 可以（thread/list, thread/resume） |
| 需要自动审批命令执行 | N/A | 可以（实现 approval handler） |
| 管理 30 个 Agent 的全局状态 | 核心能力 | 不能 |

**结论：大多数场景 CommHub MCP 够用。App-server 留给需要精细控制单个 Codex 实例的高级场景。**

---

## 5. 最小代码示例

### 5.1 stdio 模式：发一个 prompt 并获取结果

```typescript
import { spawn } from "child_process";

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let id = 0;
function send(method: string, params: any = {}) {
  const msg = { method, id: id++, params };
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

function sendNotification(method: string, params: any = {}) {
  const msg = { method, params };
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

// 收集响应
let threadId: string | null = null;

proc.stdout!.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n").filter(Boolean)) {
    const msg = JSON.parse(line);

    // 握手响应
    if (msg.id === 0 && msg.result) {
      console.log("initialized:", msg.result.serverInfo?.name);
      sendNotification("initialized");

      // 开始一个 thread
      send("thread/start", {
        instructions: "你是一个代码审查助手",
        cwd: process.cwd(),
      });
    }

    // thread 创建响应
    if (msg.id === 1 && msg.result?.threadId) {
      threadId = msg.result.threadId;
      console.log("thread started:", threadId);

      // 发送一个 turn
      send("turn/start", {
        threadId,
        text: "审查当前目录的 package.json，给出 3 个改进建议",
      });
    }

    // 流式通知
    if (msg.method === "item/agentMessage/delta") {
      process.stdout.write(msg.params?.delta || "");
    }

    // turn 完成
    if (msg.method === "turn/completed") {
      console.log("\n--- turn completed ---");
      console.log("status:", msg.params?.status);
      proc.kill();
    }
  }
});

// 发起握手
send("initialize", {
  clientInfo: { name: "demo", title: "Demo Client", version: "1.0.0" },
  capabilities: { experimentalApi: true },
});
```

### 5.2 WebSocket 模式：连接远程 app-server

```typescript
const ws = new WebSocket("ws://localhost:9300");

ws.onopen = () => {
  // 握手
  ws.send(JSON.stringify({
    method: "initialize",
    id: 0,
    params: {
      clientInfo: { name: "remote-client", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    },
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.method === "item/agentMessage/delta") {
    process.stdout.write(msg.params?.delta || "");
  }

  if (msg.method === "turn/completed") {
    console.log("\nturn done:", msg.params?.status);
    ws.close();
  }
};
```

### 5.3 生成类型定义

```bash
# 生成 TypeScript 类型（匹配当前安装的 Codex 版本）
codex app-server generate-ts --out ./codex-schemas

# 生成 JSON Schema
codex app-server generate-json-schema --out ./codex-schemas
```

---

## 6. 参考链接

- Codex CLI GitHub: https://github.com/openai/codex
- App-server 源码: https://github.com/openai/codex/tree/main/codex-rs/app-server
- 官方文档: https://developers.openai.com/codex/app-server
- CLI 参考: https://developers.openai.com/codex/cli/reference
