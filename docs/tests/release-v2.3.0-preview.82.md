# `@sleep2agi/agent-network@2.3.0-preview.82`

## 为什么发这一版:一条 `anet node start` 的守卫 + 配对 agent-node `.64`

`.81` 之后 `agent-network/bin|src` 一个提交,外加配对版本:

| 提交 | PR | 内容 |
|---|---|---|
| `22fac026` | #1804 | **#1130** —— `anet node start` 对已在跑的节点拒绝起第二个会话(读 `.pid`、`kill -0` 存活且命令行是 agent-node 才算在跑;pid 复用不算),给出 `restart` / `stop && start` 两条路 |
| 本版 | — | `PAIRED_AGENT_NODE_VERSION` `.63` → `.64`(#1104 派单锚点修复,见 `release-v2.5.0-preview.64.md`) |

| 用户看到的 | `.81` | `.82` |
|---|---|---|
| 对已在跑的节点再 `anet node start` | 第二个进程接管 alias,退出时把它报成 offline,原进程还活着而 hub 不再推送 | 立即拒绝并提示 `anet node restart <name>` 或 `stop` + `start` |
| `anet node create` 配对装的 agent-node | `.63` | `.64` |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.82
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.82
anet node stop <name> && anet node start <name>
```

## 边界

- 守卫只在 `launchAgent` 入口生效;`project up` 原本就有 skip already-running,行为对齐而非新增语义。
- 读不到 `/proc/<pid>/cmdline` 的平台按「活着」处理(宁可多拒一次,也不接管别人的 alias)。
