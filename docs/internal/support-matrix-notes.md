> 本文于 2026-09-25 从用户文档 `docs-site/docs/guide/support-matrix.md`（及英文版）移出：维护规则、优先级决定与取证记录，面向维护者，不面向用户。

# 支持矩阵：维护规则与取证记录（内部）

用户看到的矩阵在 `docs-site/docs/guide/support-matrix.md` / `docs-site/docs/en/guide/support-matrix.md`。
本文件保存从那两页移出的内容：状态记号的设计理由、维护规则、优先级决定、以及每一格背后的取证过程。

## 1. 状态记号的设计理由

- 表格是三态（✅ / ❌ / ❓），不是两态。一张只有 ✅/❌ 的表读起来像「全都查过了」，而真实情况通常是「查过一部分」。
  把没查过的画成 ❓，比猜一个答案填进去有用：读到 ❓ 的人知道要自己验一次；读到一个猜出来的 ✅ 的人不会。
- ✅ 要带强度（L3 进 CI / L2 真机不进 CI / L1 只跑过 happy path）。同样是 ✅，可靠性可以差两个量级。
  裸 ✅ = 没人标注强度，按 L1 读。
- 2026-09-25 用户页改版只改表述、不改任何格子的记号（以 #2012 合入后的页面为基线）。
  图例里补了 ⚠️ 与 — 的说明（页面正文一直在用，但原图例只列了三态）。
- 从用户页移出的读数细节：各读数的日期（大多为 2026-08-28）、具体 preview 版本号、macOS 验收表的「判据」列、
  #1301 链接、`claude-code-cli` 日志修复的实现方式（stdio proxy 双写）与「随 2026-08-28 的 preview 批次发布」。
  这些都在下面第 4 节。

## 2. 维护规则

1. 改一格必须带证据链接（issue / 测试报告 / PR）。没有证据的状态变更等于把猜测洗成事实。
2. 优先把 ❓ 变成 ✅/❌，而不是把 ❌ 变成 ✅。知道「哪些不行」比「多一个行」更能减少踩坑。
3. 新增 runtime 时整列默认全 ❓，逐格验证后再改。不要因为「它和 X 很像」就照抄 X 那一列 ——
   原表里至少三处不同正是这么产生的。
4. runtime 清单以代码 `OK_RUNTIMES`（`deploy/fleet/anet-nodes-boot.sh`）为准，不以文档为准。两者不一致时是文档过期。
5. 用户页不写带 preview/latest 字样的具体版本号：任何 `x.y.z-preview.N` 都会被
   `.github/scripts/check-release-channel-assertions.py` 判成信道断言，要求在 `docs/RELEASE-SOP.md` 登记。
   版本相关的取证记录放在本文件。

## 3. 优先级决定

- Vincent 2026-08-28 定：优先支持 `codex` 系与 `grok` 系。表里同等标注，但排期上这两族优先。
- Vincent 2026-08-28 定：Windows 先不支持。Windows 那几格的 ❌ 因此不排期；但「不支持的平台在 UI 上看起来可用」
  （Windows daemon 在线、Dashboard「选服务器」可选、创建静默失败，hub 收到 `ok:true` + request_id 后无下文）
  不随之消失，需要单独解决（能力上报带平台 / UI 过滤 / 失败可见）。
  「不支持某个平台」是一个决定；「不支持的平台在 UI 上看起来可用」是一个缺陷。

## 4. 取证记录

### 4.1 脚注 ^1^：daemon 建不出三个 TUI 共存 runtime（2026-08-28）

脚注原文曾说「卡在三道闸，其中 `create-node-daemon.ts` 里的 `VALID_RUNTIMES` 是写死的常量，运维改配置也绕不过」。
当天逐处读 `origin/main` 后更正：实际是四道，其中三道已开：

| # | 位置 | 当天内容 | 阻不阻这三个 |
|---|---|---|---|
| ① | `server/src/create-node-validate.ts` `RUNTIMES` | 3 个 | 阻，而且排最前 |
| ② | `agent-network/src/normalize-runtime.ts` `SUPPORTED_RUNTIME_NAMES` | 7 个全在 | 不阻 |
| ③ | `agent-node/src/runtime/create-node-daemon.ts` `VALID_RUNTIMES` | 7 个全在 | 不阻 |
| ④ | daemon 的 `allowedRuntimes`（来自 config） | 运维可配 | 取决于配置 |

这张表是 2026-08-28 的快照，① 已不成立：#1298 把 `RUNTIMES` 从 3 个放开到 7 个（含 `opencode-cli`），
#1301 把三处分叉的运行时清单收敛到同一份。
当天实测（macOS daemon）：`codex-app-server` 返回
`{"ok":false,"error":"runtime_invalid","value":"codex-app-server"}`，目标机器 daemon 日志一行都没有 ⇒ hub 那道先响，
请求根本没到机器。判据是返回带 `value` 字段 —— `runtime_invalid` 在仓里有两个来源：

| 位置 | 抛法 | 返回带 `value` 吗 |
|---|---|---|
| hub `server/src/create-node-validate.ts` `validateRuntime` | `ValidationError("runtime_invalid", { value })` | 带 |
| daemon `agent-node/src/runtime/create-node-daemon.ts` `VALID_RUNTIMES` 检查 | `throw new Error("runtime_invalid")` | 不带 |

所以当时只修 `create-node-daemon.ts` 过不去，两道闸都要改。同一台机器上 `codex-sdk` 创建成功
（spawn 四行验证 + hub 注册 + 删除全链）作为对照。

#2012 已把用户页这三格从 ❌ 改为 ❓（「放开后未端到端重测」）。
下一步：在 Linux / macOS daemon 上各跑一次这三个 runtime 的 `create_node`，按结果改格并附证据。

产品问题（放开常量之前要先答）：这三个 runtime 的本质是「人和 agent 共用一个 TUI 会话」，daemon 建出来的是无人值守后台进程，
建出来给谁用？放开常量只让请求走到 daemon，不等于那个节点能用。#1298 的评论里对此有一半量化（共存类节点在舰队里的回复量）。

### 4.2 脚注 ^2^：`claude-code-cli` 无节点层日志

`claude-code-cli` 模式下 Claude Code 以 in-process channel 承载 commhub，`agent-node` 进程从来没被启动过 ——
节点层日志是 agent-node 写的。`~/.claude/projects/<slug>/*.jsonl` 是模型会话层，一条任务收发事件都没有。
修复为 stdio proxy 把日志双写进 `.anet/nodes/<alias>/logs/`，随 2026-08-28 的 preview 批次发布（#1345）。#2012 把这一格从 ❌ 改为 ❓（未重测）。

### 4.3 脚注 ^3^：飞书

只在 `claude-agent-sdk` 上验过，其余六个没有。这不是「不支持」，是「不知道」 —— 分母还没建立。见 #1259。

### 4.4 脚注 ^4^：opencode 坏结果记成成功

opencode 节点把未执行的 `<tool_call>` 原文当作任务结果返回，hub 记 `failed=false`。按状态/计数看板的视角完全看不见。
同一条检查缺口在 `processTask` 的通用路径上，可能不止 opencode（待验）。见 #943。

### 4.5 脚注 ^5^ / ^7^：Windows daemon 两个独立根因

- ^5^ `create-node-daemon.ts` 的 `loadAndVerifyAnetBin` 要求 `pin.abs.startsWith("/")`，Windows 绝对路径 `C:\...` 永远不以 `/` 开头
  ⇒ 必然 `anet_bin_unsafe_path`。当时全文件 `process.platform` 命中 0。紧接着的三条检查在 Windows 上要么假阳
  （`realpathSync` 遇 junction/短路径），要么形同虚设（`st.uid !== 0` 在 Windows 上 uid 恒为 0；`st.mode & 0o022` 不反映 ACL）。
  见 #1290（已关闭，关闭说明为「Windows 先不支持，降级不排期」）。
- ^7^ Windows 上外部启动器全是 `.cmd`，`spawnSync` 直接 ENOENT/EINVAL（8 处调用，`shell:true` 0 次）。
  与 ^5^ 不同源：一个是路径判据的 POSIX 假设，一个是 Windows 进程模型。两条都修完 Windows 才有 daemon。修复 PR #1137 于 2026-08-29 合入，
  #2012 把这一格从 ❌ 改为 ❓（未重测）。

### 4.6 脚注 ^8^：Windows Codex 共存 CI 间歇失败

约 8% 基率，签名固定。见 #1342。

### 4.7 daemon 生命周期真机验收（2026-08-28，Linux）

在一台 Linux daemon 节点 + 生产 hub 上跑 `scripts/daemon-live-acceptance.sh --execute`：查看 / 创建 / 编辑 / 重启 / 停止 全 ✅，删除 ⚠️。

删除为什么记 ⚠️ 而不是 ✅ 或 ❌：

- 2026-08-28 上午（`agent-node@2.5.0-preview.39`）：100% 复现卡住 —— daemon 日志每次停在 `backed up child workdir`，
  之后零输出，hub 行永远停在 `lifecycle_state=deleting`。
- 2026-08-28 中午（`agent-node@2.5.0-preview.40`，同一台机器）：同样的复现跑三遍 3/3 成功，七行时间线走完，hub 行全部消失。

但这不等于「已修复」，因为同时动了两个变量：

| 变量 | 变化 |
|---|---|
| 代码 | `.39` → `.40`（埋点 + `execSync` 加 `timeout`/`maxBuffer`） |
| 进程 | daemon 重启过，重启时补上了 `ANET_BIN_ABS` / `ANET_DAEMON_ALLOW_ENV_BIN` |

而且这是会自己好的症状 —— 重启之后测，结构上偏向全绿。「重启后不复现」和「代码改对了」在这三次读数里长得一样。
所以当时记「`.40` 上三次未复现，成因未定位」。

后续：#1286 于 2026-08-29 关闭，关闭评论称在 `origin/main` 上修复 / 单测 / E2E 三层齐全。用户页 Linux 删除格仍为 ⚠️，
说明为「修复已合入，Linux 未在修复后版本上重新验证」。下一步：在 Linux daemon 上重跑 `daemon-live-acceptance.sh`，通过后改 ✅ 并附报告。

删除失败的两个独立原因（当时均已定位）：

1. 参数名分叉：`delete_node` / `stop_node` 用 `child_node_id`，`restart_node` / `update_node_config` 用 `node_id`，传错直接 `-32602`。
   见 #1281（已关闭）。2026-09-25 核 `origin/main`：`server/src/node-id-alias.test.ts` 表明五个生命周期工具现在同时接受
   `node_id` 与 `child_node_id`，所以这条（#2012 后仍在用户页「当时定位到的两个删除失败原因」里）已从用户页删除。
2. 停止即忘：daemon 在成功停止子节点时就删掉 `childrenMap` 条目，随后的 `delete_node` 报 `child not in map` 并 no-op，hub 不收敛。
   日志里的 `(likely daemon-restarted)` 是误导 —— daemon 根本没重启。见 #1286。

### 4.8 macOS 上的 daemon（2026-08-28）

macOS 26.3.1 + `agent-node@2.5.0-preview.40` + 生产 hub，逐个跑完。判据都不是 `create_node` 返回的 `ok:true`：

| 操作 | 状态 | 判据 |
|---|---|---|
| daemon 在线（注册 / SSE connected） | ✅L2 | hub 侧 `11:34:27 SSE ← daemon-<host> connected` |
| 创建 `create_node` | ✅L2 | daemon 日志四行：`wrote child config` → `spawned pid=…` → `post-spawn kill-0 verify OK` → `+5000ms capability check OK`；hub 侧子节点注册报活 |
| 编辑 `update_node_config` | ✅L2 | 节点侧真实文件 `~/.anet/nodes/<alias>/config.json` 里 `model` 真的变了 —— 不是 hub 的 `config_revision` 0→1 |
| 重启 `restart_node` | ✅L2 | `ok, apply_mode=restart_only` |
| 停止 `stop_node` | ✅L2 | 四行埋点 + 进程消失 |
| 删除 `delete_node` | ✅L2 | `delete without map entry (expected after stop)` → `backed up child workdir` → hub 行 `node_not_found`，原目录已移走 |

删除走的是「stop 之后再 delete」—— 正是 #1286 最初报的路径，在 macOS + `.40` 上一次通过。

另一条读数：`residual sweep` 埋点在 macOS 上也正常打出。那段用 `pgrep -af` + `/proc/<pid>/cmdline`，而 macOS 没有 `/proc`。
它没炸，说明错误处理在 macOS 上有效（走 catch 后正常返回，不阻断 ack）。

macOS × Runtime（按 codex 优先的决定跑）：

| runtime | daemon 创建节点 | 判据 |
|---|---|---|
| `claude-agent-sdk` | ✅L2 | 上表六步全通 |
| `codex-sdk` | ✅L2 | spawn 四行验证 + hub 注册报活 + 删除全链（`ack accepted action=delete`） |
| `codex-app-server` | 当时 ❌，#2012 后记 ❓ | `runtime_invalid` 带 `value`，daemon 日志一行都没有（见 4.1）；该限制此后已放开，未重测 |

### 4.9 daemon 重启静默失去建节点能力（2026-08-28，Linux + macOS 各撞一次）

```text
← SSE create_node cr_…
[WARN] anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

用干净的 `anet daemon start` 重启后，daemon 照常注册、在线、收 doorbell，hub 返回 `ok:true`，但一个节点也建不出来 ——
依赖的 `ANET_BIN_ABS` 等变量没有落盘，重启就丢。所有面向调用方的信号都说成功。
落盘做法是 `path.conf`；`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS=<realpath>` 是 Docker/dev/manual-ops 的便利路径，重启不会自动带上。
同一天在 Linux 上先栽过一次：daemon 注册、在线、收到 doorbell，而 `create_node` 一路失败，只在它自己的日志里报错。
所以表里「daemon 在线」和「daemon 能创建节点」必须分两行。

## 5. 与门 / 登记表的关系

- `docs/RELEASE-SOP.md` 逐次发版重核表里 support-matrix 的两行（行号 49，内容「脚注 ^1^ 钉了已发布产物
  `@sleep2agi/agent-node@2.5.0-preview.34` 里 grep 复核」）在改版前就已过期：页面里早已没有那句话，
  #2012 合入后被门扫中的是页面第 110 / 112 / 118 行（`2.5.0-preview.39/.40`）。改版后的用户页不含任何 `x.y.z-preview.N` / latest 版本号，
  这两行登记应随用户页改版一并删除。本文件在 `docs/` 下，不在该门的扫描范围（`docs-site/docs/**`）内。
- `docs-site/docs/guide/runtimes.md` / `en/guide/runtimes.md` 第 3 行说支持矩阵「每一格都带证据链接」，
  改版后证据集中在本文件与各 issue，需同步改写那句话。

## 相关

- 用户页：https://github.com/sleep2agi/agent-network/blob/main/docs-site/docs/guide/support-matrix.md
- #1298 https://github.com/sleep2agi/agent-network/issues/1298 ·
  #1301 https://github.com/sleep2agi/agent-network/pull/1301 ·
  #1286 https://github.com/sleep2agi/agent-network/issues/1286 ·
  #1281 https://github.com/sleep2agi/agent-network/issues/1281 ·
  #1290 https://github.com/sleep2agi/agent-network/issues/1290 ·
  #1137 https://github.com/sleep2agi/agent-network/pull/1137 ·
  #1345 https://github.com/sleep2agi/agent-network/issues/1345 ·
  #1259 https://github.com/sleep2agi/agent-network/issues/1259 ·
  #943 https://github.com/sleep2agi/agent-network/issues/943 ·
  #1342 https://github.com/sleep2agi/agent-network/issues/1342
