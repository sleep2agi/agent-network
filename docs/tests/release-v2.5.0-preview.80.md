# agent-node 2.5.0-preview.80

`.79` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| b1ec7f22 | #1964 | opencode 共存:配置重启(exit 75)时停掉**本代**拉起的 attach TUI,并在新一代 `ready` 后在原 tmux pane 里重新拉起新的 `opencode-attach.sh`(#1957) |

## 本版修的是什么

RFC-024 远程改模型会让 opencode 共存节点走 exit-75 重启。此前人已经 attach 上的 `opencode attach http://127.0.0.1:<旧端口> --session <旧会话>` 进程会活过重启:窗口继续显示旧会话和旧模型栏,而且它就是日志里那条「launch-root cleanup deferred; a live descendant still references it」。网络侧没问题,人看着的那扇窗是错的。

**改法**:
- 启动脚本 `opencode-attach.sh` 导出 `ANET_OPENCODE_ATTACH_GEN=<sessionId>`,并在 `exec opencode attach` 之前原子写 `<nodeDir>/opencode-attach.json`(`pid`、`/proc/<pid>/stat` 第 22 字段的 startTicks、`$TMUX_PANE`、gen)。
- `close()` 读该记录,改名为 `.prev.json`,用**同一个**按 pid 读 `/proc/<pid>/stat` 的函数核对 startTicks,一致才对**那一个 pid** 发 SIGTERM;不一致/无记录 → 只告警不杀。不按命令行模式匹配。
- 新一代 `ready` 后,若 `.prev` 记录有 pane,`tmux respawn-pane -k -t <pane> "bash <新脚本>"`;没有 tmux / pane 已没了 → 打一行 `previous attach TUI (pid N) stopped; relaunch: <script>`。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.80
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.106 @sleep2agi/agent-node@2.5.0-preview.80
```

🔴 **两个包要一起升。** 配对是精确的(`.106 ↔ .80`)。

## 证据

- `opencode-copresence` 套件 47 → 53(真 bash/`sleep` 子进程做 pid/ticks/SIGTERM 见证);变异「忽略 ticks」5/6、「永不发信号」5/6、「永不 respawn」4/6、「脚本不写记录」19/20 各红;恢复后全绿。
- 第一版在 CI 的 Docker non-root 容器里 3 红(live 身份读不到 startTicks:记录与读取用了不同的函数),已改为记录与读取共用同一个 pid-based 函数,并在 CI 同镜像里复现→绿(见 #1964 评论)。
- typecheck 棘轮 81 = 基线;doc symbol/source pins rc=0。

## 未覆盖(明写)

- macOS 不记录 startTicks,`close()` 只打日志不发信号(darwin `ps` 路径未加)。
- 没在真实节点上跑过整条重启链;发出后在 DEV 的 opencode 共存节点上用 `update_node_config` 补一次。

## promote 时的 must_contain

`"version": "2.5.0-preview.80"`
