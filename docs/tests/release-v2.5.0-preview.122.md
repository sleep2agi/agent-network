# agent-node 2.5.0-preview.122

自 `.121`（发版合并 `c0697512`，#2469）以来，`agent-node/` 有 2 个改动（`git log c0697512..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| eb39ca6a | #2479 | #686：启动门放宽默认负载门槛，状态按实际原因区分 |
| 1e92587e | #2483 | #705：codex 共存桥的输出管道断开（EPIPE）后，agent-node 不再退出 |

（同期合入、不在本包里的：#2473 的 Hub 端令牌属主校验随 commhub-server；anet 端的提示随 agent-network `2.3.0-preview.154`。）

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。** Hub 端要有 #2460，才会只把任务正文的前 200 字存进 `sessions.task`。
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。

## 你会看到的变化

### 启动门调整（#2479，#686）

- codex app-server 的默认高负载门槛从 `2 × CPU 核数` 调整为 `4 × CPU 核数`；内存保护保持不变。16 核主机默认在 load1 超过 64 时等待；如需恢复旧的严格门槛，设置 `ANET_START_MAX_LOAD_PER_CPU=2`。
- 状态会明确区分「等待内存」「等待负载」「等待内存和负载」「等待资源探测」。资源恢复后，这四种状态都会恢复为进入启动门前的节点状态。
- `ANET_START_GATE_MAX_WAIT_SEC=600` 表示等待 600 秒后转成单路放行，不是总等待上限；单路仍须取得启动租约，避免批量重启把机器内存打满。

该改动不经过数据库，也不要求升级 Hub。

### 输出管道断开后桥不再退出（#2483，#705）

- codex 共存桥把 agent-node 的输出经 `tee` 写日志。以前 `tee` 一旦被杀，agent-node 写 stdout 时收到 EPIPE 直接退出，节点掉线。
- 现在 agent-node 忽略 stdout / stderr 的 EPIPE，正常日志改写到按日期命名的日志文件；致命错误和退出原因同步写入文件，不再依赖已经断开的输出流。
- 本版不调查、也不改动杀掉 `tee` 的那个进程。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.122
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.154 @sleep2agi/agent-node@2.5.0-preview.122
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.154 ↔ agent-node@2.5.0-preview.122`）；桥的 `tee -p` 改动在 agent-network 一侧。
- 发布顺序：先 agent-node `.122`，再 agent-network `.154`，两者来自同一个合并提交。

## 证据

- #2479：`tests/test612-start-admission/`（Docker，512 MiB cgroup，五条变异均变红）；报告 `docs/tests/report-test686-start-load-gate.txt`。
- #2483：`tests/test705-bridge-epipe/`（Docker，四条变异均变红）；`agent-node/src/process-survival-log.test.ts`；报告 `docs/tests/report-test705-bridge-epipe.txt`。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.122"`
