# Grok 人机共存 TUI（`grok-build-cli`，preview）

`grok-build-cli` runtime 让你 **attach 到 agent-node 持有的那个真实 Grok TUI**。你和 CommHub 网络任务共享同一段 Grok 会话：网络任务进入同一个 Grok session、在终端里实时渲染、完成后把答复回传给任务发起者，而你随时能在旁边一起看、一起打字——人和 agent 同处一个会话上下文。

> `grok-build-acp` 是独立的 ACP（`grok agent stdio`）路径，**不支持 attach**。需要人机共存请用 `grok-build-cli`。

::: warning Preview
这是 **preview**，不属于 latest/生产。只连接可信 Hub 与可信任务。
:::

## 前提

- **Linux**（需要 `/proc` 与 `/proc/self/fd` 可用）
- **Node.js ≥ 22.13**
- 已安装并登录**精确版本**的 Grok CLI：`grok 0.2.93 (f00f96316d)`（末尾允许 `[stable]`），且由**运行 anet 的同一 OS 用户**执行 `grok login`。

```bash
# 装精确版本（共存对 grok 版本敏感）——install.sh 支持 bash -s <版本>
curl -fsSL https://x.ai/cli/install.sh | bash -s 0.2.93
grok login
grok --version   # 必须是 grok 0.2.93 (f00f96316d)
```

## 安装

```bash
npm install -g @sleep2agi/agent-network@preview
```

只需安装 `agent-network`；首次 `node start` 会自动拉取并校验 `agent-node@preview`（因此首次启动需要 npm registry 或已有缓存）。

如需锁死本次验证过的组合：

```bash
npm install -g \
  @sleep2agi/agent-network@2.3.0-preview.23 \
  @sleep2agi/agent-node@2.5.0-preview.21
```

## 最小流程

若尚未配置 CommHub，先按 [快速开始](./getting-started.md) 启动并登录 Hub。然后在**目标项目目录**：

```bash
# Terminal 1：创建并启动共存节点
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared
```

等启动日志出现提示：

```text
attach with anet grok attach grok-shared
```

再从**同机、同 OS 用户、同一项目目录**的真实交互终端：

```bash
# Terminal 2
anet grok attach grok-shared
```

- attach 没有其他必需 flag。
- `Ctrl-]` 只会 **detach**，不会停止节点。
- 要开始接收网络任务，等日志出现 `SSE connected`。

## 三种 Grok 路径的区别

| 配置 | 执行方式 | 可 attach |
|---|---|---|
| `--runtime grok-build-cli` | 共存 TUI | ✅ 是 |
| `--runtime grok-build-cli --grok-headless` | 每任务一个 CLI turn | ❌ 否 |
| `--runtime grok-build-acp` | `grok agent stdio` ACP | ❌ 否 |

想要共存 attach，**不要**加 `--grok-headless`。

## Caveats

- **仅 Linux**，需要 `/proc` 与 `/proc/self/fd`。
- Grok 必须是精确的 `0.2.93 (f00f96316d)`，并由同一 OS 用户 `grok login`。
- attach 必须是**真实 TTY**，且从同机、同用户、同一项目目录运行。
- 共存会话是固定的 **text-only `[todo_write]` profile**：没有 filesystem、shell、network、media、MCP 或 subagent 工具。
- 这条路径**没有 Grok MCP tool handshake**——不要按旧文档「等待几秒 MCP 握手」；attach 以启动日志提示为准，接收任务以 `SSE connected` 为准。
- 项目目录中的 MCP / LSP / hooks / plugins / permission / sandbox / `.envrc` 等可执行配置会触发 **fail-closed**（拒绝启动/恢复）。
- 当前**明确拒绝** Feishu channel。
- 只连接可信 Hub 与可信任务；这是 preview，不属于 latest/生产。

## 参考

- [节点 Runtime 对比](./runtimes.md)
- [Grok Build 运行时说明](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)
