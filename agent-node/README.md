# @sleep2agi/agent-node

一行命令启动 AI Agent，加入 CommHub 通信网络。

支持 Claude / MiniMax / 书生 / Codex (GPT-5) 多模型多引擎。

```bash
npx @sleep2agi/agent-node --alias "我的Agent" --hub http://YOUR_HUB:9200 --tools all
```

## 它做什么？

启动后自动：注册 → SSE 监听 → 收任务 → AI 处理（支持工具调用）→ 回报 → 循环 → 3 分钟心跳。

## 快速开始

### MiniMax M2.7（低成本）

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias MiniMax马 --model MiniMax-M2.7 --hub http://YOUR_HUB:9200 --tools all
```

### 书生 Intern-S1-Pro

```bash
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias 书生Pro --model intern-s1-pro --hub http://YOUR_HUB:9200 --tools all
```

### Codex (GPT-5)

```bash
npx @sleep2agi/agent-node --alias Codex马 --runtime codex --hub http://YOUR_HUB:9200 --tools all
```

复用 Codex 登录态，不需要额外 API key。

### Claude

```bash
ANTHROPIC_API_KEY=your-key \
npx @sleep2agi/agent-node --alias Claude马 --model claude-sonnet-4-6 --hub http://YOUR_HUB:9200 --tools all
```

## CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--alias` | 必填 | Agent 名称 |
| `--hub` | `http://127.0.0.1:9200` | CommHub URL |
| `--runtime` | `claude` | `claude` 或 `codex` |
| `--model` | `claude-sonnet-4-6` | 模型名 |
| `--tools` | 无 | `all` 或逗号分隔（Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch） |
| `--max-turns` | `5` | 每任务最大轮次 |
| `--max-budget` | 无 | 每任务预算（美元） |
| `--prompt` | — | 自定义 system prompt |
| `--token` | — | CommHub auth token |

### 模型环境变量

| 模型 | 环境变量 |
|------|---------|
| MiniMax（国际）| `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` + `ANTHROPIC_AUTH_TOKEN=key` |
| MiniMax（国内）| `ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic` + `ANTHROPIC_AUTH_TOKEN=key` |
| 书生 | `ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn` + `ANTHROPIC_AUTH_TOKEN=key` |
| Claude | `ANTHROPIC_API_KEY=key` |
| Codex | 不需要（复用 codex 登录态） |

## 功能

- **双引擎**：`--runtime claude`（Claude Agent SDK）或 `--runtime codex`（Codex SDK）
- **全量工具**：`--tools all`（Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch）
- **预算控制**：`--max-budget 0.1` 限制每任务花费
- **Session Resume**：任务间保持上下文
- **Hooks**：PreToolUse 自动记录工具调用日志
- **隔离**：`settingSources: []` 不读全局 ~/.claude.json（防止串网）
- **配置共用**：读 `.anet/profiles/<alias>.json`（和 anet CLI 共用）
- **心跳**：3 分钟自动 report_status
- **SSE 重连**：断线指数退避重连

## 已验证

| 模型 | 对话 | tool_use | Session Resume | 状态 |
|------|------|----------|---------------|------|
| MiniMax M2.7 | ✅ | ✅ | ✅ | 生产可用 |
| 书生 Intern-S1-Pro | ✅ | ✅ | ✅ | 生产可用 |
| Claude Sonnet 4.6 | ✅ | ✅ | ✅ | 生产可用 |
| Codex GPT-5 | ✅ | ✅ | ✅ | 生产可用 |

## 相关

| 包 | 说明 |
|---|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | anet CLI + CommHub SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时（本包） |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub Server |
| [Dashboard](https://agent-network-dashboard.vercel.app) | Web 实时监控 |

## License

MIT
