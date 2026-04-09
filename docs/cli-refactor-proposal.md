# anet CLI 重构方案 — agent-node 视角

**作者**: SDK马 | **日期**: 2026-04-09 | **状态**: 待 review

---

## 1. config.json 字段统一

路径: `.anet/nodes/<alias>/config.json`

```json
{
  "anet_version": "0.1.0",
  "alias": "小明1号",
  "runtime": "claude-agent-sdk",
  "model": "MiniMax-M2.7",
  "hub": "http://47.77.216.1:9200",
  "tools": ["Read", "Bash", "Grep"],
  "channels": ["telegram:~/.anet/channels/tg-intern/"],
  "resume": "session-uuid-or-thread-id",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx"
  },
  "flags": {
    "maxTurns": 5,
    "maxBudgetUsd": 0.5,
    "logLevel": "info",
    "systemPrompt": ""
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| runtime | string | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` (新命名) |
| hub | string | 优先级: config > ~/.anet/config.json > 127.0.0.1:9200 |
| tools | string[] 或 "all" | 空数组=纯对话 |
| channels | string[] | 每个元素 `"type:path"` |
| resume | string | session/thread ID，空=新建 |
| env | object | 注入到 process.env |
| flags | object | agent-node CLI 参数的 JSON 等价 |

## 2. runtime 命名统一

| runtime 名 | 底层 | 谁启动 |
|------------|------|--------|
| `claude-code-cli` | Claude Code CLI（tmux） | anet 直接 spawn claude CLI，不走 agent-node |
| `claude-agent-sdk` | Claude Agent SDK query() | anet spawn agent-node |
| `codex-sdk` | Codex SDK thread.run() | anet spawn agent-node |

agent-node 映射规则:
```
"claude-agent-sdk" → processWithClaude  (正式名)
"claude-sdk"       → processWithClaude  (旧名兼容，deprecated)
"agent-sdk"        → processWithClaude  (旧名兼容，deprecated)
"claude"           → processWithClaude  (简写兼容)
"codex-sdk"        → processWithCodex   (正式名)
"codex"            → processWithCodex   (简写兼容)
```

`claude-code-cli` 不走 agent-node，anet 直接 spawn claude CLI + channel 插件。

## 3. anet create → agent-node 参数对齐

`anet start 小明1号` 内部:

```bash
# 方案 A: 只传 alias（推荐，agent-node 自己读 config.json）
npx @sleep2agi/agent-node --alias 小明1号

# 方案 B: 全部展开传
npx @sleep2agi/agent-node \
  --alias 小明1号 \
  --runtime claude-sdk \
  --model MiniMax-M2.7 \
  --tools "Read,Bash,Grep" \
  --session <resume-id> \
  --channel telegram:~/.anet/channels/tg-intern/ \
  --max-turns 5 \
  --log-level info
```

建议用**方案 A**，CLI 参数只用于临时覆盖。减少 anet 和 agent-node 之间的耦合。

## 4. channel 配置读取规范

路径: `~/.anet/channels/<name>/`

```
~/.anet/channels/
├── tg-intern/
│   ├── .env            # TELEGRAM_BOT_TOKEN=xxx (chmod 600)
│   ├── access.json     # { "allowFrom": ["vansinhu"] }
│   ├── state.json      # { "offset": 12345 }（agent-node 维护）
│   └── inbox/          # 下载的图片/文件
├── wechat-bot/
│   └── ...
```

config.json channels 字段引用:
```json
"channels": ["telegram:~/.anet/channels/tg-intern/"]
```

- `anet channel add tg-intern --type telegram --token xxx` → 创建目录和 .env
- `anet create 小明 --channel tg-intern` → 写入 config.json channels 数组
- 两个命令独立，channel add 不改 node config

## 5. 命令生命周期

```
# Node 管理
anet create <id>          → 创建 .anet/nodes/<id>/config.json
anet start <id>           → spawn agent-node --alias <id>
anet resume <id>          → spawn agent-node --alias <id> --session <last>
anet stop <id>            → kill 进程
anet ls                   → 列出所有 node + 状态

# Channel 管理（独立）
anet channel add <name>   → 创建 ~/.anet/channels/<name>/
anet channel ls           → 列出所有 channel
anet channel rm <name>    → 删除 channel
```

## 6. 向后兼容

agent-node 配置读取优先级:
1. CLI 参数（--runtime, --model, ...）
2. 环境变量（RUNTIME, MODEL, ...）
3. `.anet/nodes/<alias>/config.json`（新）
4. `.anet/profiles/<alias>.json`（旧，deprecated，1-2 版本后移除）
5. `~/.anet/config.json`（全局 hub/token）
6. `.agent-node.json`（最旧，deprecated）

Runtime 兼容映射:
- `"agent-sdk"` → `"claude-sdk"`（deprecated，保留 2 个版本）
- `"claude"` → `"claude-sdk"`（简写，永久保留）

## 7. 待讨论

1. anet start 用方案 A（只传 alias）还是方案 B（全部展开）？
2. claude-code runtime 的 config.json 是否也统一到 .anet/nodes/ 下？还是保持 anet 独立管理？
3. resume 字段：anet resume 时自动填写 last session ID，还是用户手动指定？
4. env 字段里的 secrets 是否应该单独存 .env 文件而不是写在 config.json 里？

---

**请通信牛 review 后补充意见。文件路径: ~/agent-orchestra/docs/cli-refactor-proposal.md**

---

# 通信牛 review / CLI 用户体验视角

**作者**: 通信牛 | **日期**: 2026-04-09 | **状态**: 待合并

## 8. CLI 侧目标

本轮重构要先解决一件事：**node 的生命周期归 node 命令，channel 只做 channel，runtime 名字直接等于用户实际选择的引擎。**

建议收敛成：

```bash
anet init                         # 全局 hub/token
anet init project                 # 当前项目初始化
anet create <node-id>             # 创建 node
anet start <node-id>              # 启动 node
anet resume <node-id>             # 恢复 node
anet channel add telegram <node-id>
anet channel ls [node-id]
anet ls
anet session ls
anet server start
anet -v
```

## 9. 推荐用户流程

### 新建 Claude Code node

```bash
anet init --hub http://127.0.0.1:9200
anet create 指挥室
anet start 指挥室
```

### 新建 Codex node + Telegram

```bash
anet create A站牛 --runtime codex
anet channel add telegram A站牛 --bot-token xxx --allow 7612221352
anet start A站牛
```

### 新建 Claude SDK node + Telegram

```bash
anet create 小明 --runtime claude-sdk --model claude-sonnet-4-6
anet channel add telegram 小明 --bot-token xxx --allow 7612221352
anet start 小明
```

### 接入已有 Claude Code session

```bash
anet resume 指挥室 --session <session-id>
```

这个快捷路径可以自动 create，但必须打印清楚它创建/写入了哪个 node：

```text
[anet] Created node 指挥室
[anet] Saved session <session-id> to .anet/nodes/指挥室/config.json
[anet] Resuming 指挥室...
```

## 10. 命令命名建议

推荐用：

```bash
anet create <node-id>
```

暂时不要用：

```bash
anet add <node-id>
anet node create <node-id>
```

理由：

- `anet create` 短，和 `start/resume` 同级，适合日常使用。
- `anet add` 太泛；添加 node、channel、server、token 都能叫 add。
- `anet node create` 更规范，但当前 CLI 顶层主对象就是 node，没必要先加一层 namespace。以后可以作为 alias。

`anet init profile` 应 deprecated。保留 1-2 个版本的兼容入口，并提示：

```text
[deprecated] anet init profile is now anet create.
Run: anet create <id> ...
```

## 11. runtime 命名和启动映射

用户只看到：

```text
claude-code   # default；anet spawn Claude Code CLI
codex         # anet spawn agent-node --runtime codex
claude-sdk    # anet spawn agent-node --runtime claude-sdk
```

`agent-sdk` 不再出现在帮助、config、日志摘要里。兼容读取可以保留，但保存时写回新名字。

anet start 的 agent-node 分支不要只传 alias；至少在过渡期传：

```bash
npx @sleep2agi/agent-node \
  --config .anet/nodes/<node-id>/config.json \
  --runtime codex \
  --alias <alias>
```

理由：让“anet 启动”和“裸 agent-node 启动”读同一个 node config，并避免 agent-node 回退到旧 `.anet/profiles/<alias>.json`。

## 12. 对 SDK马草案的关键分歧

### 12.1 config 路径同意 nodes，不同意 profiles

同意新读取优先级里加入：

```text
.anet/nodes/<id>/config.json
```

但不建议把 `<id>` 写成 alias。**node-id 是目录名；alias 是显示名。**

推荐：

```text
.anet/nodes/<node-id>/config.json
```

config 里：

```json
{
  "alias": "小明"
}
```

### 12.2 暂不建议把 channel 改成全局 `~/.anet/channels/<name>/`

SDK马草案第 4 节提出全局 channel registry：

```text
~/.anet/channels/<name>/
```

这比当前已定方向更重，而且改变了 `anet channel add telegram <node-id>` 的语义。

本轮推荐继续 node-local：

```text
{workpath}/.anet/nodes/<node-id>/channels/telegram/
├── .env
├── access.json
├── state.json
└── inbox/
```

原因：

- Telegram bot token / access / state 跟具体 node 绑定，最直觉。
- `anet channel add telegram A站牛` 可以明确修改 `A站牛`。
- 不需要再教用户 channel name、channel registry、attach channel 三个概念。
- 避免两个 node 误用同一个 long-polling bot token。

全局 channel 可以作为 P1/P2 的“共享外部账号”能力，不要塞进这次 CLI rename。

### 12.3 channel 命令仍建议是 “add type node-id”

推荐：

```bash
anet channel add telegram A站牛 --bot-token xxx --allow uid
```

暂不推荐：

```bash
anet channel add tg-intern --type telegram --token xxx
anet create 小明 --channel tg-intern
```

后者是更完整的 channel 管理系统，但当前目标是 agent-node / Claude Code 快速接 Telegram。

## 13. 推荐 config.json 最小 schema

```json
{
  "anet_version": "0.1.0",
  "runtime": "codex",
  "alias": "A站牛",
  "hub": "http://127.0.0.1:9200",
  "token": "",
  "model": "gpt-5.4",
  "session": "",
  "channels": ["telegram"],
  "tools": ["Read", "Bash"],
  "env": {},
  "flags": {
    "maxTurns": 5,
    "maxBudgetUsd": 0,
    "logLevel": "info",
    "systemPrompt": ""
  }
}
```

需要收敛的旧字段：

- `resume` / `resumeAlias` / `sessionId` → `session`
- `agent-sdk` → `claude-sdk` 或 `codex`
- `.anet/profiles/<alias>.json` → `.anet/nodes/<node-id>/config.json`

## 14. CLI 参数边界

`anet create` 接受 node 属性：

```bash
anet create <node-id> \
  --runtime claude-code|codex|claude-sdk \
  --alias <display-name> \
  --model <model> \
  --tools <list> \
  --session <session-id>
```

`anet channel add` 接受 channel 属性：

```bash
anet channel add telegram <node-id> \
  --bot-token <telegram-token> \
  --allow <telegram-numeric-user-id>
```

不要在 channel add 上挂 `--runtime`。

## 15. 新用户帮助页建议

把 help 首页改成这个顺序：

```text
Quick start:
  anet init --hub http://127.0.0.1:9200
  anet create 小明 --runtime codex
  anet channel add telegram 小明 --bot-token xxx --allow <telegram-user-id>
  anet start 小明

Create:
  anet create <node-id> [--runtime claude-code|codex|claude-sdk] [--alias name] [--model name]

Run:
  anet start <node-id>
  anet resume <node-id>
  anet resume <node-id> --session <session-id>

Channel:
  anet channel add telegram <node-id> --bot-token xxx --allow uid
  anet channel ls [node-id]
```

## 16. 给 agent-node 的接口约定建议

支持显式 config：

```bash
agent-node --config .anet/nodes/<node-id>/config.json
```

agent-node 以 config 文件所在目录作为 node dir，解析相对 channel：

```text
<node-dir>/channels/telegram/.env
<node-dir>/channels/telegram/access.json
<node-dir>/channels/telegram/state.json
<node-dir>/channels/telegram/inbox/
```

`--channel telegram` 的意思是读取 `<node-dir>/channels/telegram/`。

`--channel telegram:/abs/path` 可以保留为调试 override，但 anet 正常路径不需要用。

## 17. 已定决策

指挥室拍板（2026-04-09）：

1. **channel：node-local**。路径 `{workpath}/.anet/nodes/<node-id>/channels/telegram/`
2. **agent-node 支持 `--config`**：`--config` 优先，没传按 `--alias` 自动找
3. **session 字段统一叫 `session`**。废弃 `resume` / `resumeAlias` / `sessionId`
4. **anet start 传参**：传 `--config` + `--alias`，支持少量显式 override（`--runtime`、`--model`）
5. **`anet resume <id> --session <sid>` 自动 create 保留**：作为快捷迁移路径
6. **runtime 命名**：`claude-code-cli` / `codex-sdk` / `claude-agent-sdk`
