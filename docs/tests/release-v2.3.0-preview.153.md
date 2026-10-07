# agent-network 2.3.0-preview.153

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.153`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.121`（见 [`release-v2.5.0-preview.121.md`](./release-v2.5.0-preview.121.md)）。

自 `.152`（发版合并 `6d21c1fc`，#2455）以来，`agent-network/` 有 3 个代码改动（`git log 6d21c1fc..<发版提交> -- agent-network/`；其中 #2466 只移动了配对）：

| 提交 | PR | 内容 |
|---|---|---|
| 70e88ff1 | #2458 | #667：`anet node start` 拉起的外部 app-server 桥改在工作区根目录启动（`--config` / `--log-dir` 仍是绝对路径），agent-node 不再误报「目录不一致」 |
| b56f8dd0 | #2456 | #612：anet 拉起 `-appsrv` 前过同一道启动门，替换原来「MemAvailable < 4 GiB 直接退出」的硬检查 |
| 8a816fdd | #2467 | #671：手动成功启动后写 `.hub-resumed` 收据，精确取代启动前那一份 `.hub-stopped`；`anet project up` 和开机脚本都认这张收据 |

另外配对的 agent-node 从 `.119` 升到 `.121`，中间带上 `.120` 和 `.121` 的全部改动：#2458、#2460、#2461、#2463、#2464（已随 `.120` 发布）、#2456、#2465、#2467。详见 [`release-v2.5.0-preview.120.md`](./release-v2.5.0-preview.120.md) 和 `.121` 的说明。

（`.152` 之后同期合入、不在 anet 里的：#2462、#2459、#2465 只改测试或 agent-node；#2457 只改官网。）

## 🔴 升级须知

- 🔴 **先升 Hub，再在生产节点上用这一对版本。** 配对的 agent-node（`.120` 起）上报 working 时带整条任务正文；Hub 端要有 #2460，才会只在 `sessions.task` 里存 200 字预览。当前 preview Hub `0.9.0-preview.110` 及更早的版本会存整条正文。
- 🔴 **`--force` 不再跳过内存检查。** 以前 `anet node start --force` 在 MemAvailable < 4 GiB 时也能强起；现在低内存时排队等待，等满上限后改为一次只起一个。要关闭这道门，设 `ANET_START_MEM_GATE=0`（命令帮助里的 `--force` 说明也改成了这样）。
- 🔴 **开机脚本要和 CLI 一起更新。** `.hub-resumed` 收据需要新版 CLI 和仓库里的 `deploy/fleet/anet-nodes-boot.sh` 一起部署（安装到开机服务实际调用的路径，保留执行权限）。没更新的旧开机脚本只认 `.hub-stopped`，会保守地让节点保持停止。部署和回滚步骤见 `docs-site/docs/deploy/daemon.md` 的「共存节点重启后的恢复边界」。
- （沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`；（沿用 `.151`）收编默认关闭，收编节点先停止再启动。

## 你会看到的变化

- **启动限流（#2456，#612）。** anet 拉起 codex 共存节点（包括 Windows 共存布局和外部 app-server 布局），以及共存看门狗重新拉起 `-appsrv` 时，都在启动重量级的 codex app-server 之前过启动门；桥和 TUI 不占名额。
  - 被拦时 stdout 打印 `[anet] [start-gate] blocked …`；app-server 一旦就绪或启动失败，就释放名额。
  - anet 自带一份和 agent-node 逐字节一致的启动门代码（有同步测试），只拷贝了 agent-network 的镜像也能用。
- **外部 app-server 桥的工作目录（#2458，#667）。** 桥现在在工作区根目录启动；codex 自己的会话仍然用 `-C` 和 `CODEX_HOME` 固定项目目录。手工在节点目录里启动 agent-node 的，仍然会看到「目录不一致」的提示。
- **停止收据与手动恢复（#2467，#671）。** 两种 codex 共存布局手动启动成功后写 `.hub-resumed`，用 inode、ctime 和内容摘要精确指向启动前的那一份 `.hub-stopped`；停止文件不删，以免误删另一个进程同时写入的新停止。之后再停止一次，旧收据自动失效。启动失败、身份不符、文件损坏时，节点保持停止。开机脚本的探针只有退出码 42 才放行，异常或其他退出码都保持停止。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.153 @sleep2agi/agent-node@2.5.0-preview.121
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.153 @sleep2agi/agent-node@2.5.0-preview.121
```

两个包一起升级（`agent-network@2.3.0-preview.153 ↔ agent-node@2.5.0-preview.121`），并按上面的说明同步更新开机脚本。

## 证据

- #2456：`tests/test612-start-admission/`（Docker）、`agent-network/src/start-resource-gate-sync.test.ts`（两份启动门逐字节一致）、`agent-network/src/copresence-cli-wiring.test.ts`。
- #2458：`agent-network/src/codex-external-appserver.test.ts`；`tests/test667-project-dir-warn/`。
- #2467：`tests/test658-codex-adopt-stop/recovery.test.ts`（手动恢复、旧绑定被拒，真实 Hub）；报告 `docs/tests/report-board671-adoption-recovery.txt`。
- 未在真实生产节点或开机服务上验证。

## promote 时的 must_contain

`"version": "2.3.0-preview.153"`
