# 支持矩阵：哪个功能，在哪个 Runtime / 操作系统上能用

这一页回答两个问题：

1. **一个功能，在 7 个 runtime 上分别能不能用？**
2. **一台机器，装什么操作系统才能用哪些能力？**

## 怎么读这张表

**这张表有三种状态，不是两种：**

| 记号 | 含义 |
|---|---|
| ✅ | **验过，可用** —— 有实测证据，证据链接在脚注 |
| ❌ | **验过，不可用** —— 有实测证据说明它失败，且失败原因已知 |
| ❓ | **没验过** —— 我们不知道。**不是「可能可以」，也不是「大概不行」** |

同样是 ✅，可靠性可能差很多，所以 ✅ 后面可以带一个级别：

| 级别 | 含义 | 用户该怎么读 |
|---|---|---|
| **✅L3** | 有自动化套件，**进 CI**，回归会红 | 可以依赖 |
| **✅L2** | **真机验过**，有日志/报告存档，**不进 CI** | 能用，但回归无保护 |
| **✅L1** | 只跑通了 happy path，**没喂过错误输入** | 谨慎 —— 它只证明"顺着用不会坏" |

裸 `✅`（不带级别）= 这一格的强度还没人标注，**按 L1 读**。读到 ❓ 时，请在自己的环境里先验一次再依赖它。

表中的读数大多来自 2026-08-28 的实测；之后发布的版本可能已经改变结果，脚注里注明了已知的变化。

---

## 一、功能 × Runtime

7 个 runtime：
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| 功能 | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| **CLI 直接创建节点**<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **daemon 代创建节点**<br>经 `create_node` | ✅ | ❓ | ✅ | ❓ ^1^ | ✅ | ❓ ^1^ | ❓ ^1^ |
| **TUI 人机共存**<br>人和 agent 共用一个会话 | — | — | — | ✅ | — | ✅ | ✅ |
| **节点层日志**<br>`.anet/nodes/<alias>/logs/` | ✅ | ❓ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| **飞书 IM 直聊** | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| **任务结果正确标记失败**<br>坏结果不会被记成成功 | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**脚注**

- **^1^** 2026-08-28 实测时，这三个共存 runtime 经 daemon 创建会被 Hub 拒绝，返回
  `{"ok":false,"error":"runtime_invalid","value":"codex-app-server"}`，请求没有到达目标机器。
  现在 Hub 与 daemon 的 runtime 清单都已放开到全部 7 个
  （[#1298](https://github.com/sleep2agi/agent-network/issues/1298)、[#1301](https://github.com/sleep2agi/agent-network/pull/1301)），
  所以不再是 ❌；但经 daemon 创建的共存节点还没有端到端重测，记 ❓。
  另外请注意：这三个 runtime 的用途是「人和 agent 共用一个 TUI 会话」，而 daemon 建出来的是无人值守的后台进程。
- **^2^** 2026-08-28 实测时，`claude-code-cli` 节点不写节点层日志：该模式下 Claude Code 以 in-process channel 承载 commhub，
  **`agent-node` 进程不会启动**，而节点层日志是 agent-node 写的。
  修复（stdio proxy 把日志双写进 `.anet/nodes/<alias>/logs/`）已随 2026-08-28 的 preview 批次发布
  （[#1345](https://github.com/sleep2agi/agent-network/issues/1345)），本表未重测，记 ❓。
- **^3^** 飞书路径**只在 `claude-agent-sdk` 上验过**，其余六个都没有。这不是「不支持」，是**还没验过**。
  → [#1259](https://github.com/sleep2agi/agent-network/issues/1259)
- **^4^** opencode 节点把**未执行的 `<tool_call>` 原文**当作任务结果返回，
  且 hub 侧记为 `failed=false`（正常完成），按状态/计数的看板看不出来。
  同一个检查缺口在通用任务路径上，**可能不止 opencode**（待验）。
  → [#943](https://github.com/sleep2agi/agent-network/issues/943)

---

## 二、操作系统 × 能力

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| **CLI 起节点**（`anet node start`） | ✅ | ✅ | ❓ |
| **daemon 创建节点**（任何 runtime） | ✅ | ✅ | ❌ ^5^ |
| **daemon 注册 / 在线 / 收 doorbell** | ✅ | ✅ | ✅ ^6^ |
| **外部启动器 / `anet hub start` / 自升级** | ✅ | ✅ | ❓ ^7^ |
| **TUI 共存（Codex）** | ✅ | ✅ | ❓ ^8^ |

**Windows 上的 daemon 目前不在支持范围内**，上表 Windows 列的 ❌ 暂不排期。

**脚注**

- **^5^** daemon 校验 `anet` 二进制路径时要求绝对路径以 `/` 开头，而 Windows 绝对路径是 `C:\...`，
  所以必然报 `anet_bin_unsafe_path`；其后的几条权限检查在 Windows 上也不成立。
  → [#1290](https://github.com/sleep2agi/agent-network/issues/1290)
- **^6^** **这一格要当心。** Windows 上的 daemon **可以注册、在线、收 doorbell，但创建不了节点**；
  Hub 侧看它一切正常，Dashboard 的「选服务器」也会把它列为可选。
  选了它创建节点，只会在 daemon 日志里失败，Hub 收到的是 `ok:true` + request_id，之后没有下文。
  请不要选 Windows 上的 daemon 来创建节点。
- **^7^** 2026-08-28 实测时记 ❌：Windows 上外部启动器是 `.cmd`，直接 `spawnSync` 会 ENOENT/EINVAL（与 ^5^ 是两个独立原因）。
  修复已于 2026-08-29 合入（[#1137](https://github.com/sleep2agi/agent-network/pull/1137)），本表未重测，记 ❓。
- **^8^** Windows Codex 共存有 CI 覆盖，但存在约 8% 的间歇失败。
  → [#1342](https://github.com/sleep2agi/agent-network/issues/1342)

---

## 三、daemon 生命周期操作（2026-08-28 真机实测）

在一台 Linux daemon 上跑 `scripts/daemon-live-acceptance.sh --execute` 的结果：

| 操作 | 结果 |
|---|---|
| 查看（list nodes） | ✅ |
| 创建（`create_node`） | ✅ |
| 编辑（`update_node_config`） | ✅ |
| 操作（`restart_node`） | ✅ |
| 停止（`stop_node`） | ✅ |
| **删除（`delete_node`）** | **⚠️ 见下** |

### 删除这一格为什么记 ⚠️

- 在 `agent-node@2.5.0-preview.39` 上 100% 复现卡住：daemon 日志停在 `backed up child workdir`，
  Hub 行一直停在 `lifecycle_state=deleting`。
- 同一台机器换到 `agent-node@2.5.0-preview.40` 并重启 daemon 后，同样的复现跑三遍 3/3 成功。
  因为代码和进程同时变了，这三次成功不能单独证明问题已修，所以当时记 ⚠️。
- 之后「stop 之后再 delete」的根因修复已合入（[#1286](https://github.com/sleep2agi/agent-network/issues/1286)），本表未在 Linux 上重测。

### macOS 上的 daemon（2026-08-28 实测）

Mac mini（macOS 26.3.1）+ `agent-node@2.5.0-preview.40`，逐个跑完：

| 操作 | 状态 | 判据（**不是** `create_node` 返回的 `ok:true`） |
|---|---|---|
| daemon 在线（注册 / SSE connected） | **✅L2** | hub 侧 `11:34:27 SSE ← daemon-<host> connected` |
| **创建** `create_node` | **✅L2** | daemon 日志四行：`wrote child config` → `spawned pid=79490` → `post-spawn kill-0 verify OK` → `+5000ms capability check OK`；hub 侧子节点注册报活 |
| **编辑** `update_node_config` | **✅L2** | 判据是**节点侧真实文件**：`~/.anet/nodes/<alias>/config.json` 里 `model` 真的变了 |
| **重启** `restart_node` | **✅L2** | `ok, apply_mode=restart_only` |
| **停止** `stop_node` | **✅L2** | 四行埋点 + 进程消失 |
| **删除** `delete_node` | **✅L2** | `delete without map entry (expected after stop)` → `backed up child workdir` → hub 行 `node_not_found`，原目录已移走 |

删除这一格走的是「stop 之后再 delete」的路径，在 macOS + `.40` 上一次通过。

### macOS × Runtime（2026-08-28 实测）

| runtime | daemon 创建节点 | 判据 |
|---|---|---|
| `claude-agent-sdk` | **✅L2** | 上表六步全通 |
| `codex-sdk` | **✅L2** | spawn 四行验证 + hub 注册报活 + 删除全链走通（`ack accepted action=delete`） |
| `codex-app-server` | **❓** | 当时被 Hub 以 `runtime_invalid` 拒绝；该限制此后已放开，未重测（见脚注 ^1^） |

### daemon 重启后可能失去建节点能力（Linux + macOS 都复现过）

2026-08-28 在两个平台上各撞一次，日志形状相同：

```text
← SSE create_node cr_…
[WARN] anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

用 `anet daemon start` 重启 daemon 后，它**照常注册、在线、收 doorbell，Hub 返回 `ok:true`**，
但**一个节点也建不出来** —— 它依赖的 `ANET_BIN_ABS` 等变量没有落盘，重启就丢。
**「daemon 在线」不等于「daemon 能建节点」**，这两格要分开看。

**持久的做法是写 `/etc/anet-daemon/path.conf`**（跨重启存活）；
`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS=<realpath>` 只适合 Docker/开发/手工运维，**重启不会自动带上**。

**当时定位到的两个删除失败原因：**

1. **参数名不一致**：`delete_node` / `stop_node` 用 `child_node_id`，
   而 `restart_node` / `update_node_config` 用 `node_id`。传错直接 `-32602`。
   → [#1281](https://github.com/sleep2agi/agent-network/issues/1281)
2. **停止后丢失子节点记录**：daemon 在成功停止子节点时就删掉了内部记录，
   随后的 `delete_node` 报 `child not in map` 并不做任何事，Hub 侧不收敛。
   → [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

---

## 四、这张表怎么维护

1. **改一格必须带证据链接**（issue / 测试报告 / PR）。
2. **新增 runtime 时，整列默认全 ❓**，逐格验证后再改；不要因为「它和 X 很像」就照抄 X 那一列。
3. runtime 清单以代码为准（`OK_RUNTIMES`，见 `deploy/fleet/anet-nodes-boot.sh`）。两者不一致时是本文档过期，请修文档。
