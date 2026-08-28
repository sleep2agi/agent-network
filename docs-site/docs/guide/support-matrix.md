# 支持矩阵：哪个功能，在哪个 Runtime / 操作系统上能用

这一页回答两个问题：

1. **一个功能，在 7 个 runtime 上分别能不能用？**
2. **一台机器，装什么操作系统才能用哪些能力？**

## 🔴 先读这一段，否则你会误读这张表

**这张表有三种状态，不是两种：**

| 记号 | 含义 |
|---|---|
| ✅ | **验过，可用** —— 有实测证据，证据链接在脚注 |
| ❌ | **验过，不可用** —— 有实测证据说明它失败，且失败原因已知 |
| ❓ | **没验过** —— 我们不知道。**不是「可能可以」，也不是「大概不行」** |

### 🔴 `✅` 还要带强度，否则它是一个会被误读的符号

同样是 ✅，可靠性差两个量级。所以每个 ✅ 后面跟一个级别：

| 级别 | 含义 | 用户该怎么读 |
|---|---|---|
| **✅L3** | 有自动化套件，**进 CI**，回归会红 | 可以依赖 |
| **✅L2** | **真机验过**，有日志/报告存档，**不进 CI** | 能用，但回归无保护 |
| **✅L1** | 只跑通了 happy path，**没喂过错误输入** | 谨慎 —— 它只证明"顺着用不会坏" |

裸 `✅`（不带级别）= 这一格的强度还没人标注，**按 L1 读**。

🔴 **`❓` 是这张表最重要的一格。** 一张只有 ✅/❌ 的表读起来像「全都查过了」，
而真实情况通常是「查过一部分」。**把没查过的画成 ❓，比猜一个答案填进去有用得多** ——
因为读到 ❓ 的人知道要自己验一次；读到一个猜出来的 ✅ 的人不会。

**维护规则**：任何人把一格从 ❓ 改成 ✅/❌，**必须同时给出证据链接**（issue / 测试报告 / PR）。
没有证据的状态变更等于把猜测洗成事实。

## 优先级（Vincent 2026-08-28 定）

**优先支持 `codex` 系与 `grok` 系。** 表里同等标注，但排期上这两族优先。

---

## 一、功能 × Runtime

7 个 runtime 的完整清单以代码为准（`OK_RUNTIMES`，见 `deploy/fleet/anet-nodes-boot.sh`）：
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| 功能 | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| **CLI 直接创建节点**<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **daemon 代创建节点**<br>经 `create_node` | ✅ | ❓ | ✅ | ❌ ^1^ | ✅ | ❌ ^1^ | ❌ ^1^ |
| **TUI 人机共存**<br>人和 agent 共用一个会话 | — | — | — | ✅ | — | ✅ | ✅ |
| **节点层日志**<br>`.anet/nodes/<alias>/logs/` | ✅ | ❌ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| **飞书 IM 直聊** | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| **任务结果正确标记失败**<br>坏结果不会被记成成功 | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**脚注（每一条都是实测，不是读文档）**

- **^1^** 三个 TUI 共存 runtime 在 daemon 上一个都创建不出来，卡在三道闸，其中
  `create-node-daemon.ts` 里的 `VALID_RUNTIMES` 是**写死的常量**，运维改配置也绕不过。
  已在已发布产物（`@sleep2agi/agent-node@2.5.0-preview.34`）里 grep 复核，不是只看源码。
  → [#1298](https://github.com/sleep2agi/agent-network/issues/1298)
- **^2^** `claude-code-cli` 模式下 Claude Code 自己以 in-process channel 承载 commhub，
  **`agent-node` 进程从来没有被启动过** —— 节点层日志是 agent-node 写的，那个进程不存在。
  它的会话记录在 `~/.claude/projects/<slug>/*.jsonl`，但那是**模型会话层，一条任务收发事件都没有**，替代不了。
  → [#1345](https://github.com/sleep2agi/agent-network/issues/1345)
- **^3^** 飞书路径**只在 `claude-agent-sdk` 上验过**，其余六个都没有。
  🔴 这不是「不支持」，是**我们不知道** —— 分母还没建立。
  → [#1259](https://github.com/sleep2agi/agent-network/issues/1259)
- **^4^** opencode 节点把**未执行的 `<tool_call>` 原文**当作任务结果返回，
  且 hub 侧记为 `failed=false`（正常完成）。**按状态/计数看板的视角完全看不见它。**
  同一条检查缺口在 `processTask` 的通用路径上，**可能不止 opencode**（待验）。
  → [#943](https://github.com/sleep2agi/agent-network/issues/943)

---

## 二、操作系统 × 能力

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| **CLI 起节点**（`anet node start`） | ✅ | ✅ | ❓ |
| **daemon 创建节点**（任何 runtime） | ✅ | ✅ | ❌ ^5^ |
| **daemon 注册 / 在线 / 收 doorbell** | ✅ | ✅ | ✅ ^6^ |
| **外部启动器 / `anet hub start` / 自升级** | ✅ | ✅ | ❌ ^7^ |
| **TUI 共存（Codex）** | ✅ | ✅ | ❓ ^8^ |

**脚注**

- **^5^** `create-node-daemon.ts` 的 `loadAndVerifyAnetBin` 要求 `pin.abs.startsWith("/")`，
  而 Windows 绝对路径是 `C:\...`，**永远不以 `/` 开头** ⇒ 必然 `anet_bin_unsafe_path`。
  全文件 `process.platform` 命中数 **0**，没有任何平台分支。
  🔴 **而且不止这一条**：紧接着的三条检查在 Windows 上要么假阳（`realpathSync` 遇 junction/短路径），
  要么**形同虚设**（`st.uid !== 0` 在 Windows 上 uid 恒为 0；`st.mode & 0o022` 不反映 ACL）。
  → [#1290](https://github.com/sleep2agi/agent-network/issues/1290)
- **^6^** 🔴 **这一格是陷阱，不是好消息。** Windows 上的 daemon **可以注册、可以在线、可以收 doorbell，
  但永远创建不了节点**；hub 侧看它一切正常，Dashboard 的「选服务器」还会把它列为可选。
  用户选了它创建节点，只会在 daemon 日志里静默失败 —— **hub 收到的是 `ok:true` + request_id，之后无下文。**
  **「不支持某个平台」是一个决定；「不支持的平台在 UI 上看起来可用」是一个缺陷。**
- **^7^** Windows 上外部启动器全是 `.cmd`，`spawnSync` 直接 ENOENT/EINVAL（8 处调用，`shell:true` 出现 0 次）。
  与 ^5^ **不同源**：一个是路径判据的 POSIX 假设，一个是 Windows 进程模型。**两条都修完 Windows 才有 daemon。**
  → [#1137](https://github.com/sleep2agi/agent-network/issues/1137)
- **^8^** Windows Codex 共存有 CI 覆盖，但存在约 8% 的间歇失败，签名固定。
  → [#1342](https://github.com/sleep2agi/agent-network/issues/1342)

**Vincent 2026-08-28 定：Windows 先不支持。** 上表的 ❌ 因此不排期，
但 ^6^ 那个「看起来可用」的缺陷**不随之消失** —— 它需要单独解决（能力上报带平台 / UI 过滤 / 失败可见）。

---

## 三、daemon 生命周期操作（2026-08-28 真机验收实测）

在 `daemon-relay`（Linux）+ 生产 hub 上跑 `scripts/daemon-live-acceptance.sh --execute` 的结果：

| 操作 | 结果 |
|---|---|
| 查看（list nodes） | ✅ |
| 创建（`create_node`） | ✅ |
| 编辑（`update_node_config`） | ✅ |
| 操作（`restart_node`） | ✅ |
| 停止（`stop_node`） | ✅ |
| **删除（`delete_node`）** | **⚠️ 见下** |

### 删除这一格为什么不是简单的 ✅ 或 ❌

**2026-08-28 上午**（`agent-node@2.5.0-preview.39`）：100% 复现卡住 —— daemon 日志每次都停在
`backed up child workdir`，之后零输出，hub 行永远停在 `lifecycle_state=deleting`。

**2026-08-28 中午**（`agent-node@2.5.0-preview.40`，同一台机器）：**同样的复现跑三遍，3/3 成功**，
七行时间线完整走完，hub 行全部消失。

🔴 **但这不等于「已修复」，因为同时动了两个变量：**

| 变量 | 变化 |
|---|---|
| 代码 | `.39` → `.40`（埋点 + `execSync` 加 `timeout`/`maxBuffer`） |
| 进程 | daemon **重启过**，重启时补上了 `ANET_BIN_ABS` / `ANET_DAEMON_ALLOW_ENV_BIN` |

而且**这是一个会自己好的症状** —— 重启之后测，结构上就偏向全绿。
**「重启后不复现」和「代码改对了」在这三次读数里长得一模一样。**

所以这一格记 **⚠️「`.40` 上三次未复现，成因未定位」**，不记 ✅ 也不记 ❌。
→ [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

### macOS 上的 daemon（2026-08-28 实测）

| | 状态 | 依据 |
|---|---|---|
| daemon **在线**（注册 / SSE connected） | **✅L2** | Mac Mini 升到 `agent-node@2.5.0-preview.40` 并重启，hub 侧 `11:34:27 SSE ← daemon-macmini connected` |
| daemon 的**五个生命周期操作** | **❓** | **今天没在 macOS 上逐个跑过** |

🔴 **「daemon 在线」和「daemon 能干活」是两件事**，这两格必须分开。
同一天在 Linux 上就栽过一次：daemon 注册成功、在线、收到 doorbell，
而 `create_node` 一路失败，只在它自己的日志里报错。**别把上面那行的 ✅ 读成下面那行。**

**删除失败的两个独立原因，都已定位：**

1. **参数名分叉**：`delete_node` / `stop_node` 用 `child_node_id`，
   而 `restart_node` / `update_node_config` 用 `node_id`。传错直接 `-32602`。
   → [#1281](https://github.com/sleep2agi/agent-network/issues/1281)
2. **停止即忘**：daemon 在**成功停止**子节点时就删掉了 `childrenMap` 条目，
   于是随后的 `delete_node` 报 `child not in map` 并 no-op，**hub 侧不收敛**。
   🔴 日志里那句 `(likely daemon-restarted)` 是误导 —— daemon 根本没重启。
   → [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

---

## 四、这张表怎么维护

1. **改一格必须带证据链接。** 没有证据的 ✅ 和猜没有区别。
2. **优先把 ❓ 变成 ✅/❌，而不是把 ❌ 变成 ✅。** 知道「哪些不行」比「多一个行」更能减少踩坑。
3. **新增 runtime 时，整列默认全 ❓**，逐格验证后再改。
   🔴 不要因为「它和 X 很像」就照抄 X 那一列 —— 今天这张表里至少三处不同，正是这么产生的。
4. 表里的 runtime 清单以代码 `OK_RUNTIMES` 为准，**不以本文档为准**。
   两者不一致时是本文档过期，请修文档。
