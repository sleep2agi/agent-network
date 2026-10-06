# agent-network 2.3.0-preview.148

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.148`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.115`（见 [`release-v2.5.0-preview.115.md`](./release-v2.5.0-preview.115.md)）。

自 `.147`（发版合并 `b87cb86f`，#2425）以来，`agent-network/` 有 2 个改动（`git log b87cb86f..origin/main -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 4a49a497 | #2426 | #620：启动 daemon 时丢掉从当前会话继承来的身份环境变量 |
| 4c409cb3 | #2428 | #628：`anet project up` 不再拉起在 Hub 上被停掉的节点 |

## 你会看到的变化

- **daemon 不再带着别人会话的身份运行（#2426，安全修复）。** 以前在另一个 agent 的会话里（比如 Claude Code 的终端、某个节点的 TUI，或从它们里面起的 tmux）执行 `anet node start <daemon>` / `anet daemon up`，daemon 进程会继承那个会话的 Claude Code 会话令牌、另一个节点的 `COMMHUB_*` / `ANET_NODE_MARKER`、`CODEX_*` / `GROK_*`、`TMUX` 等变量，长期挂在 daemon 的进程环境里。现在启动 daemon（`role=host_supervisor`）时先把这些变量去掉，再设置 daemon 自己的 `COMMHUB_*` 和配置里的环境变量；服务商 API key、代理变量、`ANET_BIN_*` / `ANET_DAEMON_*` 保留。日志里打一行被去掉的**变量名**，从不打印值。普通节点不变；daemon 建出来的子节点本来就只拿到白名单环境，这次也在端到端测试里确认了。
- **Hub 上停掉的节点，`anet project up` 不会再把它拉起来（#2428）。** 在 Hub / App 里停止节点会在节点目录写入 `.hub-stopped`；以前 `project up` 不认这个标记，照样启动。现在它会跳过并打印 `hub-stopped, leaving it down`，也不删 `.pid`（活着的 `.pid` 本来就不会删，#1332）。同一个 PR 还修了仓库里的开机扫描脚本 `deploy/fleet/anet-nodes-boot.sh`，那个脚本不在 npm 包里，需要按部署文档单独更新。
- 配对的 agent-node 升到 `.115`：daemon 逐个 runtime 自检并上报 `runtime_readiness`，详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.148 @sleep2agi/agent-node@2.5.0-preview.115
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.148 @sleep2agi/agent-node@2.5.0-preview.115
```

两个包一起升级（`agent-network@2.3.0-preview.148 ↔ agent-node@2.5.0-preview.115`）。#2426 要等 daemon 重启（`anet daemon restart <名字>`）后才生效。

## 证据

- #2426：`daemon-inherited-env.test.ts` 7 个测试（含与 `hub-daemon.sh` 名单一致性、cli.ts 接线检查）；Docker `qa-daemon-lifecycle-e2e` 新阶段 `A.env` 在 daemon 和子节点的 `/proc/<pid>/environ` 上断言 PASS=27 FAIL=0，去掉修复后 FAIL=1；test745 agent-network 单测 1912 pass / 0 fail。
- #2428：Docker `tests/test571-lifecycle-safety` PASS=58 FAIL=0；去掉开机扫描的判断后 FAIL=3，去掉 `project up` 的判断后占位节点的 `.pid` 被删并起了会话。

## promote 时的 must_contain

`"version": "2.3.0-preview.148"`
