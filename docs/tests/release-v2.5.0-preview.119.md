# agent-node 2.5.0-preview.119

自 `.118`（发版合并 `e03a8640`，#2446）以来，`agent-node/` 有 2 个改动（`git log e03a8640..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| a5e4440c | #2449 | #652：daemon 建节点允许中文 / Unicode 节点名，节点目录保持 ASCII（Hub 部分随 commhub-server `0.9.0-preview.110`） |
| 652f856e | #2451 | #656：模型临时满载自动重试（30 / 60 / 120 秒退避，最多 3 次），本轮已执行过工具就不重试，5xx 判定收紧 |

（同期合入、不在本包里的：#2447 / #2450 只改 Hub，已随 commhub-server `0.9.0-preview.110`；#2452 / #2453 只改文档。）

## 🔴 升级须知

- 🔴 （沿用 `.117`）**升级前先配 `daemonExtraPath`。** 如果这台机器上的 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录，也不在系统目录，要先把这些命令所在目录的绝对路径写进该 daemon 节点 `config.json` 的 `daemonExtraPath`（字符串数组），然后重启 daemon。否则从 app 建这几种节点会被直接拒绝。
- 🔴 （沿用 `.116`）节点只读权限为 `0600` 的 `<节点目录>/secrets.env`：是符号链接、属主不是当前用户或权限不是 `0600` 时节点拒绝启动。修法：`chmod 600 <节点目录>/secrets.env`。
- （沿用 `.118`）收编默认关闭：daemon 节点 `config.json` 的 `adopt_roots` 默认为空，空列表拒绝一切收编。
- （沿用 `.118`）收编节点的 restart 被 Hub `0.9.0-preview.109` 起拒绝（`adopted_restart_requires_daemon`），请先「停止」再「启动」。
- 中文节点名要 Hub 和 daemon 都升级：Hub 需 commhub-server `0.9.0-preview.110`，daemon 需本版 agent-node 并重启 daemon。只升一边时，中文名会被拒（`node_name_invalid`），英文名不受影响。

## 你会看到的变化

- **模型满载自动重试（#2451，#656）。** codex-app-server 为主；OpenCode 共存（v1 / v2）、OpenCode ACP、Grok ACP、Claude 认同一类错误。
  - 可重试：at capacity、overloaded、429、rate limit，以及带上下文的 5xx（`HTTP 5xx`、`status 5xx`、`5xx Service`，或 internal server error / bad gateway / service unavailable / gateway timeout）。
  - **5xx 判定收紧**：裸的 500 / 503 不再算（可能是端口或行号），`500ms` 这类时长不算。
  - 不重试：401 / 403、配额耗尽（insufficient quota、quota exceeded、usage limit、billing 等），这些仍走原来的失败路径。
  - 退避 30 秒、60 秒、120 秒，最多 3 次，同一模型、同一配置再提交。重试期间节点保持 working，任务文案「模型满载，第 n 次重试中」；3 分钟心跳在这期间也保持 working，不会翻回 idle。
  - 3 次都失败才 failed，回复「执行出错: 模型满载，已自动重试 3 次」，不带上游原文。
  - **本轮已经执行过工具**（命令、改文件、发消息、MCP 调用，或未知类型的工具项）**就不再自动重试**，回复「执行出错: 模型在执行中途出错，未自动重试，以免重复执行」。
  - 这段等待不算回复超时：codex 退避前停掉响应空闲计时；OpenCode 把退避时间加回回复期限，在 AbortSignal 外等待，不会 abort 共享会话。真超时仍按 #651（`.118`）判失败或中止。
  - Claude：以前 overload / rate limit 直接 fast-fail；现在先按上面规则重试，配额耗尽仍 fast-fail。
- **中文 / Unicode 节点名（#2449，#652）。** daemon 用与 Hub 相同的规则校验名字：Unicode 字母、数字、组合符号以及 `_` `-`，去首尾空白、NFC 后 1–64 个码点；拒绝开头 `-`、`/ \ : .`、空白、控制字符、引号、`$`、反引号、`;`，拒绝时返回 `node_name_invalid`。
  - 节点目录始终是 ASCII：旧规则能接受的名字，目录不变；其它名字优先用 app 向导里显示的文件夹名（`node_spec.workdir` 最后一段，如「测试」→ `ceshi`），没有可用 workdir 时用 `node-<6 位十六进制>`。
  - 目录已被另一个别名占用时拒绝（`node_dir_taken` / `workdir_has_other_node`）。
  - start / stop / delete / rebuild 先找别名目录、再找派生目录。已有节点不改名、不迁移。
  - 节点日志和 channel 状态默认写到 `config.json` 所在的节点目录，不再按别名另建目录。
  - 手工 `anet node create 测试`（CLI 路径）行为不变，仍会建 `.anet/nodes/测试/`。

## 与 Hub 的配合

- 中文节点名需要 Hub `0.9.0-preview.110`；Hub 新、daemon 旧时，daemon 以 `validate: node_name_invalid` 拒绝。
- 模型满载重试不需要升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.119
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.152 @sleep2agi/agent-node@2.5.0-preview.119
```

升级后 daemon 要重启（`anet daemon restart <名字>`）才会接受中文节点名。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.152 ↔ agent-node@2.5.0-preview.119`）。
- 发布顺序：先 agent-node `.119`，再 agent-network `.152`，两者来自同一个合并提交。

## 证据

- #2451：`tests/test656-capacity-retry/`（Docker）；`agent-node/src/runtime/capacity-retry.test.ts`、`codex-app-server/capacity-retry.test.ts`、`opencode-copresence/runtime.test.ts`。两条变异（把重试决策换成 give_up；去掉「本轮已执行工具」判断）都变红。
- #2449：`agent-node/src/runtime/node-name-652.test.ts`（中文名的 create / start / stop / delete，HOME 下所有路径为 ASCII）；`tests/qa-rfc026-create-node/` 场景 A.cn / A.cn2 / E1b（真实 Hub + 真实 daemon）。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.119"`
