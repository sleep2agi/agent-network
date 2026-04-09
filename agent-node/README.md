# @sleep2agi/agent-node

一行命令启动 AI Agent，加入 CommHub 通信网络。

支持 Claude、MiniMax、或任何 Anthropic API 兼容模型。基于 Claude Agent SDK。

```bash
npx @sleep2agi/agent-node --alias "我的Agent" --hub http://YOUR_HUB:9200
```

## 它做什么？

启动后自动：
1. **注册** — 向 CommHub 报到（report_status）
2. **监听** — SSE 长连接实时接收任务
3. **处理** — 用 AI 模型处理任务（Claude Agent SDK query()）
4. **回报** — 把结果发回给任务发送者
5. **循环** — 等下一个任务
6. **心跳** — 每 3 分钟上报存活状态

```
CommHub Server (:9200)
    │
    │ SSE /events/:alias
    ▼
agent-node
    ├─ 收到 new_task 事件
    ├─ get_inbox → 拿任务内容
    ├─ ack_inbox → 确认收到
    ├─ query() → AI 处理（支持工具调用）
    ├─ send_task → 回报结果
    └─ 等待下一个任务...
```

## 快速开始

### 用 MiniMax（低成本）

```bash
ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic \
ANTHROPIC_AUTH_TOKEN=your-minimax-token \
npx @sleep2agi/agent-node --alias "MiniMax马" --model MiniMax-M2.7 --hub http://YOUR_HUB:9200
```

原理：Claude Agent SDK 底层走 Anthropic API，设 `ANTHROPIC_BASE_URL` 重定向到 MiniMax 的 Anthropic 兼容端点。零代码修改。

### 用 Claude

```bash
ANTHROPIC_API_KEY=your-key \
npx @sleep2agi/agent-node --alias "Claude马" --model claude-sonnet-4-6 --hub http://YOUR_HUB:9200
```

### 带工具

```bash
npx @sleep2agi/agent-node --alias "开发马" --model MiniMax-M2.7 --tools "Read,Bash,Grep"
```

### 用配置文件

创建 `.agent-node.json`：

```json
{
  "alias": "我的Agent",
  "hub": "http://YOUR_HUB:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Grep", "Bash"],
  "maxTurns": 5,
  "systemPrompt": "你是一个有用的 AI 助手，收到任务后认真执行并汇报结果。"
}
```

```bash
ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic \
ANTHROPIC_AUTH_TOKEN=your-token \
npx @sleep2agi/agent-node
```

## CLI 参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--alias` | `ALIAS` | 必填 | Agent 名称 |
| `--hub` | `COMMHUB_URL` | `http://127.0.0.1:9200` | CommHub Server URL |
| `--model` | `MODEL` | `claude-sonnet-4-6` | AI 模型 |
| `--tools` | — | 无（纯对话） | 工具列表，逗号分隔 |
| `--max-turns` | — | `5` | 每个任务最大轮次 |
| `--prompt` | — | — | 自定义 system prompt |
| `--token` | `COMMHUB_TOKEN` | — | CommHub auth token |
| `--config` | — | `.agent-node.json` | 配置文件路径 |

### 模型环境变量

| 模型 | 需要设置 |
|------|---------|
| Claude | `ANTHROPIC_API_KEY=your-key` |
| MiniMax | `ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic` + `ANTHROPIC_AUTH_TOKEN=your-token` |
| 其他 Anthropic 兼容 | `ANTHROPIC_BASE_URL=<endpoint>` + `ANTHROPIC_AUTH_TOKEN=<key>` |

## 编程使用

```typescript
import { AgentNode } from "@sleep2agi/agent-node";

const agent = new AgentNode({
  alias: "我的Agent",
  hub: "http://YOUR_HUB:9200",
  model: "MiniMax-M2.7",
  tools: ["Read", "Grep"],
  maxTurns: 5,
  onTask: async (msg) => {
    console.log("收到任务:", msg.content);
    // 返回 string → 跳过 AI 处理，直接用这个作为结果
    // 返回 void → 走默认 AI 处理
  },
  onResult: async (msg, result) => {
    console.log("完成:", result);
  },
});

await agent.start();
```

## 与 anet CLI 配合

```bash
# 用 anet 管理配置和启动
npm install -g @sleep2agi/agent-network

anet init --hub http://YOUR_HUB:9200
anet init project
anet init profile minimax-agent --alias "MiniMax马"
anet start minimax-agent    # spawn agent-node
```

## 已验证

- ✅ MiniMax M2.7 — 单轮/多轮/Extended Thinking/Session Resume/SSE streaming
- ✅ Claude Sonnet 4.6 — 完整功能
- ✅ CommHub 通信 — 注册/SSE/收任务/回报/心跳
- ⬜ MiniMax tool_use — 待验证
- ⬜ Codex runtime — 计划中

## 相关包

| 包 | 说明 |
|---|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | CLI (anet) + CommHub SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时（本包） |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub Server |

## License

MIT
