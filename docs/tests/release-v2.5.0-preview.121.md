# agent-node 2.5.0-preview.121

自 `.120`（发版合并 `03710452`，#2466）以来，`agent-node/` 有 3 个改动（`git log 03710452..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| b56f8dd0 | #2456 | #612：同机启动限流。codex app-server 启动前过「启动门」，内存 / 负载不够时排队；等满上限后改为一次只放一个，不再整批放行 |
| 6993569b | #2465 | #673：Claude 地区限制 / 权限不足的 403 不再提示「刷新 API key」；真实 Hub 上跑 processWithClaude 的测试 |
| 8a816fdd | #2467 | #671：机器重启后，收编的 codex 共存节点只做无信号的缺席检查，不拿旧 PID / marker 去停进程 |

（同期合入、不在本包里的：#2467 的 anet 部分（`.hub-resumed` 收据）和 `deploy/fleet/anet-nodes-boot.sh` 随 agent-network `2.3.0-preview.153`；Hub 只改了一行读接口，要等 commhub-server 下一次发版。）

补记：#2464（`aa886493`，#659 A：codex 收编的启动输入与前置检查，以及 tmux 最后一个 pane 退出时的竞态修复）在 `.120` 的发版提交之前就已合入，已随 `.120` 发布，但 `.120` 的说明里没有写。

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。** 从 `.120` 起，节点上报 working 时带整条任务正文（最长 10000 字）；Hub 端要有 #2460，才会只把前 200 字存进 `sessions.task`。当前 preview Hub `0.9.0-preview.110` 及更早的版本会把整条正文存进去，get_all_status 和完整的 `/api/status` 都能读到。
- **低内存机器上，节点启动会变慢，但不会再直接失败。** 可用内存低于 min(4 GiB, 内存总量的 15%)，或者负载过高时，app-server 会排队；等满上限（`ANET_START_GATE_MAX_WAIT_SEC`）后改为一次只启动一个。容器里按 cgroup 的内存上限算，`inactive_file` 不计入已用。设 `ANET_START_MEM_GATE=0` 关闭这道门。
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。

## 你会看到的变化

- **同机启动限流（#2456，#612）。** 本节点自己拉起 codex app-server 时先过启动门（anet 拉起的 `-appsrv` 用的是同一道门，见 agent-network `.153`）：
  - 同一台机器上的启动通过文件锁 + 租约排队。锁文件写入时就带着 pid，空文件不会被当成死锁删掉；租约会过期，记录 pid 和进程启动时间，防止 pid 被复用。
  - 等满上限后改为单路放行，日志里会出现 `[start-gate] …: 已超时，按单路放行`；卡死的租约会被一个等待者接管（`接管卡死租约`），不会整批一起起。
  - 可调参数：`ANET_START_MAX_CONCURRENT`、`ANET_START_MIN_MEM_MB`、`ANET_START_MAX_LOAD_PER_CPU`、`ANET_START_GATE_MAX_WAIT_SEC`、`ANET_START_LEASE_TTL_SEC`；`ANET_START_MEM_GATE=0` 关闭。
- **Claude 403 的提示更准（#2465，#673）。** 地区限制（request not allowed）和权限不足（does not have permission）的 403 只显示厂商原因，回复末尾改成「see agent-node log for the vendor reason」，不再让人去刷新 key；401 和写着 revoked 的 403 仍然提示刷新 key。
- **收编节点在机器重启后的恢复边界（#2467，#671）。** 重启后，旧的 `boot_id`、PID 和 marker 不能再用来授权停止进程。daemon 只做不发信号的缺席检查：对应的 tmux 会话，以及同 uid 下带旧 marker 或使用同一个 `CODEX_HOME` 的进程都不在，才回报「已停止」；只要有残留或新一代进程，就返回 `adopt_codex_readopt_required`，需要重新收编。读不到证据时仍然拒绝，不按名字清扫。

## 与 Hub 的配合

- 启动限流、403 提示、重启恢复：不需要升级 Hub。
- `sessions.task` 只存 200 字预览：需要带 #2460 的 commhub-server（尚未发布），同 `.120`。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.121
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.153 @sleep2agi/agent-node@2.5.0-preview.121
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.153 ↔ agent-node@2.5.0-preview.121`）。
- 发布顺序：先 agent-node `.121`，再 agent-network `.153`，两者来自同一个合并提交。

## 证据

- #2456：`tests/test612-start-admission/`（Docker，512 MiB 容器跑真实启动门；16 个独立进程争锁的竞态测试；把超时后改回整批放行，14 个启动重叠，套件变红）；`agent-node/src/runtime/codex-app-server/start-resource-gate.test.ts`。
- #2465：`tests/qa-board673-claude-process-auth/`（Docker，一次性 Hub + 真 cli.ts；三条绕过静态锚点的变异都让 Hub 回复变红）。
- #2467：`tests/test658-codex-adopt-stop/recovery.test.ts`、`http-e2e.ts`（真实 Hub）；报告 `docs/tests/report-board671-adoption-recovery.txt`。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.121"`
