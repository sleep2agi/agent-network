# @sleep2agi/agent-network

AI Agent 通信网络 — 让 AI Agent 互相发消息、派任务、协作。

支持两种 Agent 运行时：
- **claude-code** — Claude Code CLI（交互式开发）
- **agent-sdk** — Claude Agent SDK + 任意模型（MiniMax/Claude，自动化）

## 安装

```bash
# 必装：anet CLI + CommHub SDK
npm install -g @sleep2agi/agent-network

# 按需装：
npm install -g @anthropic-ai/claude-code      # claude-code runtime
npm install -g @sleep2agi/agent-node           # agent-sdk runtime
```

## 快速开始

### Claude Code Agent

```bash
anet init --hub http://YOUR_IP:9200
anet init project
anet init profile 指挥室 --alias 指挥室 --channel server:commhub
anet start 指挥室
```

### MiniMax Agent（低成本）

```bash
anet init --hub http://YOUR_IP:9200
anet init profile 小明1号 \
  --runtime agent-sdk \
  --alias 小明1号 \
  --model MiniMax-M2.7 \
  --tools "Read,Bash,Grep" \
  --env "ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=your-minimax-key"
anet start 小明1号
```

## 工作原理

`anet start` 读 profile，根据 `runtime` 自动选择启动方式：

```
anet start 指挥室  → runtime: claude-code → spawn claude CLI
anet start 小明1号 → runtime: agent-sdk  → spawn agent-node (MiniMax)
```

同一目录可以有多个 profile，不同 runtime 共存。

## CLI 命令

```
anet init                    配 hub URL（全局，一次性）
anet init project            配项目（claude-code 用：channel 插件 + .mcp.json + CLAUDE.md）
anet init profile <id>       创建启动配置
anet start <id>              新建 session
anet resume <id>             恢复上次 session
anet ls                      查看 profiles + sessions + 网络状态
```

### anet init profile

```bash
anet init profile <id> [options]
```

**共用参数：**

| 参数 | 说明 |
|------|------|
| `--alias` | CommHub session 别名 |
| `--runtime` | `claude-code`（默认）或 `agent-sdk` |
| `--env` | 环境变量 K=V（可重复） |

**claude-code 参数：**

| 参数 | 说明 |
|------|------|
| `--channel` | Channel（可重复，默认 server:commhub） |
| `--teammate-mode` | 默认 in-process |
| `--resume-alias` | 恢复搜索名 |

**agent-sdk 参数：**

| 参数 | 说明 |
|------|------|
| `--model` | 模型名（如 MiniMax-M2.7） |
| `--tools` | 工具列表，逗号分隔 |
| `--max-turns` | 每任务最大轮次 |

### anet start / resume

```bash
anet start 指挥室       # 新建 session
anet resume 指挥室      # 恢复上次 session
anet start              # 列出所有 profile
anet 指挥室             # 快捷方式
```

交互式创建：profile 不存在时自动引导创建（选 runtime、填 alias、model 等）。

### anet init project

仅 claude-code runtime 需要：

```bash
anet init project
# ✅ .anet/node-server.ts（Channel 插件）
# ✅ Dependencies installed
# ✅ .mcp.json
# ✅ CLAUDE.md
```

agent-sdk runtime 不需要 init project。

### anet ls

```
Profiles:
  指挥室  →  指挥室  [server:commhub, plugin:telegram]
  小明1号  →  小明1号  []

Sessions (/home/vansin/project):
  SESSION              PID     NETWORK
  ──────────────────── ─────── ─────────────────────
  fef0eb55-b39c-4abc  64269   通信龙 offline ●
```

## Profile 格式

路径：`.anet/profiles/<id>.json`

anet 和 agent-node 共用同一套配置。

### claude-code 示例

```json
{
  "runtime": "claude-code",
  "alias": "指挥室",
  "hub": "http://YOUR_IP:9200",
  "channels": ["server:commhub", "plugin:telegram@claude-plugins-official"],
  "env": { "TELEGRAM_STATE_DIR": "~/.claude/channels/telegram-vincent" },
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": "in-process" }
}
```

### agent-sdk 示例（MiniMax）

```json
{
  "runtime": "agent-sdk",
  "alias": "小明1号",
  "hub": "http://YOUR_IP:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Bash", "Grep"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimax.chat/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-key"
  }
}
```

### 配置优先级

```
CLI 参数 > profile env > 系统环境变量 > ~/.anet/config.json > 默认值
```

## SDK 代码引用

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '完成！');
});
```

| 方法 | 说明 |
|------|------|
| `hub.send(alias, content)` | 发任务 |
| `hub.message(alias, content)` | 发消息 |
| `hub.status(state, extra?)` | 更新状态 |
| `hub.disconnect()` | 断开 |

## 依赖

| 包 | 什么时候装 |
|---|---------|
| @sleep2agi/agent-network | 必装（anet CLI） |
| @anthropic-ai/claude-code | runtime: claude-code |
| @sleep2agi/agent-node | runtime: agent-sdk |
| Bun 1.2+ | 部署 CommHub Server |

## 相关包

| 包 | 说明 |
|---|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | anet CLI + CommHub SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub Server |

## License

MIT
