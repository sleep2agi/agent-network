# 支持矩阵：哪个功能，在哪个 Runtime / 操作系统上能用

这一页回答两个问题：

1. 一个功能，在 7 个 runtime 上分别能不能用？
2. 一台机器，装什么操作系统才能用哪些能力？

## 怎么读这张表

每一格是三种状态之一，不是两种：

| 记号 | 含义 |
|---|---|
| ✅ | 验证过，可用 |
| ❌ | 验证过，不可用，原因已知（见脚注） |
| ❓ | 还没验证过。不代表「可能可以」，也不代表「大概不行」 |

另有两个辅助记号：⚠️ 表示有已知问题、结论未定，见该格下方的说明；— 表示不适用。

部分 ✅ 带有可靠性级别：

| 级别 | 含义 | 建议 |
|---|---|---|
| ✅L3 | 有自动化测试，在 CI 中持续运行 | 可以依赖 |
| ✅L2 | 在真实机器上验证过，但不在 CI 中 | 能用，升级后建议自行复核 |
| ✅L1 | 只验证过正常用法 | 谨慎使用 |

不带级别的 ✅ 按 L1 理解。遇到 ❓ 时，请在自己的环境里先试一次再依赖它。

表格反映的是最近一次验证时的结果，之后发布的版本可能已经改变结果，脚注里注明了已知的变化。
如果你发现某一格与实际不符，欢迎在 [GitHub](https://github.com/sleep2agi/agent-network/issues) 提 issue 并附上复现步骤。

---

## 一、功能 × Runtime

7 个 runtime：
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| 功能 | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| CLI 直接创建节点<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| daemon 代创建节点<br>经 `create_node` | ✅ | ❓ | ✅ | ❓ ^1^ | ✅ | ❓ ^1^ | ❓ ^1^ |
| TUI 人机共存<br>人和 agent 共用一个会话 | — | — | — | ✅ | — | ✅ | ✅ |
| 节点层日志<br>`.anet/nodes/<alias>/logs/` | ✅ | ❓ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| 飞书 IM 直聊 | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| 任务结果正确标记失败<br>坏结果不会被记成成功 | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**脚注**

- ^1^ 较早的版本上，经 daemon 创建这三个共存 runtime 会被 Hub 以 `runtime_invalid` 拒绝。
  Hub 与 daemon 的 runtime 清单此后都已放开到全部 7 个
  （[#1298](https://github.com/sleep2agi/agent-network/issues/1298)），但经 daemon 创建的共存节点还没有端到端重新验证。
  另外请注意：这三个 runtime 的用途是「人和 agent 共用一个 TUI 会话」，而 daemon 建出来的是无人值守的后台进程；
  需要它们时，更稳妥的做法是在目标机器上用 `anet node create` 创建。
- ^2^ 较早的版本上，`claude-code-cli` 节点不写节点层日志：该模式下 Claude Code 自己承载 CommHub 通道，
  不会启动 `agent-node` 进程，而节点层日志是 `agent-node` 写的。
  修复（把日志同时写进 `.anet/nodes/<alias>/logs/`）已发布（[#1345](https://github.com/sleep2agi/agent-network/issues/1345)），
  这一格尚未重新验证。
- ^3^ 飞书路径目前只在 `claude-agent-sdk` 上验证过，其余 runtime 是「还没验证」，不是「不支持」。
  见 [#1259](https://github.com/sleep2agi/agent-network/issues/1259)。
- ^4^ opencode 节点可能把未执行的 `<tool_call>` 原文当作任务结果返回，而 Hub 会把它记为正常完成，
  所以只看任务状态发现不了。同类问题是否也影响其他 runtime 尚未验证。
  见 [#943](https://github.com/sleep2agi/agent-network/issues/943)。

---

## 二、操作系统 × 能力

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| CLI 起节点（`anet node start`） | ✅ | ✅ | ❓ |
| daemon 创建节点（任何 runtime） | ✅ | ✅ | ❌ ^5^ |
| daemon 注册 / 在线 / 收 doorbell | ✅ | ✅ | ✅ ^6^ |
| 外部启动器 / `anet hub start` / 自升级 | ✅ | ✅ | ❓ ^7^ |
| TUI 共存（Codex） | ✅ | ✅ | ❓ ^8^ |

Windows 上的 daemon 目前不在支持范围内。

**脚注**

- ^5^ daemon 校验 `anet` 可执行文件路径时按 POSIX 路径设计，Windows 路径（`C:\...`）无法通过，
  结果是 `anet_bin_unsafe_path`。
- ^6^ 这一格要当心：Windows 上的 daemon 能注册、显示在线、收到 doorbell，Dashboard 的「选服务器」也会列出它，
  但它创建不了节点（见 ^5^），失败只出现在 daemon 自己的日志里。创建节点时请不要选择 Windows 上的 daemon。
- ^7^ 较早的版本上，Windows 的外部启动器（`.cmd` 文件）无法被直接调用。修复已合入
  （[#1137](https://github.com/sleep2agi/agent-network/pull/1137)），这一格尚未重新验证。
- ^8^ Windows 上的 Codex 共存有 CI 覆盖，但存在约 8% 的间歇失败。
  见 [#1342](https://github.com/sleep2agi/agent-network/issues/1342)。

---

## 三、daemon 生命周期操作

### Linux

| 操作 | 结果 |
|---|---|
| 查看（list nodes） | ✅ |
| 创建（`create_node`） | ✅ |
| 编辑（`update_node_config`） | ✅ |
| 操作（`restart_node`） | ✅ |
| 停止（`stop_node`） | ✅ |
| 删除（`delete_node`） | ⚠️ 见下 |

较早的版本上，对已停止的子节点执行 `delete_node` 可能卡在 `lifecycle_state=deleting`，Hub 侧不收敛。
修复已合入（[#1286](https://github.com/sleep2agi/agent-network/issues/1286)），Linux 上尚未在修复后的版本上重新验证。

### macOS

| 操作 | 状态 |
|---|---|
| daemon 在线（注册 / SSE 连接） | ✅L2 |
| 创建 `create_node` | ✅L2 |
| 编辑 `update_node_config` | ✅L2 |
| 重启 `restart_node` | ✅L2 |
| 停止 `stop_node` | ✅L2 |
| 删除 `delete_node` | ✅L2 |

这里的判据不是 `create_node` 返回 `ok:true`，而是节点真的起来并在 Hub 上注册；
编辑的判据是节点本地的 `config.json` 真的变了；删除走的是「先停止再删除」的路径。

### macOS × Runtime（daemon 创建节点）

| runtime | daemon 创建节点 |
|---|---|
| `claude-agent-sdk` | ✅L2 |
| `codex-sdk` | ✅L2 |
| `codex-app-server` | ❓，见 ^1^ |

### 已知限制：daemon 重启后可能不能再创建节点

如果 daemon 创建节点所需的 `anet` 路径是通过环境变量（`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS`）临时提供的，
重启 daemon 时没有带上这些变量，它仍会正常注册、在线、收 doorbell，Hub 也返回 `ok:true`，
但节点创建不出来，daemon 日志里会出现：

```text
[WARN] anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

「在线」和「能创建节点」是两回事。要让配置跨重启保留，请把路径写进 `path.conf`，
做法见 [让 daemon 能真的创建节点](/deploy/daemon#anet-bin-pin)。

---

## 相关

- [Runtime 安装与认证](/guide/runtimes)
- [让 Hub 常驻：进程守护](/deploy/daemon)
