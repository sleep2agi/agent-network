# Codex TUI 人机共存（`codex-app-server`，preview）

`codex-app-server` runtime 让**人和 Agent 共用同一个 Codex 会话**：人在原生 Codex TUI 里输入 / 看输出 / 处理审批，同时 Agent Network 的任务经 CommHub 注入**同一个 Codex thread**。人和 agent 看到同一段历史、同一组实时事件。（[RFC-030](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)，Phase 0A。）

> 与无头的 `codex-sdk` 不同：`codex-sdk` 是后台工作器、没有可共存的活 TUI；`codex-app-server` 才是「人机共存」。

::: warning Preview
这是 **preview**（不在 `latest`），且当前为**单机**形态。只连可信 Hub。
:::

## 前置

- 安装并登录 Codex CLI（验证基线 `codex-cli 0.144`）：`codex login`
- 安装 preview 版 anet：

```bash
npm install -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview
```

## 两种拓扑（先搞清楚）

`codex-app-server` runtime 有两种模式：

- **自持（默认，不传 URL）**：节点**自己 spawn 一个 codex app-server**（临时端口、新 thread），你什么都不用起——但那个 server 是节点私有的、临时端口，你的 TUI 连不进去。**这不是共存**，只是一个能跑 codex 的 agent。想要这个：`anet node create codex-node --runtime codex-app-server` + `anet node start`，完事。
- **共享（传 URL）→ 人机共存**：你**自己**起一个固定地址的 app-server，你的 `codex --remote` TUI 和 anet 节点都连它。这才是人机共存——下面讲的就是这个。共存**必须**手动起共享 server，因为人和 agent 得连同一个固定地址（节点私有的临时那个满足不了）。

## 起共存会话（共享模式）

**1. 起共享 codex app-server**（WS transport，跨平台，含 Windows）：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

> 只绑 `127.0.0.1`，不要暴露公网。本地长驻优先 `codex remote-control start` + `codex --remote unix://`（unix socket 仅 Linux/macOS；Windows 用上面的 WS）。

**2. 人类接入 TUI**（另开一个终端）：

```bash
codex --remote ws://127.0.0.1:4500
```

**3. 起 anet bridge 节点**（作为第二个客户端，绑同一个 app-server）：

一条命令搞定——`--codex-app-server-url` 直接把地址写进节点配置，无需 env、无需手改文件；thread 由 runtime **自动捕获并写回** `codexThreadId`：

```bash
anet node create codex-human --runtime codex-app-server --codex-app-server-url ws://127.0.0.1:4500
anet node start codex-human   # 连上后自动捕获 thread，写回 config.json 的 codexThreadId
```

> 可选：加 `--codex-thread-id <id>` 接管**指定**的已有会话（不加则自动捕获）。地址也可用环境变量 `ANET_CODEX_APP_SERVER_URL`，或直接改 `config.json` 的 `codexAppServerUrl`（三者等效，优先级：config > env）。

现在 Agent Network 里其他节点向 `codex-human` 派 `send_task`，任务会出现在人类可见的 Codex TUI 里；人也可在 TUI 里直接输入，或在 agent 发起的 turn 中补充要求。

## 注意

- **preview + 单机**：Phase 0A 形态，仅单机可信 profile。
- **一个 thread 同一时刻只有一个 active turn**；「同时通信」= 多生产者（人 + 多个 agent）可同时向同一 thread 投递。
- **所有 Codex 命令 / 文件变更 / 权限审批只由人类 TUI 决定**；agent 侧走受限 MCP 代理。
- app-server 只监听 `127.0.0.1`；token / 密钥不入 git、不走聊天。
- Windows 走 **WS transport**（不是 unix socket）；node-pty 等原生依赖非必需。

## 参考

- [RFC-030 Codex TUI Bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)
- [节点 Runtime](/guide/runtimes) · [Grok 人机共存 TUI](/guide/grok-copresence)（另一种共存）
