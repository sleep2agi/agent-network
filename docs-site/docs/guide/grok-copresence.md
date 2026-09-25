# Grok 人机共存 TUI（实验）

::: danger 默认且推荐用 ACP 模式 `grok-build-acp`；共存模式 `grok-build-cli` 是实验能力
Grok 节点默认、推荐用 `--runtime grok-build-acp`（ACP 模式）。`grok-build-cli` 共存是实验能力：人在 TUI 输入框里有字时网络任务只会排队、超时后失败；grok 自更新到验证清单外的版本后，下一次重启起不来（报错里给出 `GROK_BINARY=<已验证的旧版本> anet node start <节点>` 恢复命令）。无人值守、要稳定接活，用 `--runtime grok-build-acp`。
:::

::: tip 当前状态
`grok-build-cli` 和 `anet grok attach` 已经在 npm 发布包里（`latest` 与 `preview` 两条通道都有；`anet --help` 的「Grok co-presence」一节会列出它们），状态是**实验**：能端到端跑通（建节点 → `anet grok attach` 进入共享 TUI → 网络任务注入并回复），但不作为默认推荐。只接受验证清单里的 grok build（`0.2.93 (f00f96316d)` 与 `1.0.5 (5115b46bc909)`）。用法见 [Grok 共存 TUI（grok-build-cli）](/guide/grok-tui)。页面下方的 danger 块是 2026-08-18 的旧状态，保留供追溯。
:::

::: warning `blocked` 分辨不出真假 —— **从 agent-node `2.5.0-preview.57` 起已修**（[#1606](https://github.com/sleep2agi/agent-network/issues/1606)）
**用 grok 1.0.5 时这一格恒为 `blocked`，即使节点正在正常干活。**

1.0.5 是 **leaderless** build —— 按设计就不创建 `leader.sock`（能力表里 `autoLeader: false`，macOS 与 Linux 都是），
而 liveness 判据无条件要求它存在，于是 `usable` 结构性恒假，心跳上报的 `idle` 每 3 分钟被改写成 `blocked`。

实测：被标成 `blocked` 的节点仍然成功注入并返回了网络任务，还回复了发起方。

**看到 `blocked` 先别重建节点。** 先看你的 agent-node 版本：

```bash
agent-node --version
```

- **≥ `2.5.0-preview.57`** —— 已修。此时的 `blocked` **是有信息量的**，去查 TUI 子进程、composer 就绪、`attach.sock`。
- **< `2.5.0-preview.57`** —— 这一格对 leaderless build 恒为假，**不携带任何信息**。以节点日志为准：
  日志里有 `injected network task` / `processTask returned` 就说明运行时是好的。

🔴 **升级之后必须重启，光换包不够** —— liveness 在**长驻进程内**算：

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.57
anet daemon restart <daemon>        # 需要 anet ≥ 2.3.0-preview.74
```

🔴 **重启之前先看一眼 grok 版本**（[#1615](https://github.com/sleep2agi/agent-network/issues/1615)）：

```bash
grok --version
```

**`PATH` 上的 `grok` 可能变成一个不在验证清单里的版本**（例如有人在这台机器上装了新版）。
一旦变了，**共存节点一重启就起不来**
（fail-closed 拒绝启动），而**在跑的节点看起来完全正常** —— 因为它们用的是启动时那份旧进程。
也就是说：这个问题只在你执行上面那条 restart 的时候才暴露，而那时节点已经停了。

已验证的版本会列在报错里。旧版二进制通常还在 `~/.grok/downloads/`，可以用它起：

```bash
GROK_BINARY=~/.grok/downloads/grok-<已验证版本>-<平台> anet node start <name>
```
:::

::: danger 2026-08-18 时点的旧状态（保留存档）
`grok-build-cli` 这条 runtime 路径**不要照旧文档使用** —— 不要执行 `anet node create ... --runtime grok-build-cli`。

🔴 **更正(2026-08-18 实测)**:原文写「`anet grok attach` 尚未进入 `latest` 或 `preview`」,**后半句不成立**。用真包跑二进制:

```
latest  2.2.21              anet grok attach → Unknown: grok
preview 2.3.0-preview.39    anet grok attach → Usage: anet grok attach <node>
```

⇒ **这个命令在 `preview` 里是存在的**,只是 `latest` 里没有。
**但「命令存在」不等于「这条共存路径可用」** —— 命令注册不等于端到端可用。
Hub 不得把死掉/未就绪的 TUI 报成 `idle`（#1005：liveness 快照，子进程已死 / composer 未就绪 /
缺 named attach socket 时为 `blocked`）。

🔴 **更正(2026-08-30,#1548)**:这句原本写作「缺 named socket … 为 `blocked`」，
把 **leader** socket 也算了进去 —— 而**有些 grok build（能力表里 `autoLeader: false`，例如 1.0.5）
按设计就不建 `leader.sock`**。于是这类节点的 `usable` 结构性恒为假，名册上永远显示 `blocked`，
而运行时可能完全正常（实测:被标 blocked 之后仍成功接活并回复）。

所以判据现在**按 build 分**：`autoLeader: true` 的 build 仍要求 `leader.sock` 在且命名正确；
`autoLeader: false` 的 build **要求它不在**（它若出现，说明「这个 build 不外派工具」的前提不成立，
与 `settleLeader()` 启动时的 fail-closed 同向）。
**分界线是版本,不是平台** —— 1.0.5 在 macOS 和 Linux 上都不建。
本页其余的告诫仍然成立:它仍在重新验收,不要当已发布功能用。
:::

## 现在可以用什么

- `grok-build-acp`（**默认、推荐**）：正式的 Grok runtime，通过 `grok agent stdio` 执行网络任务；**不能 attach 到同一个 TUI**。
- `grok-build-cli`（**实验**）：人和网络任务共享同一个 Grok TUI，见 [Grok 共存 TUI](/guide/grok-tui)。
- `grok`：可直接在终端使用 Grok CLI，但这不会把该 TUI 变成 Agent Network 共存节点。

```bash
grok login
anet node create grok-agent --runtime grok-build-acp
anet node start grok-agent
```

共存模式的建节点与 attach 步骤见 [Grok 共存 TUI](/guide/grok-tui)。发布频道说明见[版本说明](./versioning.md)。
