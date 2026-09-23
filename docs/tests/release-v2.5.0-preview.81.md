# agent-node 2.5.0-preview.81

`.80` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| fe4aec94 | #1966 | opencode 共存:配置重启时用占位命令 `respawn-pane -k` 保住人的 tmux pane,新一代 ready 后在同一 pane 重拉 attach(#1957 后半) |

## 本版修的是什么

`.80`(#1964)只做对了一半:关闭时按 pid+startTicks 精确 SIGTERM 旧的 attach TUI ✅;但 tmux 默认 `remain-on-exit off`,attach 进程一退出 pane(以及以节点名命名的单窗口 session)立刻销毁,新一代 ready 时已无 pane 可 respawn → 只打了 fallback 日志。**真机结果:远程改模型后人没有窗口了**,比原来的"旧窗口"更糟(见 #1957 09-23 评论)。

**改法**:close 时若记录里有 pane 且 tmux 在,先 `tmux respawn-pane -k -t <pane> '<占位:打印「node restarting, TUI will reattach」并 sleep>'`——既结束 attach 进程又保住 pane;无 pane/无 tmux 才走 SIGTERM。新一代 ready 后原有的 `respawn-pane -k -t <pane> "bash <新脚本>"` 命中。stop(非重启)路径不留占位 pane。pid+startTicks 身份核对保留。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.81
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.107 @sleep2agi/agent-node@2.5.0-preview.81
```

🔴 **两个包要一起升。** 配对是精确的(`.107 ↔ .81`)。🔴 有 opencode 共存节点的团队**跳过 `.80`**直接上本版:`.80` 在远程改模型后会让人的 TUI 窗口消失。

## 证据

- 真 tmux 测试(DEV 上 `tmux -L` 一次性 server):close 后 pane 仍在且跑占位命令;ready 后 pane 的 `pane_current_command` 变为启动器;无 tmux 时干净跳过。改前红(pane 被销毁)。
- 见 #1966:本地套件、typecheck 棘轮 81 = 基线、doc pins rc=0、CI 同镜像 Docker 复跑绿。

## 未覆盖(明写)

- 本版发出后需在 DEV 的 opencode 共存节点上用 `update_node_config` 真跑一次并看 pane 是否原地换成新会话(`.80` 的真机验证正是这样发现问题的)。
- macOS 仍不记录 startTicks(只日志不发信号)。

## promote 时的 must_contain

`"version": "2.5.0-preview.81"`
