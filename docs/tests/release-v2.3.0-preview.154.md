# agent-network 2.3.0-preview.154

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.154`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.122`（见 [`release-v2.5.0-preview.122.md`](./release-v2.5.0-preview.122.md)）。

自 `.153`（发版合并 `c0697512`，#2469）以来，`agent-network/` 有 3 个代码改动（`git log c0697512..<发版提交> -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 0a2ebe49 | #2473 | #678：`anet doctor` 重新签发节点令牌被 Hub 以 `node_owner_unclaimed` / `node_owner_mismatch` 拒绝时，说明原因并提示找管理员认领，不再暗示自动认领；CLI 直连库重置管理员密码时写入令牌的 `node_identity_epoch` |
| eb39ca6a | #2479 | #686：anet 自带的启动门与 agent-node 同步放宽负载门槛、按原因区分等待状态（两份代码逐字节一致） |
| 1e92587e | #2483 | #705：codex 共存桥写日志改用 `tee -p`，日志进程死掉不再关掉 agent-node 的 stdout |

（`.153` 之后同期合入、不在 anet 里的：#2470、#2477、#2475、#2478 只改 Hub 或测试；#2476 只改官网。）

## 🔴 升级须知

- 🔴 **#678 的令牌属主校验在 Hub 端**（commhub-server），不要把新 Hub 回滚到旧的签发器。anet 这边只改了被拒时的提示。
- 启动门默认负载门槛从 `2 × CPU` 放宽到 `4 × CPU`；要恢复旧门槛设 `ANET_START_MAX_LOAD_PER_CPU=2`。
- （沿用 `.153`）开机脚本要和 CLI 一起更新；（沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。

## 你会看到的变化

- **共存桥在日志管道断开后存活（#2483，#705）。** 桥用 `tee -p` 写日志，配合 agent-node `.122` 忽略 EPIPE，节点不会因为日志进程被杀而掉线。需要重启共存节点才会用上新的桥命令。`tee -p` 只在 GNU tee 上启用（先探测）；macOS / BusyBox 上仍靠 agent-node 一侧的 EPIPE 防护。
- **启动门状态更准（#2479，#686）。** `[anet] [start-gate]` 的等待状态区分「等待内存」「等待负载」「等待内存和负载」「等待资源探测」。
- **令牌重新签发被拒时的提示（#2473，#678）。** `anet doctor` 对 `node_owner_unclaimed` / `node_owner_mismatch` 给出中文说明，不会自动认领或覆盖令牌。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.154 @sleep2agi/agent-node@2.5.0-preview.122
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.154 @sleep2agi/agent-node@2.5.0-preview.122
```

两个包一起升级（`agent-network@2.3.0-preview.154 ↔ agent-node@2.5.0-preview.122`）。

## 证据

- #2483：`tests/test705-bridge-epipe/`（Docker）、`agent-network/src/codex-copresence-bridge-log.test.ts`。
- #2479：`tests/test612-start-admission/`、`agent-network/src/start-resource-gate-sync.test.ts`。
- #2473：`tests/test678-daemon-token-owner/`；报告 `docs/tests/report-test678.txt`。
- 未在真实生产节点 / daemon 上验证。
