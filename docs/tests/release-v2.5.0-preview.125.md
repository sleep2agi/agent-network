# agent-node 2.5.0-preview.125

自 `.124`（发版合并 `bc5f547d`，#2495）以来，`agent-node/` 有 1 个改动（`git log bc5f547d..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| b807d29d | #2480 | codex 共存大会话恢复：bridge 端按 rollout 大小设有限的 WebSocket `maxPayload`、连接断开时立即让在途请求失败、默认恢复期限 300 秒、新 TUI 线程等 rollout 落盘才算数、启动闸门租约续租 + 内存不足 WARN；新增依赖 `ws` |

（同期合入、不在本包里的：#2497 是 agent-network `.156` 发版；#2496 只改官网下载页；#2480 的 anet 部分（Linux 恢复阶段内存闸门、恢复期限按 rollout 大小推算、`--new-session`、`config.env` 传递、恢复点备份）随 agent-network 下一次发版。）

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。**
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- 本版新增运行时依赖 `ws`（`^8.22.0`），`npm i -g` 会一起装上。
- 默认恢复期限从 120 秒改为 300 秒（`ANET_CODEX_RESUME_TIMEOUT_MS` 仍可覆盖）：恢复真的失败时，节点报离线前会多等一些时间。

## 你会看到的变化

### bridge 接收大恢复响应有上限（#2480）

- bridge 连 codex app-server 时按要恢复的 rollout 大小设接收上限：`2 × rollout + 64 MiB`，夹在 128 MiB 到 1536 MiB 之间；可用 `ANET_CODEX_RECOVERY_MAX_PAYLOAD_BYTES` 指定（超出范围的值不采用）。同时关闭 `perMessageDeflate`。
- 这只保护接收端 Node 进程。codex 自己生成完整的旧版响应帧时的内存不受它限制，那部分由 anet 的恢复阶段内存闸门负责（随 agent-network 下一次发版）。

### bridge 死掉时立即报清楚的错（#2480）

- WebSocket 连接断开时，除了发出连接错误，还会立刻让所有在途 JSON-RPC 请求带同一个错误失败，不再等到各自超时；也不会退回 `thread/start` 新开线程。

### 恢复期限与新线程落盘（#2480）

- 默认 `thread/resume` 期限 120 秒 → 300 秒；同一期限用于等待共存 TUI 新线程。
- 新 TUI 线程的 RPC 成功不再直接算数：要等节点 `CODEX_HOME` 里对应的 rollout 文件真的出现，才把它当成可恢复会话；超时报错会写出实际期限和 `ANET_CODEX_RESUME_TIMEOUT_MS`。

### 启动闸门租约续租、内存不足明确告警（#2480）

- app-server 启动闸门的槽位租约在持有期间每 30 秒（或 TTL/3）续租一次，健康的长时间工作不会因租约到期被别人顶掉；持有进程被 SIGKILL 后，租约在一个 TTL 内可被接管。
- 等满上限仍不满足内存要求时，照旧只放行一个，但会打 WARN，写明当前可用内存、需求量和 OOM 风险。

都不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.125
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.125
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 源码里的配对 `PAIRED_AGENT_NODE_VERSION` 已移到 `.125`；已发布的 agent-network `2.3.0-preview.156` 仍配对 `.124`，配对本版的是随后的 agent-network `2.3.0-preview.157`。

## 回滚

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.124
```

再重启 daemon 和节点。回滚后 bridge 接收大响应不再有有限上限、连接断开时在途请求要等各自超时，默认恢复期限回到 120 秒。

## 证据

- #2480：`tests/test1178-codex-upgrade-recovery/`（Docker `--cpus=2`；agent-node bridge/resume 单测 93/93；真实 Node 22 + codex 0.133 恢复 256 MiB rollout 42.1 秒，把上限改成 100 MiB 时变红；去掉 payload 上限、断开后退回 `thread/start`、关掉租约续租等变异都变红），报告见 `docs/tests/report-test1178-codex-upgrade-recovery.txt`；`agent-node/src/runtime/codex-app-server-client.test.ts`、`codex-app-server-bridge.test.ts`、`codex-app-server/resume-timeout.test.ts`、`codex-app-server/start-resource-gate.test.ts`。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.125"`
