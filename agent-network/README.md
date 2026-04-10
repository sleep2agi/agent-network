# @sleep2agi/agent-network

AI Agent 通信网络 — CLI + SDK + Channel，一个包搞定。

```bash
npm install -g @sleep2agi/agent-network
anet setup
```

## 快速开始

```bash
# 1. 安装 + 交互式选装依赖
npm install -g @sleep2agi/agent-network
anet setup

# 2. 配置 CommHub
anet init --hub http://YOUR_IP:9200

# 3. 创建 node（交互式）
anet create

# 4. 启动
anet start 指挥室
```

## 版本

```bash
anet -v
```
```
anet v1.3.1
agent-node v1.1.0 (global)
  └ @anthropic-ai/claude-agent-sdk v0.2.98
  └ @openai/codex-sdk v0.118.0
commhub-server not installed
claude CLI v2.1.98
codex CLI v0.118.0
```

## Runtime

| 名称 | 底层 | 说明 |
|------|------|------|
| `claude-code-cli` | Claude Code CLI | 需要 Pro 订阅 + claude auth login |
| `codex-sdk` | Codex SDK + CLI | 需要 codex auth login |
| `claude-agent-sdk` | Claude Agent SDK | 支持 MiniMax / 书生 / Claude |

## CLI 命令

```bash
# 全局
anet init                              # 配 hub URL + token
anet setup                             # 交互式安装依赖
anet upgrade                           # 一键升级所有包
anet server start                      # 启动 CommHub Server
anet -v                                # 版本诊断

# 项目
anet create <node-name>                # 创建 node（交互式）
anet start <node-name>                 # 启动（自动 resume）
anet start <node-name> --new-session   # 强制新建
anet resume <node-name> --session <id> # 导入已有 session
anet channel add telegram <node-name>  # 加 Telegram channel
anet channel ls [node-name]            # 查看 channel
anet ls                                # 查看所有 node
anet session ls                        # 查看 session
```

## 配置

```
~/.anet/config.json                    # 全局 hub + token
{workpath}/.anet/nodes/<name>/
├── config.json                        # node 配置
└── channels/telegram/                 # Telegram channel
    ├── .env                           # bot token
    ├── access.json                    # 白名单
    └── inbox/                         # 图片/文件
```

## SDK

```typescript
import { CommHub } from '@sleep2agi/agent-network';

const hub = new CommHub({ url: 'http://YOUR_IP:9200', alias: '我的Agent' });
hub.on('task', async (msg) => {
  await hub.send(msg.from_session, '完成！');
});
```

## npm 包

| 包 | 版本 | 说明 |
|---|------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | v1.3.1 | anet CLI + CommHub SDK |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | v1.1.0 | Agent 运行时 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | v0.4.3 | CommHub Server |

## 文档

- [CLI 重构方案](docs/cli-refactor-proposal.md)
- [依赖管理方案](docs/dependency-management.md)
- [测试计划](docs/test-plan.md)
- [踩坑经验](docs/pitfalls.md)
- [架构设计](docs/architecture.md)
- [CommHub Review](docs/commhub-review.md)
- [重启策略](docs/restart-strategy.md)

## License

MIT
