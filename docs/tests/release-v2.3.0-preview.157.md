# agent-network 2.3.0-preview.157

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.157`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.125`（见 [`release-v2.5.0-preview.125.md`](./release-v2.5.0-preview.125.md)）。

自 `.156`（发版合并 `f300f7f9`，#2497）以来，`agent-network/` 有 1 个代码改动（`git log f300f7f9..<发版提交> -- agent-network/`；另有 #2498 只移动配对版本号）：

| 提交 | PR | 内容 |
|---|---|---|
| b807d29d | #2480 | codex 共存大会话恢复：Linux 恢复阶段单路内存闸门（租约续租、SIGKILL 后一个 TTL 内可接管、内存不足 WARN、非 Linux 告警）、恢复期限按 rollout 大小推算、恢复点备份失败默认拒绝启动、`--new-session` 生效、`config.env` 传入三个共存进程；新增依赖 `ws` |

（同期合入、不在本包里的：#2480 的 agent-node 部分随 agent-node `.125`（见其说明）；#2480 里 `qa.yml` / 测试 Dockerfile 的 build-arg 修正只影响 CI；#2496 只改官网下载页。）

## 🔴 升级须知

- 🔴 （沿用 `.154`）不要把新 Hub 回滚到旧的签发器（#678）。
- （沿用 `.153`）开机脚本要和 CLI 一起更新；（沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- 🔴 codex 共存启动在旧进程停止后先建私有恢复点；**备份失败时默认拒绝启动**并清掉半成品。只有接受无法安全回滚时才用 `--skip-recovery-backup` 跳过（会打印风险警告）。
- Linux 上大会话恢复要排队：同一台机器同时只恢复一个，并按 `max(4 GiB, 9 × rollout 大小)` 预留可用内存；一批节点一起重启会比以前慢。
- 本版新增运行时依赖 `ws`（`^8.22.0`）。

## 你会看到的变化

### 恢复阶段内存闸门（#2480）

- 旧版 codex 恢复时会把完整历史生成为一个大响应帧，内存峰值约为 rollout 的 8.4 倍（500 MiB rollout 实测峰值 4191 MiB）。现在 Linux 上恢复阶段走一条主机级单路：按 rollout 的 9 倍（最低 4 GiB）预留可用内存，不够就排队并打印原因；一直持有到 launcher、bridge、TUI 都完成精确线程绑定才释放。
- 持有期间每 30 秒续租，健康的长恢复不会被第二个节点顶进来；持有进程被 SIGKILL 后，租约在一个 TTL 内可被接管。
- 等满 600 秒仍不满足内存要求时，只放行一个恢复，并 WARN 当前可用内存、需求量和 OOM 风险。
- Windows / macOS 没有这道保护，启动日志会明确告警。

### 恢复期限按 rollout 大小推算（#2480）

- 共存 `thread/resume` 期限 = 300 秒 + 每开始 1 GiB rollout 加 120 秒，最高 15 分钟；`ANET_CODEX_RESUME_TIMEOUT_MS` 仍可覆盖（最大 900000）。bridge / TUI 就绪和 POSIX TUI 归属等待用同一个期限，不再是固定 15 / 25 秒。
- 恢复只校验线程元数据，不回退到 `thread/start` 新开线程。

### 其他（#2480）

- `--new-session` 在 Windows 和 POSIX 上都以它为准；新 TUI 线程在 rollout 真的落盘前只记为 pending，重启时没落盘的 pending 线程会被丢弃。
- `config.env` 里的值经 0600、读完即删的文件传给 app-server、bridge、TUI，不进 argv；保留键和 launcher 自己的键不能被覆盖。
- 恢复状态文件按块流式读写和哈希，保留稀疏 rollout 的空洞。
- **配对 agent-node `.125`。** bridge 端按 rollout 大小限制 WebSocket `maxPayload`；bridge 连接断开时在途请求立即带明确错误失败。

都不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.157 @sleep2agi/agent-node@2.5.0-preview.125
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.157 @sleep2agi/agent-node@2.5.0-preview.125
```

两个包一起升级（`agent-network@2.3.0-preview.157 ↔ agent-node@2.5.0-preview.125`）。升级后重启 codex 共存节点（`anet node stop` / `anet node start`）才会生效；Linux 上大会话节点会按内存闸门逐个恢复。

## 回滚

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.156 @sleep2agi/agent-node@2.5.0-preview.124
```

再重启 daemon 和节点。回滚后没有恢复阶段内存闸门，大会话一起恢复可能 OOM；恢复期限回到固定值。

## 证据

- #2480：`tests/test1178-codex-upgrade-recovery/`（Docker `--cpus=2`；agent-network 恢复 67/67、agent-node bridge/resume 93/93；真实 Node 22 + codex 0.133 恢复 256 MiB rollout 42.1 秒；500 MiB rollout 完整恢复 143 秒、cgroup 峰值 4191 MiB；绕过 POSIX 恢复闸门、关掉租约续租等变异都变红），报告见 `docs/tests/report-test1178-codex-upgrade-recovery.txt`；`agent-network/src/codex-recovery-resource-gate.test.ts`、`codex-copresence-resume-timeout.test.ts`、`codex-copresence-env.test.ts`、`codex-pending-thread-restart.test.ts`；`docs/tests/report-test535-codex-copresence-config-env.txt`。
- 未在真实生产节点 / daemon 上验证。
