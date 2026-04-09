# @sleep2agi/agent-network

AI Agent 通信网络 — Server + Agent + CLI，一个包搞定。

支持 MiniMax / 书生 Intern-S1 / Claude 等任意 Anthropic API 兼容模型。

## 安装

```bash
npm install -g @sleep2agi/agent-network
```

## 一分钟上手

### 1. 启动 Server

```bash
anet server start --port 9200
```

### 2. 启动 Agent

**Claude Code（交互式）：**
```bash
anet init --hub http://YOUR_IP:9200
anet init project
anet start 指挥室
```

**MiniMax（低成本自动化）：**
```bash
anet init --hub http://YOUR_IP:9200
anet init profile 小明 --runtime agent-sdk --alias 小明 --model MiniMax-M2.7 --tools all \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=your-key"
anet start 小明
```

**书生 Intern-S1-Pro：**
```bash
anet init profile 书生 --runtime agent-sdk --alias 书生 --model intern-s1-pro --tools all \
  --env "ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn" \
  --env "ANTHROPIC_AUTH_TOKEN=your-key"
anet start 书生
```

### 3. 查看状态

```bash
anet ls
```

## CLI 命令

### Server

```bash
anet server start                    # 启动 CommHub Server（自动拉 @sleep2agi/commhub-server）
anet server start --port 9200        # 指定端口
anet server start --token my-secret  # 加认证
```

需要 Bun 运行时（`curl -fsSL https://bun.sh/install | bash`）。

### Agent 初始化

```bash
anet init                            # 配 hub URL（全局，一次性）
anet init project                    # 配项目（claude-code 用：channel 插件 + .mcp.json + CLAUDE.md）
anet init profile <id> [options]     # 创建启动 profile
```

### Agent 启动

```bash
anet start <id>                      # 新建 session
anet resume <id>                     # 恢复上次 session
anet start                           # 列出所有 node 配置
anet <id>                            # 快捷启动
```

profile 不存在时自动进入交互式创建。

`anet start` 根据 config 的 `runtime` 自动选择：
- `claude-code` → spawn claude CLI（自动配置 `.mcp.json`）
- `agent-sdk` → spawn @sleep2agi/agent-node

### 快速接入已有 session

已有 Claude Code session 想接入 anet？一条命令：

```bash
cd ~/your-project
anet resume 你的Agent --session <session-id>
# 自动创建 .anet/nodes/你的Agent/config.json + 配置 .mcp.json + resume
```

不需要先 `init profile`，直接 resume 即可。

### 状态查看

```bash
anet ls                              # profiles + sessions + 网络状态
```

## anet init profile 参数

**共用：**

| 参数 | 说明 |
|------|------|
| `--alias` | Agent 名称 |
| `--runtime` | `claude-code`（默认）或 `agent-sdk` |
| `--env` | 环境变量 K=V（可重复） |

**claude-code：**

| 参数 | 说明 |
|------|------|
| `--channel` | Channel（可重复，默认 server:commhub） |
| `--teammate-mode` | 默认 in-process |

**agent-sdk：**

| 参数 | 说明 |
|------|------|
| `--model` | 模型名 |
| `--tools` | `all` 或逗号分隔（Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch） |
| `--max-turns` | 每任务最大轮次 |
| `--max-budget` | 每任务预算（美元） |

## Node 配置

路径：`.anet/nodes/<id>/config.json`，anet 和 agent-node 共用。

```json
{
  "runtime": "agent-sdk",
  "alias": "小明",
  "hub": "http://YOUR_IP:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-key"
  }
}
```

配置优先级：`CLI 参数 > profile env > 系统环境变量 > ~/.anet/config.json > 默认值`

## 支持的模型

| 模型 | ANTHROPIC_BASE_URL | 已验证 |
|------|-------------------|--------|
| MiniMax M2.7（国际） | `https://api.minimaxi.com/anthropic` | ✅ 对话 + tool_use |
| MiniMax M2.7（国内） | `https://api.minimaxi.com/anthropic` | ✅ |
| 书生 Intern-S1-Pro | `https://chat.intern-ai.org.cn` | ✅ |
| Claude（默认） | 不设 | ✅ |
| 任意 Anthropic 兼容 | 对应端点 | — |

两个环境变量切模型，零代码修改。

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
| `hub.reply(taskId, text, status?)` | 回复任务 |
| `hub.status(state, extra?)` | 更新状态 |
| `hub.broadcast(content)` | 广播 |
| `hub.getAllStatus()` | 查看所有 session |
| `hub.disconnect()` | 断开 |

| 事件 | 说明 |
|------|------|
| `task` | 收到任务（已自动 ACK） |
| `connected` | SSE 连接成功 |
| `disconnected` | SSE 断开（自动重连） |

## 依赖

| 组件 | 什么时候需要 | 安装 |
|------|------------|------|
| @sleep2agi/agent-network | 所有人 | `npm i -g @sleep2agi/agent-network` |
| @anthropic-ai/claude-code | Claude Code Agent | `npm i -g @anthropic-ai/claude-code` |
| @sleep2agi/agent-node | agent-sdk Agent | `npm i -g @sleep2agi/agent-node` |
| @anthropic-ai/claude-agent-sdk | agent-sdk Agent（运行时依赖） | `npm i @anthropic-ai/claude-agent-sdk` |
| Bun | 启动 CommHub Server | `curl -fsSL https://bun.sh/install \| bash` |

## npm 包

| 包 | 说明 | 大小 |
|---|------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | anet CLI + CommHub SDK | ~15KB |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时 | ~5KB |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub Server | ~10KB |

## 文档

- [CLI 设计](docs/cli-design.md) — 命令 + Profile 规范
- [架构设计](docs/architecture.md) — 系统架构
- [操作手册](https://github.com/sleep2agi/agent-ops)（private） — 服务器/启动命令/Key

## License

MIT
