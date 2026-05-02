# @sleep2agi/agent-node

AI Agent 运行时 — 一行命令启动 Agent，自动入网 CommHub。

**v2.1.1 stable** — 推荐通过 `anet node create / anet node start` 使用，CLI 会帮你写好 `config.json` 和环境变量。

## 三种 Runtime

| Runtime | 底层 | 适合 |
|---------|------|------|
| `claude-agent-sdk` (默认) | [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Anthropic 兼容 API（最广，DeepSeek/GLM/Kimi/MiniMax/OpenRouter 等） |
| `codex-sdk` | [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk) | OpenAI GPT-5 / o3 / o4-mini |
| `claude-code-cli` | 本地 `claude` CLI | Claude Pro 订阅复用 |

未使用的 runtime 不会加载依赖。`claude-code-cli` 零额外 SDK。

## 快速启动（推荐）

```bash
npm install -g @sleep2agi/agent-network
anet hub start                # 起本地 hub
anet node create alice        # 两步交互式选 Runtime + Provider
anet node start alice         # 起 Agent
```

## 直接 npx 启动

```bash
npx @sleep2agi/agent-node --alias 小明 --hub http://127.0.0.1:9200 --tools all
```

## Provider 预设

`anet node create` 会让你二级选择 Provider，每个预设自动写好 `ANTHROPIC_BASE_URL` + 默认模型：

| Provider | Base URL | 默认模型 |
|---------|----------|---------|
| Anthropic | `https://api.anthropic.com` | claude-sonnet-4-5 |
| DeepSeek | `https://api.deepseek.com/anthropic` | deepseek-chat |
| GLM (智谱) | `https://open.bigmodel.cn/api/anthropic` | glm-4-plus |
| Kimi (月之暗面) | `https://api.moonshot.cn/anthropic` | moonshot-v1-32k |
| MiniMax (国际) | `https://api.minimax.io/anthropic` | MiniMax-M2.7 |
| MiniMax (国内) | `https://api.minimaxi.com/anthropic` | MiniMax-M2.7 |
| OpenRouter | `https://openrouter.ai/api/v1` | (任选) |
| 自定义 | 用户填 | 用户填 |

`claude-agent-sdk` 走 Anthropic Messages API；只要服务端兼容这套协议，所有上面的 Provider 都不需要改一行代码 — `--model` 原样透传。

## 示例：手动 npx + 环境变量

```bash
# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=sk-... \
npx @sleep2agi/agent-node --alias deep --hub http://127.0.0.1:9200 --tools all

# MiniMax
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias mini --model MiniMax-M2.7 --hub http://127.0.0.1:9200 --tools all

# Codex GPT-5
npx @sleep2agi/agent-node --alias codex --runtime codex-sdk --hub http://127.0.0.1:9200 --tools all
```

## 配置文件示例

`anet node create` 写出的典型 `config.json`（位置 `.anet/nodes/<name>/config.json`）：

```json
{
  "alias": "alice",
  "hub": "http://127.0.0.1:9200",
  "runtime": "claude-agent-sdk",
  "model": "MiniMax-M2.7",
  "anthropic_base_url": "https://api.minimax.io/anthropic",
  "anthropic_auth_token": "sk-...",
  "tools": "all",
  "maxTurns": 50,
  "dangerouslySkipPermissions": true,
  "teammateMode": true
}
```

字段级覆盖：项目 config 字段优先于全局 `~/.anet/config.json`，缺失字段 fallback 到全局。

## CLI 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--alias` | 必填 | Agent 名称 |
| `--hub` | `http://127.0.0.1:9200` | CommHub URL |
| `--runtime` | `claude-agent-sdk` | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
| `--model` | 按 runtime | 透传给 SDK |
| `--tools` | 无 | `all` 或逗号分隔 |
| `--max-turns` | `50` | 每任务最大轮次 |
| `--session` | 无 | 恢复指定 session/thread |

## 主循环

无论哪个 runtime：

```
启动 → report_status: idle
        ↓
  SSE 长连接 /events/:alias
        ↓
  收到 new_task → get_inbox → ack_inbox
        ↓
  report_status: working
        ↓
  AI 处理（带 commhub MCP 工具，可与其他 Agent 协作）
        ↓
  send_reply → report_status: idle
```

## 协作能力

启动后 Agent 自动注入 commhub MCP 工具，可以：

- `commhub_get_all_status()` — 看谁在线
- `commhub_send_task(alias, task)` — 给别的 Agent 派活
- `commhub_get_task(task_id)` — 轮询对方进度
- `commhub_send_message(alias, message)` — 单纯发消息（不创建任务）
- `commhub_report_status(status, task)` — 自报进度

这套机制支撑 Dashboard 实时看到 agent 间通信。

## 隔离

`claude-code-cli` runtime 启动子进程时传 `settingSources: []`，阻止 claude 子进程读全局 `~/.claude.json` 串网。

## 相关包

| | |
|---|---|
| npm | [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) (2.1.1) |
| CLI | [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) (2.0.0) |
| Hub | [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) (0.5.0) |
| Dashboard | [@sleep2agi/agent-network-dashboard](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) (0.1.0) |

## License

MIT
