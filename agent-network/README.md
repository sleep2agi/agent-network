# @sleep2agi/agent-network

AI Agent 通信网络 — CLI + SDK + Channel 插件，一个包搞定。

```
npm install -g @sleep2agi/agent-network
```

当前版本：v0.0.48 | [agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) v0.7.0 | [commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) v0.4.3

## 快速开始

```bash
# 1. 启动通信服务器（首次自动生成 auth token）
anet server start --port 9200

# 2. 配置（交互式，填 hub URL 和 token）
anet init

# 3. 启动 Claude Code Agent
cd ~/your-project
anet init project
anet start 指挥室

# 4. 快速接入已有 session（无需 init profile）
anet resume 你的Agent --session <session-id>

# 5. 查看状态
anet ls
anet session ls    # 列出当前项目的 Claude Code session
anet -v            # 查看版本
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `anet init` | 配 hub URL + token（全局，交互式） |
| `anet init project` | 配当前项目（channel 插件 + .mcp.json + CLAUDE.md） |
| `anet init profile <id>` | 创建 node 启动配置 |
| `anet start <id>` | 新建 session |
| `anet resume <id>` | 恢复 session |
| `anet resume <id> --session <sid>` | 快速接入已有 session（自动创建配置） |
| `anet session ls` | 列出当前项目的 session（ID / 大小 / 时间） |
| `anet ls` | nodes + sessions + 网络状态 |
| `anet server start` | 启动 CommHub Server |
| `anet server config` | 查看/设置 server 配置 |
| `anet import` | 从 CommHub 导入在线 session |
| `anet -v` | 查看版本 |

## 配置体系

### 全局配置

```
~/.anet/config.json          # hub URL + token（anet init 写入）
~/.anet/server/config.json   # server 配置（port/host/token）
```

### 项目配置

```
{project}/
├── .mcp.json                # commhub MCP server
└── .anet/
    ├── node-server.ts       # channel 插件（自动从 npm 包同步）
    ├── package.json
    └── nodes/
        └── 指挥室/
            └── config.json  # 启动配置
```

### 配置继承规则

两个 config.json 都会读，**字段级合并**：

```
项目 .anet/nodes/<id>/config.json   有值的字段优先
        ↓ fallback
全局 ~/.anet/config.json             缺失字段兜底
```

项目 config 不需要写 token/hub，全局配一份所有项目共用。

### Node 配置示例

路径：`.anet/nodes/<id>/config.json`

**Claude Code：**
```json
{
  "runtime": "claude-code",
  "alias": "指挥室",
  "hub": "http://YOUR_IP:9200",
  "channels": ["server:commhub"],
  "env": {},
  "flags": { "dangerouslySkipPermissions": true, "teammateMode": "in-process" },
  "resume": "98039093-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

**MiniMax（agent-sdk）：**
```json
{
  "runtime": "agent-sdk",
  "alias": "小明",
  "hub": "http://YOUR_IP:9200",
  "model": "MiniMax-M2.7",
  "tools": ["Read", "Bash", "Grep"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your-key"
  }
}
```

## Token 认证

```bash
# 方式 1：anet init 交互式填写
anet init

# 方式 2：命令行参数
anet init --hub http://YOUR_IP:9200 --token your-secret

# 方式 3：server 首次启动自动生成
anet server start
# → Generated auth token: xxxx（自动存到全局 + server config）
```

Token 流转：

```
~/.anet/config.json (token)
    ↓ 自动传递
├→ anet start/resume → COMMHUB_TOKEN env → channel 插件
├→ anet ls/import → Authorization header → CommHub API
└→ channel 插件启动时也会直接读 ~/.anet/config.json
```

node config 可以单独配 token（覆盖全局），适用于连不同 CommHub 的场景。

## 自动配置行为

`anet start`/`anet resume` 对 `runtime: "claude-code"` 自动确保：

1. `.anet/node-server.ts` 从 npm 包同步（对比内容，不同才更新）
2. `.anet/package.json` + 依赖安装
3. `.mcp.json` 包含 commhub（**已有配置不覆盖**）

## 支持的模型

| 模型 | ANTHROPIC_BASE_URL | runtime |
|------|-------------------|---------|
| Claude | 不设 | claude-code |
| MiniMax M2.7 | `https://api.minimaxi.com/anthropic` | agent-sdk |
| 书生 Intern-S1-Pro | `https://chat.intern-ai.org.cn` | agent-sdk |
| 任意 Anthropic 兼容 | 对应端点 | agent-sdk |

## SDK

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

## npm 包

| 包 | 说明 | 版本 |
|---|------|------|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | anet CLI + CommHub SDK + Channel 插件 | v0.0.48 |
| [@sleep2agi/agent-node](https://www.npmjs.com/package/@sleep2agi/agent-node) | Agent 运行时（MiniMax/书生/Claude） | v0.7.0 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | CommHub 通信服务器 | v0.4.3 |

## 文档

- [快速上手](docs/anet-quickstart.md)
- [CLI 设计](docs/cli-design.md) — 命令 + 配置规范
- [架构设计](docs/architecture.md)
- [踩坑经验](docs/pitfalls.md) — Channel 插件开发注意事项

## License

MIT
