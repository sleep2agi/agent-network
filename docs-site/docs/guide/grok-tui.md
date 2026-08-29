# Grok 共存 TUI

`grok-build-cli` 让一个 Agent Network 节点持有唯一的真实 Grok TUI。你从另一个终端用 `anet grok attach` 进入同一界面；CommHub 网络任务也会排队进入同一会话。人类输入优先，网络任务按 FIFO 执行。

::: warning 实验能力（preview 通道可用）
共存能力已随 npm preview 通道发布（实测 `@sleep2agi/agent-network@2.3.0-preview.59` + `@sleep2agi/agent-node@2.5.0-preview.43` 可用）。它不会替代 `grok-build-acp`。共存只接受**已验证的 grok build**：`0.2.93 (f00f96316d)` 与 `1.0.5 (5115b46bc909)`；清单外的版本会拒绝启动。
:::

## 前置检查

- Linux、macOS 或 WSL；已安装 Node.js、Bun 和原生 `node-pty` 依赖
- Grok Build CLI 已安装并完成登录
- 已 clone Agent Network 仓库

```bash
grok --version
# 必须是：grok 0.2.93 (f00f96316d)

grok
# 首次使用时按界面完成登录，然后退出
```

## 构建源码

在仓库根目录执行：

```bash
cd agent-node
bun install
npm run build
cd ../agent-network
bun install
npm run build
cd ..
```

本页后续命令必须调用刚构建的 CLI，而不是 npm stable 的全局 `anet`。在 bash/zsh 中可定义一个仅对当前 shell 有效的函数，并显式指定刚构建的 agent-node：

```bash
export ANET_SOURCE=/绝对路径/agent-orchestra
export ANET_AGENT_NODE_BIN="$ANET_SOURCE/agent-node/dist/cli.js"
anet() { bun "$ANET_SOURCE/agent-network/dist/bin/cli.js" "$@"; }

anet --help | grep grok-build-cli
# 应能看到 grok-build-cli 和 `anet grok attach` 帮助
```

## 启动与连接

先按[上手指南](/guide/getting-started)启动 Hub 并登录。然后使用两个终端：

```bash
# 终端 1：创建并持续运行节点
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo
```

看到以下提示说明 TUI 已准备好：

```text
[grok-copresence] ...; attach with anet grok attach grok-demo
```

```bash
# 终端 2：连接到同一个 live TUI
anet grok attach grok-demo
```

在 attach 终端按 `Ctrl-]` 只会断开当前终端，不会停止节点或 Grok 会话。同一时间只允许一个人类终端连接；第二个连接会被拒绝。

网络任务会在 TUI 中以以下形式出现：

```text
[Agent Network/from=<发送者>/task=<任务 ID>] <消息>
```

普通的人类对话不会自动发送到 Agent Network。只有明确的委派指令（例如 `给 reviewer 发任务: 检查当前改动`）才会触发派发。

## 停止与恢复

用正常的节点命令停止：

```bash
anet node stop grok-demo
```

再次 `anet node start grok-demo` 会恢复同一 `grokCliSession`。运行时不会静默切换到 headless，也不会猜测另一个会话。若进程在网络任务执行中崩溃，该任务会失败而不会自动重放，避免重复副作用。

## 在共存 TUI 里换模型

共存 TUI 是**人和 agent 共用同一个输入框**：你敲的每个键都直达 agent 会话，所以行首斜杠命令默认被整类拦截（补全可能把短前缀+回车变成 `/always-approve`，绕开审批闸门）。换模型有两条安全路径：

- **TUI 里直接打 `/model <模型名>`**（agent-node `2.5.0-preview.45`+）：一条干净的 `/model <id>` 会被**代为执行**——按键仍被取消（斜杠面板收不到回车），换模型带外走受护入口，结果直接答在 TUI 里（`[anet] 已代为切换模型 → <模型名>`）。多参数、裸 `/model`、被方向键编辑过的行都不代理，仍照常拦截。
- **另开终端 `anet grok model <节点> <模型名>`**：任意版本可用，attach 挂着也能切；同会话用新模型重启。

`anet grok attach` 必须在节点的工作目录下执行（按 cwd 解析节点，见 [#1402](https://github.com/sleep2agi/agent-network/issues/1402)）。

## 旧 headless 模式

如需每个网络任务单独启动无界面 Grok 进程：

```bash
anet node create grok-headless --runtime grok-build-cli --grok-headless
```

headless 节点不能使用 `anet grok attach`。缺少 `grokCopresence: true` 的旧 profile 也会保留原行为，不会自动迁移。

## 常见问题

### 提示版本过旧或版本不匹配

运行 `grok --version`。共存只接受已验证清单里的精确 build（当前为 `0.2.93 (f00f96316d)` 与 `1.0.5 (5115b46bc909)`）；装到清单内版本后再启动，不要绕过版本检查。1.0.5 上 sandbox 与 leader 模式互斥，运行时会自动按版本调整启动参数，无需手工干预。

### 已有的裸 grok 会话默认不能直接变共存（但可移植）

在普通 `grok`（sandbox=off）里创建的会话**默认无法** resume 进共存节点：共存运行时强制沙箱档，grok 会拒绝跨档 resume（`cannot resume this session under sandbox profile … it was created with 'off'`）。把已有会话直接 pin 进 `grokCliSession` 会反复得到 `Grok recovery TUI exited before recovery drain`（诊断改进见 [#1400](https://github.com/sleep2agi/agent-network/issues/1400)）。

**已验证的移植做法**（保留全部历史、无需关沙箱，见 [#1409](https://github.com/sleep2agi/agent-network/issues/1409)）：拒绝的依据只是会话元数据里记着 `created with 'off'`，把会话**克隆一份**再改这一处即可绕过——

1. 把旧会话目录（`sessions/<cwd-key>/<old-id>/` 全量，含 `chat_history.jsonl`/`events.jsonl`/`compaction/`）复制成一个新 UUID，删掉 `*.lock`。
2. 改克隆件 `summary.json` 的 `sandbox_profile`：`"off"` → 节点当前的 workspace 档（形如 `anet-<hash>-workspace`，全目录仅此一处含该字段）。
3. 节点 config 的 `grokCliSession` 指向新 id，重启节点。

重启后 grok 正常 resume 克隆会话，近期技术上下文完整带回（早期/低频内容可能因 grok 的会话 compaction 落在活动窗口外）。原始旧会话全程不动，随时仍可 `grok --resume <old-id>` 单独查看。若不想移植，也可让节点新建沙箱内会话（不 pin 旧 id 或 `--new-session`）。

> ⚠️ 别让 `auto_update` 把 grok 升出验证清单：升到未验证版本（如 `1.0.13`）后共存会直接报 `requires a verified grok build`。用 `GROK_BINARY` 钉住已验证 build，或在节点私有 `GROK_HOME` 关掉 `auto_update`（[#1409](https://github.com/sleep2agi/agent-network/issues/1409)）。

### `Installed agent-node does not support grok-build-cli`

你正在调用 npm stable 的 agent-node，或 `ANET_AGENT_NODE_BIN` 指向错误。重新构建 `agent-node`，并把该变量设为 `dist/cli.js` 的绝对路径。

### attach 提示不是 TTY

`anet grok attach` 必须直接在交互式终端运行，不能通过 pipe、重定向或非交互 CI 执行。

### attach 提示节点是 legacy headless

该 profile 没有启用共存模式。创建新的 `grok-build-cli` 节点；不要直接复制 socket 路径或猜测配置。

### 权限确认

权限弹窗只由已连接的人类处理。运行时不会替你选择永久允许，并会阻止改变共享审批策略的 TUI 命令。审批界面只使用 Enter（单次允许）或 `Ctrl-C`（拒绝/取消）。

实现、安全边界和 Docker 验证细节见[完整 Grok Build Runtime 说明](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)。
