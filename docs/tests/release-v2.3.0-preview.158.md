# agent-network 2.3.0-preview.158

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.158`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.126`（见 [`release-v2.5.0-preview.126.md`](./release-v2.5.0-preview.126.md)）。

自 `.157`（发版合并 `089ab633`，#2499）以来，`agent-network/` 有 1 个代码改动（`git log 089ab633..<发版提交> -- agent-network/`；另有 #2503 只移动配对版本号）：

| 提交 | PR | 内容 |
|---|---|---|
| b72834c6 | #2501 | codex 版本混用防护（看板 #734）：rollout 是 paginated 格式而 codex < 0.145 时拒绝启动共存 / 外部 app-server 节点；"missing an ordinal" 时解释原因；启动命令不变，版本经启动时同一份 `.env` / shell 前导探测 |

（同期合入、不在本包里的：#2501 的 agent-node 部分随 agent-node `.126`（见其说明）；#2501 里 `qa.yml` 和 `tests/test734-*` 只影响 CI；#2502 只改 Hub（`server/`）；#2500 是 commhub-server `.114` 发版。）

## 🔴 升级须知

- 🔴 （沿用 `.154`）不要把新 Hub 回滚到旧的签发器（#678）。
- （沿用 `.153`）开机脚本要和 CLI 一起更新；（沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- 🔴 本版起，**一个 codex 线程只用一个 codex 版本**：线程的 rollout 已由 codex >= 0.145 写成 paginated 格式、而节点实际会启动的 codex < 0.145 时，`anet node start` 直接拒绝（退出码非 0），并说明怎么把节点指向新版 codex。旧版 codex 一旦往这种 rollout 里追加，新版 codex 会永久拒绝这个线程。

## 你会看到的变化

### 启动前检查 codex 版本与 rollout 格式（#2501）

- codex 共存启动器（POSIX 和 Windows）在停掉上一代进程**之前**检查：已记录的线程和 pending 线程都查。
- 外部 app-server 节点（#630）同样检查。
- 只读：只读 rollout 第一行（64 KiB 分块，最多 4 MiB）；`codex --version` 结果缓存。只认 codex 自己的版本行（`codex-cli x.y.z`），包装脚本自己的版本号（如 `nvm 0.39.7`）不算。
- 文件不存在、第一行解析不了、版本未知：只 WARN，照常启动。
- **启动命令和以前逐字节相同。** 版本探测走和启动同一份前导：共存在 POSIX 上用 `bash -lc`（login shell）；外部 app-server 先 source 工作区 `.env`、设 `NO_PROXY` 和 `CODEX_HOME` 再用 `bash -c`。所以探测到的就是实际会启动的那个 codex。
- `--new-session` 不检查旧线程（直接开新线程）。

### "missing an ordinal" 的诊断（#2501）

- 共存恢复报 `final paginated rollout record at <path> is missing an ordinal` 时，打印原因、说明文件没被改动、给出安全选项（按 #734 fork 恢复，或经人决定后开新线程）和一条只读检查命令。仍然 fail-closed。

### 配对 agent-node `.126`

- agent-node 侧对自管 app-server、codex-sdk resume 和目标唤醒做同样的检查与诊断。

都不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.158 @sleep2agi/agent-node@2.5.0-preview.126
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.158 @sleep2agi/agent-node@2.5.0-preview.126
```

两个包一起升级（`agent-network@2.3.0-preview.158 ↔ agent-node@2.5.0-preview.126`）。升级后重启 codex 节点（`anet node stop` / `anet node start`）才会生效。

## 回滚

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.157 @sleep2agi/agent-node@2.5.0-preview.125
```

再重启 daemon 和节点。回滚后启动前不再检查 codex 版本与 rollout 格式，旧版 codex 可能把 paginated 线程写坏。

## 证据

- #2501：`tests/test734-codex-paginated-rollout-guard/`（Docker `--cpus=2`；真实 codex 0.133.0 / 0.159.2、真实 `anet node start` 与外部 app-server；login-shell PATH 与 anet PATH 两个方向、`.env` PATH 与 anet PATH 两个方向、`--new-session`；300 MB rollout 内核实读 < 1 MiB 仍能拦下；真实 0.159.2 在混合 rollout 上 fail-closed 并给出诊断；变异 M1–M10 均变红；PASS=38 FAIL=0），报告见 `docs/tests/report-test734.txt`；`agent-network/src/codex-copresence-rollout-guard.test.ts`。
- 未在真实生产节点 / daemon 上验证。
