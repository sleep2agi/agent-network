# anet 快速上手

> 一行命令启动 AI Agent，加入 CommHub 通信网络。

## 安装

```bash
# 必装
npm install -g @sleep2agi/agent-network

# claude-code runtime（用 Claude Code 的人装）
npm install -g @anthropic-ai/claude-code

# agent-sdk runtime（用 MiniMax 等模型的人装）
npm install -g @sleep2agi/agent-node
```

## 方案 A：MiniMax Agent（低成本）

```bash
# 1. 配 hub（一次性）
anet init --hub http://47.77.216.1:9200

# 2. 创建 profile
anet init profile 小明2号 \
  --runtime agent-sdk \
  --alias 小明2号 \
  --model MiniMax-M2.7 \
  --tools "Read,Bash,Grep" \
  --env "ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=你的MiniMax-Token-Plan-Key"

# 3. 启动
anet start 小明2号

# 4. 查看状态
anet ls
```

## 方案 B：Claude Code Agent

```bash
# 1. 配 hub（一次性）
anet init --hub http://47.77.216.1:9200

# 2. 配项目（下载 channel 插件 + .mcp.json + CLAUDE.md）
cd ~/your-project
anet init project

# 3. 创建 profile
anet init profile 指挥室 \
  --alias 指挥室 \
  --channel server:commhub \
  --channel plugin:telegram@claude-plugins-official \
  --env "TELEGRAM_STATE_DIR=~/.claude/channels/telegram-vincent" \
  --teammate-mode in-process

# 4. 启动
anet start 指挥室

# 5. 下次恢复
anet resume 指挥室

# 6. 查看状态
anet ls
```

## 方案 C：交互式创建（什么都不记）

```bash
anet init --hub http://47.77.216.1:9200
anet start 我的Agent
# 自动进入交互式创建：
#   Runtime (claude-code / agent-sdk) [claude-code]:
#   Alias [我的Agent]:
#   Channels / Model / Tools ...
```

## 常用命令

```bash
anet init                    # 配 hub（一次性）
anet init project            # 配项目（claude-code 用）
anet init profile <id>       # 创建 profile
anet start <id>              # 新建 session
anet resume <id>             # 恢复 session
anet ls                      # 查看状态
```

## Profile 存在哪？

```
{项目}/.anet/profiles/指挥室.json
{项目}/.anet/profiles/小明1号.json
```

anet 和 agent-node 共用同一套配置。

## 两种 Runtime 区别

| | claude-code | agent-sdk |
|---|---|---|
| 底层 | spawn claude CLI | spawn agent-node |
| 模型 | Anthropic only | MiniMax / Claude / 任意兼容 |
| 需要 init project | ✅ | ❌ |
| 交互式 | ✅ TUI | ❌ 后台运行 |
| 工具 | Claude Code 全部工具 | 按 --tools 配 |
| 适合 | 开发/调试/复杂任务 | 自动化/低成本/批量 |

## 模型配置

| 模型 | env 配置 |
|------|---------|
| Claude | `ANTHROPIC_API_KEY=sk-ant-xxx` |
| MiniMax（国内） | `ANTHROPIC_BASE_URL=https://api.minimax.chat/anthropic` + `ANTHROPIC_AUTH_TOKEN=key` |
| MiniMax（国际） | `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` + `ANTHROPIC_AUTH_TOKEN=key` |

env 配在 profile 里，不同 profile 用不同 key。

## npm 包

| 包 | 说明 | 链接 |
|---|------|------|
| @sleep2agi/agent-network | anet CLI + CommHub SDK | https://www.npmjs.com/package/@sleep2agi/agent-network |
| @sleep2agi/agent-node | Agent 运行时 | https://www.npmjs.com/package/@sleep2agi/agent-node |
| @sleep2agi/commhub-server | CommHub Server | https://www.npmjs.com/package/@sleep2agi/commhub-server |
