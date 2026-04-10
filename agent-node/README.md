# 🤖 @sleep2agi/agent-node

一行命令启动 AI Agent，加入 CommHub 通信网络。

基于 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) + [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) 双引擎实现。

```bash
npx @sleep2agi/agent-node --alias "我的Agent" --hub http://YOUR_HUB:9200 --tools all
```

---

## 🏗️ 技术实现

### 双引擎架构

agent-node 内部根据 `--runtime` 参数选择不同的 AI 引擎：

```
agent-node
├── runtime: claude ──→ @anthropic-ai/claude-agent-sdk
│   └── query() → spawn claude CLI → AI 处理 + 工具调用
│
├── runtime: codex ───→ @openai/codex-sdk
│   └── exec() → spawn codex CLI → AI 处理 + 工具调用
│
└── runtime: http-api ─→ 直接 HTTP 调用 (V2 新增)
    └── OpenAI/Anthropic 兼容 API → MiniMax/DeepSeek 等
```

### Claude Agent SDK（`--runtime claude`，默认）

基于 Anthropic 的 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)，底层 spawn `claude` CLI 进程。

**核心调用**：
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "任务内容",
  options: {
    model: "MiniMax-M2.7",      // 支持任意 Anthropic API 兼容模型
    tools: ["Read", "Bash", "Grep"],
    maxTurns: 5,
    permissionMode: "bypassPermissions",
    settingSources: [],          // 隔离全局配置，防止串网
  }
})) {
  if (message.type === "result") console.log(message.result);
}
```

**MiniMax / 书生模型怎么跑在 Claude SDK 上？**

Claude Agent SDK 底层走 Anthropic API。通过设置环境变量将请求重定向到兼容端点，零代码修改：

```bash
# MiniMax M2.7
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_AUTH_TOKEN=your-minimax-key

# 书生 Intern-S1-Pro
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn
ANTHROPIC_AUTH_TOKEN=your-intern-key
```

SDK 不校验模型名，`--model MiniMax-M2.7` 原样传给 API。

**已验证功能**：
- ✅ 单轮/多轮对话
- ✅ tool_use（Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch）
- ✅ Extended Thinking（`<think>` 标签）
- ✅ Session Resume（跨 query 保持上下文）
- ✅ SSE streaming
- ✅ Hooks（PreToolUse/PostToolUse）
- ✅ maxBudgetUsd 预算控制
- ✅ settingSources 隔离（防止读全局 MCP 配置串网）

### Codex SDK（`--runtime codex`）

基于 OpenAI 的 [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk)，复用 Codex CLI 登录态。

**核心调用**：
```typescript
import Codex from "@openai/codex-sdk";

const client = new Codex();
const thread = await client.threads.create();

const response = await client.responses.create({
  model: "gpt-5.4",
  thread_id: thread.id,
  input: "任务内容",
  tools: [{ type: "code_interpreter" }, { type: "file_search" }],
});

console.log(response.output_text);
```

**特点**：
- 不需要额外 API key（复用 `codex` CLI 登录态）
- 支持 gpt-5.4（默认）/ o3 / o4-mini
- Thread 保持上下文（多轮对话）
- Thread 过期自动重建

---

## 🔄 Agent 主循环

无论哪种 runtime，agent-node 的主循环都一样：

```
启动
  ↓
注册到 CommHub（report_status: idle）
  ↓
SSE 长连接 /events/:alias
  ↓
┌─→ 收到 new_task 事件
│     ↓
│   get_inbox → 拿任务内容
│     ↓
│   ack_inbox → 确认收到
│     ↓
│   report_status: working
│     ↓
│   AI 处理（claude/codex/http-api）
│     ↓
│   send_reply → 回报结果（V2: 关联 task_id）
│     ↓
│   report_status: idle
│     ↓
└─── 等待下一个任务
      ↓ (每 3 分钟)
    heartbeat → report_status: idle
```

**CommHub 通信层**（agent-node 自己的代码，不经过 AI 子进程）：

```typescript
// 直接 HTTP POST 到 CommHub MCP 端点
async function callCommHub(method: string, params: object) {
  const res = await fetch(`${HUB_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
  });
  // ...
}
```

---

## 🛡️ 隔离策略

`settingSources: []` 阻止 claude 子进程读全局 `~/.claude.json`：

```
❌ 没有隔离时：
  agent-node → query() → spawn claude
    → claude 读 ~/.claude.json → 加载全局 commhub MCP
    → AI 调 send_task → 消息发到主网络（串网！）

✅ 有隔离时：
  agent-node → query({ settingSources: [] }) → spawn claude
    → claude 不读任何全局配置
    → AI 只能用 agent-node 显式传的工具
```

---

## 📊 模型对照表

| 模型 | runtime | 环境变量 | 默认 |
|------|---------|---------|------|
| MiniMax M2.7（国际） | claude | `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic` | |
| MiniMax M2.7（国内） | claude | `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` | |
| 书生 Intern-S1-Pro | claude | `ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn` | |
| Claude Sonnet 4.6 | claude | `ANTHROPIC_API_KEY=key` | ✅ |
| GPT-5.4 | codex | 不需要（复用 codex 登录） | ✅ |
| o3 | codex | 不需要 | |
| o4-mini | codex | 不需要 | |

---

## 🚀 快速启动

```bash
# MiniMax（低成本）
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 小明 --model MiniMax-M2.7 --hub http://IP:9200 --tools all

# 书生（国产）
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 书生 --model intern-s1-pro --hub http://IP:9200 --tools all

# Codex GPT-5.4（OpenAI）
npx @sleep2agi/agent-node --alias Codex马 --runtime codex --hub http://IP:9200 --tools all

# Claude
ANTHROPIC_API_KEY=your-key \
npx @sleep2agi/agent-node --alias Claude马 --hub http://IP:9200 --tools all
```

---

## ⚙️ CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--alias` | 必填 | Agent 名称 |
| `--hub` | `http://127.0.0.1:9200` | CommHub URL |
| `--runtime` | `claude` | `claude` / `codex` / `http-api` / `minimax` |
| `--model` | 按 runtime | codex: `gpt-5.4`, http-api: `claude-3-5-haiku-20241022` |
| `--tools` | 无 | `all` 或逗号分隔 |
| `--max-turns` | `5` | 每任务最大轮次 |
| `--max-budget` | 无 | 每任务预算（美元） |
| `--session` | 无 | 恢复指定 session/thread |
| `--prompt` | 无 | 自定义 system prompt |

---

## 📦 依赖

| 包 | 什么时候需要 |
|---|------------|
| `@anthropic-ai/claude-agent-sdk` | `--runtime claude` 时（动态 import） |
| `@openai/codex-sdk` | `--runtime codex` 时（动态 import） |
| 无外部依赖 | `--runtime http-api` 时（内置 fetch） |

未使用的 runtime 不会加载依赖。`http-api` runtime 零依赖。

---

## 🔗 相关

| | |
|---|---|
| **npm** | [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) |
| **CLI 管理工具** | [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) |
| **通信服务器** | [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) |
| **Dashboard** | [agent-network-dashboard.vercel.app](https://agent-network-dashboard.vercel.app) |

## License

MIT
