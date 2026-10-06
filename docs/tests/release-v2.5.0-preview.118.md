# agent-node 2.5.0-preview.118

自 `.117`（发版合并 `822ebb57`，#2441）以来，`agent-node/` 有 3 个改动（`git log 822ebb57..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| df7a06b7 | #2436 | #626：daemon 收编手工节点（daemon 侧核验 + 本机登记），配合 anet `daemon adopt` / `unadopt` / `adopted` |
| 8c2b49bd | #2443 | #651：OpenCode 共存回复超时后，只有我们的提交是未答队列的队头、后面没有别人排队时才中止会话 |
| f87b66ef | #2437 | #627：收编节点可以经 daemon 停止 / 启动；Hub 对收编节点拒绝 restart（Hub 部分随 commhub-server `0.9.0-preview.109`） |

（同期合入、不在本包里的：#2445 只改官网下载页。）

## 🔴 升级须知

- 🔴 （沿用 `.117`）**升级前先配 `daemonExtraPath`。** 如果这台机器上的 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录，也不在系统目录，要先把这些命令所在目录的绝对路径写进该 daemon 节点 `config.json` 的 `daemonExtraPath`（字符串数组），然后重启 daemon。否则从 app 建这几种节点会被直接拒绝，不会先 spawn 再失败。报错里会写缺哪个命令，以及去哪里配。
- 🔴 （沿用 `.116`）节点只读权限为 `0600` 的 `<节点目录>/secrets.env`：是符号链接、属主不是当前用户或权限不是 `0600` 时节点拒绝启动。升级前检查已有的 `secrets.env`，修法：`chmod 600 <节点目录>/secrets.env`。
- 收编默认关闭：daemon 节点 `config.json` 的 `adopt_roots`（允许收编的工作目录绝对路径列表）默认为空，空列表拒绝一切收编。不配置就不会有任何行为变化。

## 你会看到的变化

- **daemon 收编手工节点（#2436，#626）。** 在手工节点的工作目录用自己的 `anet login` 人类账号运行 `anet daemon adopt <alias> --daemon <daemon-id>`（不带 `--yes` 只看计划，`--all` 只枚举当前目录的 `.anet/nodes`）。请求成功只代表 pending：daemon 独立核验 UID、路径、配置身份、`/proc`、HOME 和可重建环境，通过后原子写入 daemon 工作目录的 `.anet/child-workdirs.json` 并向 Hub 确认。收编和撤销（`anet daemon unadopt <alias> --yes`）都**不重启、不发进程信号**。只支持 bare / tmux；共存节点或无法重建环境的节点会被拒绝，报错只列环境键名。需要 Hub 已有两阶段收编协议（#2427，`0.9.0-preview.107` 起）。
- **收编节点可以经 daemon 停止和启动（#2437，#627）。**
  - 停止前重新核验节点配置、UID 和 `/proc` 起始时间，只停核验过的进程树；成功后写 `<节点目录>/.hub-stopped`，`anet project up` 和开机扫描都保留停止状态。
  - 启动时删掉标记，按停止时保存的真实启动证据、用 daemon 信任的 anet 入口启动。启动方式是推断的、配置变了或证据缺失时拒绝启动，不猜。
  - tmux 必须是明确的私有 socket；默认 socket、不可用的私有服务、原会话仍被占用，都拒绝操作。不会向默认 tmux 服务发命令。
  - 撤销后迟到的启动不会把节点复活。
- **收编节点的 restart 被拒绝（#2437，#627）。** 收编绑定只证明能停能启，不证明外层有 exit-75 自动拉起。Hub `0.9.0-preview.109` 对有效收编绑定、且不是 daemon 创建的节点，`restart_node` 返回 `adopted_restart_requires_daemon`（「Use Stop, then Start for this adopted node.」）。请在客户端先「停止」再「启动」。普通节点和 daemon 创建的节点行为不变。
- **OpenCode 共存回复超时的中止（#2443，#651）。** 回复阶段超时后，只有「未答的 user 队列队头是这次提交，且后面没有别的 user 在排队（包括无文本的）」才 `POST /session/:id/abort`。
  - 中止成功：失败回复写明会话已中止，之后不再迟到回复。
  - 中止失败：记 `[opencode-copresence] session abort failed`，失败回复不声称已经停住。
  - history 读不到或判不出、history 里没有这次提交、队头是人的轮次或我们更早的一条、后面还有人排队：都不中止，文案仍是「仍在节点的 TUI 会话里运行，没有被中止」。会话级中止会把后面排队的轮次一起中止，所以这些情况宁可不中止。
  - OpenCode 2 的截止时间文案不变（仍是「还在跑、没有中止」）。
  - ⚠️ 未解决（N5）：如果真实 opencode 在轮次一开始就写入 assistant 占位（`parentID` 指向我们、parts 为空），`ownershipChainVerdict` 会把这条 user 判成已答，于是永远不中止。方向是安全的（不会误中止），但 #651 的中止在这种情况下可能不会发生。等真机验证，本版未改。

## 与 Hub 的配合

- 收编需要 Hub `0.9.0-preview.107` 及以上（两阶段收编协议 #2427）。
- 收编节点的 restart 拒绝在 Hub 侧：需要 commhub-server `0.9.0-preview.109`。在更早的 Hub 上，对收编节点的 restart 不会被 Hub 拦下。
- OpenCode 中止不需要升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.118
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.151 @sleep2agi/agent-node@2.5.0-preview.118
```

升级后 daemon 要重启（`anet daemon restart <名字>`）才会有收编和收编节点停启。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.151 ↔ agent-node@2.5.0-preview.118`）。
- 发布顺序：先 agent-node `.118`，再 agent-network `.151`，两者来自同一个合并提交；之后发 commhub-server `0.9.0-preview.109`。

## 证据

- #2436：`tests/test626-daemon-adoption/`（Docker），记录在 `docs/tests/report-board626-daemon-adoption.txt`。
- #2437：`tests/test627-adopted-lifecycle/`（Docker，真实 Hub、bare 与私有 tmux、真实开机扫描）52 项 E2E PASS，两道变异门 rc=1；记录在 `docs/tests/report-board627-adopted-lifecycle.txt`。
- #2443：`tests/test651-opencode-timeout-abort/` 本机 Docker `OVERALL: PASS`；删掉 abort 调用、把读不到 history 当成可中止、把队头不是我们当成可中止，三条变异都变红。记录在 `docs/tests/report-test651.txt`。
- 未在真实生产节点 / daemon 上验证；N5 未经真实 opencode 验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.118"`
