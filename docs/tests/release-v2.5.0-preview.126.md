# agent-node 2.5.0-preview.126

自 `.125`（发版合并 `f614906e`，#2498）以来，`agent-node/` 有 1 个改动（`git log f614906e..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| b72834c6 | #2501 | codex 版本混用防护（看板 #734）：rollout 是 paginated 格式而 codex < 0.145 时拒绝启动；resume 报 "missing an ordinal" 时解释原因和安全选项 |

（同期合入、不在本包里的：#2499 是 agent-network `.157` 发版；#2500 是 commhub-server `.114` 发版；#2501 的 anet 部分（共存启动器 POSIX + Windows、外部 app-server 节点 #630 的同款防护，经启动时同一份 `.env` / login shell 前导探测版本）随 agent-network 下一次发版。）

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。**
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- 🔴 本版起，**一个 codex 线程只用一个 codex 版本**：线程的 rollout 已由 codex >= 0.145 写成 paginated 格式时，agent-node 不会再用 < 0.145 的 codex 去启动 / 恢复它（会直接拒绝并说明怎么把节点指向新版 codex）。混用会让 codex 在旧版追加的行上永久拒绝该线程。

## 你会看到的变化

### 启动前检查 codex 版本与 rollout 格式（#2501）

- 只读：只读线程 rollout 的第一行（64 KiB 分块，最多 4 MiB），`codex --version` 结果缓存。
- rollout 是 paginated（`session_meta.history_mode = "paginated"`）且 codex < 0.145：拒绝启动，打印原因和如何指向新版 codex。
- 文件不存在、第一行解析不了、版本未知（只认 `codex-cli x.y.z` 这类 codex 自己的版本行，包装脚本自己的版本号不算）：只 WARN，照常启动。
- 接入点：自管 app-server（spawn 之前）、codex-sdk resume、codex-sdk 目标唤醒（goal wake；被拒时唤醒失败，不恢复也不重建线程）。
- 查找 rollout 的顺序与 codex 一致：先 `sessions/` 里最新的，`archived_sessions/` 只作后备。

### "missing an ordinal" 的诊断（#2501）

- resume 报 `final paginated rollout record at <path> is missing an ordinal` 时，打印原因、说明文件没被改动、给出安全选项（按 #734 fork 恢复，或经人决定后开新线程）和一条只读检查命令。
- 仍然 fail-closed；codex-sdk 路径在这种情况下不再静默重建新线程。

都不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.126
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.126
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 源码里的配对 `PAIRED_AGENT_NODE_VERSION` 已移到 `.126`；已发布的 agent-network `2.3.0-preview.157` 仍配对 `.125`，配对本版的是随后的 agent-network `2.3.0-preview.158`。

## 回滚

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.125
```

再重启 daemon 和节点。回滚后不再有启动前的 codex 版本 / rollout 格式检查，"missing an ordinal" 也不再有解释，codex-sdk 路径遇到它会回到旧行为。

## 证据

- #2501：`tests/test734-codex-paginated-rollout-guard/`（Docker `--cpus=2`；真实 codex 0.133.0 / 0.159.2、真实自管 app-server 与真实 `anet node start`、300 MB rollout 内核实读 < 1 MiB 仍能拦下、真实 0.159.2 在混合 rollout 上的失败；变异 M1–M10 均变红；PASS=38 FAIL=0），报告见 `docs/tests/report-test734.txt`；`agent-node/src/runtime/codex-rollout-history-guard.test.ts`、`agent-node/src/goals/codex-wake.test.ts`。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.126"`
