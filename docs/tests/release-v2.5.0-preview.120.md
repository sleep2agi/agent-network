# agent-node 2.5.0-preview.120

自 `.119`（发版合并 `6d21c1fc`，#2455）以来，`agent-node/` 有 4 个改动（`git log 6d21c1fc..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 70e88ff1 | #2458 | #667：节点从错误目录启动时提示「目录不一致」，修好目录重启后提示会清掉 |
| a3b20d74 | #2461 | #658：daemon 收编三段式 codex 共存节点（桥 / TUI / app-server），并按校验过的顺序安全停止 |
| 30a6ece8 | #2460 | #668：开始处理任务时立刻上报 working，正文用整条任务，Hub 据此把任务标成 running 并写 started_at |
| f4eaa71c | #2463 | #672：Claude 遇到 401/403 时快速中止，保留厂商返回的原始原因 |

（同期合入、不在本包里的：#2462 / #2459 只改测试；#2457 只改官网下载页。#2458 的 anet 部分（外部 app-server 桥在工作区根启动）和 #2460 的 Hub 部分要等 agent-network / commhub-server 下一次发版。）

## 🔴 升级须知

- 🔴 **先升 Hub，再在生产节点上用本版。** 本版上报 working 时带的是整条任务正文（最长 10000 字），以便 Hub 能和 `tasks.content` 对上。带 #2460 Hub 部分的 commhub-server 只把前 200 字存进 `sessions.task`；**旧 Hub（含当前 preview `0.9.0-preview.110`）会把整条正文存进 `sessions.task`**，而 get_all_status、完整的 `/api/status`、以及能看到节点但看不到对话的成员都能读到这一列。带 #2460 的 commhub-server 发布之前，不要把本版装到需要区分这类权限的生产节点上。
- 🔴 （沿用 `.117`）升级前先配 `daemonExtraPath`：`codex` / `grok` / `claude` 不在 daemon 所用 node 的同一目录、也不在系统目录时，把它们所在目录的绝对路径写进 daemon 节点 `config.json` 的 `daemonExtraPath`，再重启 daemon。
- 🔴 （沿用 `.116`）`<节点目录>/secrets.env` 必须是当前用户所有、权限 `0600` 的普通文件，否则节点拒绝启动。
- （沿用 `.118`）收编默认关闭：daemon 节点 `config.json` 的 `adopt_roots` 默认为空，空列表拒绝一切收编。

## 你会看到的变化

- **起错目录会提示（#2458，#667）。** 节点的 `config.json` 在 `<工作区>/.anet/nodes/<目录>/config.json`，而进程当前目录不是 `<工作区>` 时，日志和节点卡片的 task 会显示：
  `[agent-node] 目录不一致：当前目录 "…"，工作区根 "…"。请 cd 到工作区根再启动，或用 anet node start。…`
  - 不会自动切换目录，`project_dir` 仍按当前目录上报（codex 的工作目录跟着本进程）。
  - 有任务在跑时不覆盖任务描述，任务结束后再写回提示。
  - 修好目录重启后，注册时发一次空 task，把 Hub 上的旧提示清掉。
- **开始处理就显示 working（#2460，#668）。** 回合开始时立刻上报 working，正文是正在处理的那条任务；三分钟心跳、TUI ready、后来新到的消息都不会在回合结束前把它改成 idle 或换成别的消息。Grok 和 Claude 都适用。
  - 上报正文与 Hub 共用 `TASK_CONTENT_MAX = 10000` 上限，Hub 能和 `tasks.content` 全字匹配，长任务也会被标成 running 并写 `started_at`。
- **daemon 收编三段式 codex 共存节点（#2461，#658）。** 支持 native（`<别名>-桥` / `<别名>` / `<别名>-appsrv`）和 external-appserver（`<别名>` / `<别名>-tui` / `<别名>-appsrv`）两种布局，布局读显式字段，不靠名字猜。
  - 收编前逐个 pane 核对 marker、`CODEX_HOME`、uid、cwd；证据不足就拒绝（`adopt_codex_identity_unproven`、`adopt_codex_target_ambiguous`、`adopt_codex_stage_missing`、`adopt_codex_generation_invalid` 等）。
  - 停止只动校验过的 pane / session，按固定顺序停，中途中断的停止在重放时会续上；不会 kill-server，默认 socket 上的无关会话不受影响。
  - 读 `/proc/<pid>/environ` 只对本节点相关进程做严格解码，主机上其它进程的非 UTF-8 环境变量不会让收编失败。
- **Claude 401/403 快速中止（#2463，#672）。** 以前失效的 key 会被 CLI 重试约 10 次（约 3 分钟）才失败。
  - 第一次 401 的重试照常进行（CLI 在这次重试前会刷新 OAuth / apiKeyHelper / 宿主令牌）；第 2 次起仍是认证失败就中止，回复「执行出错: Claude 登录或 key 失效，请重新登录」，节点状态显示「Claude 登录已失效，请重新登录」。
  - 只有 401，或明确写着 revoked 的 403，才标记登录失效；地区限制、权限不足等 403 保留厂商原文，且会先去掉 SDK 的 `Claude Code returned an error result: ` 前缀再截断，不再出现「403 Req」这种截没了的原因。

## 与 Hub 的配合

- 起错目录提示、Claude 快速中止、codex 收编：不需要升级 Hub。
- working + started_at：旧 Hub 已能按正文匹配写 `started_at`，但会把整条正文存进 `sessions.task`（见上面的升级须知）。只存 200 字预览需要带 #2460 的 commhub-server（尚未发布）。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.120
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.120
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 本版只发 agent-node；源码里的配对 `PAIRED_AGENT_NODE_VERSION` 已移到 `.120`，已发布的 agent-network `2.3.0-preview.152` 仍配对 `.119`，要等下一次 agent-network 发版才会配对本版。

## 证据

- #2458：`tests/test667-project-dir-warn/`（Docker）；`server/src/project-dir-warn-clear-http.test.ts`（先触发、再恢复，断言 Hub 上的值清空）。
- #2460：`tests/test668-grok-working-status/`（Docker，假 grok / 假 claude；断言 running + `started_at`、`sessions.task` ≤ 200 字、只推断 delivered 为父任务；对应变异都变红）。
- #2461：`tests/test658-codex-adopt-stop/`（Docker，真实 Hub HTTP；默认 socket 上的诱饵会话变异）；`agent-node/src/runtime/adopt-codex-evidence.test.ts`。报告见 `docs/tests/report-board658-*.txt`、`report-test658-review-fixes.txt`。
- #2463：`tests/test672-claude-auth-abort/`（Docker）；复审三条变异变红。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.120"`
