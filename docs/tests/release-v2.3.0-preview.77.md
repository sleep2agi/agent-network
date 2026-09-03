# `@sleep2agi/agent-network@2.3.0-preview.77`

## 为什么发这一版:**共存节点的两条修复要靠它落地,顺带把 .76 之后攒的 26 个 CLI/daemon 提交带出去**

| 用户看到的 | `.76` | `.77` |
|---|---|---|
| Mac / Windows 上 `anet node start <grok 节点> --copresence` | `❌ grok co-presence does not run on darwin … agent-node refuses this at startup`(**归错了人**,agent-node 早就按 darwin/win32 能力表在跑) | 放行,打一条「无内核层强制隔离,只用于受信任任务/网络」提示,agent-node 启动时逐条打 reducedGuarantees(#1768) |
| 共存节点回一条任务,发起方收到几次 | 3 次:模型自己的 send_message + **high** send_task + 运行时的终态 reply(#1770) | 1 次:node-server(outbound-only)把前两条改写成不推送的进度上报(需 agent-node ≥ `2.5.0-preview.60` 写标记) |
| `anet node stop` 拆卸链 | SIGTERM 5 s 就 SIGKILL,grok 共存节点拆不完(#1522) | 宽限 10 s |
| agent 发文件 | 只能粘 file_id | `attachments` 直接带文件(#1186) |
| `anet doctor` | — | 多两项:「非 claude-agent-sdk 的 runtime 配了飞书通道」盘点、#1615「下次重启会挂」现在就能看见 |
| `anet daemon start` / `daemon init` / `daemon list` | 不说 workdir;存量 daemon 的 runtime 清单不自愈;「locally」其实是当前目录 | 启动打出 workdir 和管得到的节点目录;清单自愈;扫的目录说清楚 |
| `--force` / `--yes` | 会吃掉下一个参数 | 登记成布尔标志(#1737) |
| `anet node edit` | — | 放开 `--runtime` / `--model`(#1698) |
| PINNED_SERVER_VERSION | `.44`/`.45` | `.46`(需要生产 hub 同步升级,见 deploy/hub/README.md) |

完整清单:`git log 7d3b0fad..b4964102 -- agent-network/bin agent-network/src`(26 个非 release 提交)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.77
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.77
npm i -g @sleep2agi/agent-node@2.5.0-preview.60   # #1770 的另一半;不升也不坏,只是三条出站照旧
# daemon 是长驻进程,换包要重启才生效:
anet daemon restart <daemon>
# 共存节点要重启一次才会重新生成 .anet/node-server.js(node-server 改动在这里面):
anet node stop <name> && anet node start <name> --copresence
```

## 边界

- `.anet/node-server.js` 是节点启动时由 anet 写入项目目录的,**不重启节点不会换**;`anet doctor` 不会报这一项。
- PINNED_SERVER_VERSION 指到 `.46`,`anet hub start` 会拉 `.46`;生产 hub 仍在 `.45`,升级另走六步流程。

## promote 时的 must_contain

`progress_of_active_task`(无正则元字符;`.76` 产物用闸 4 原样命令 0 命中)。
