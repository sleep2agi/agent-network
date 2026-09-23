# `@sleep2agi/agent-network@2.3.0-preview.110`

`.109` 之后 `agent-network/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 1c29e34e | #1976 | daemon 经 `anet node start/restart`、`anet project up`(开机扫起)启动时也钉 anet 二进制,不再「在线但建不了节点」(Refs #1353) |

## 本版修的是什么

只有 `anet daemon start/up/restart` 这一个入口会解析并钉死 daemon 要执行的 anet 二进制(`ANET_BIN_ABS` + 两个 ALLOW 旗)。开机扫起用的 `anet project up`、以及 `anet node start/restart <daemon>` 都跳过了它 ⇒ 机器重启后每个 daemon 回来都「在线、但 create capability 被挡」。本版把钉死逻辑抽到 `agent-network/src/daemon-anet-bin.ts`,`anet node start` 对 daemon 节点在 spawn 前调用;失败**不退出**,照样起并打印修复命令(hub 上显示不能建节点)。

**刻意不做:把钉死结果持久化到文件 / `--rebind-bin`。** 钉死决定 daemon 执行哪个二进制,一个 daemon 自己用户可写的钉死文件等于让同用户权限的任何东西改掉它;同文件里存 hash 不增加任何保证(#1353 08-28/08-30 评论已否决)。每次启动从正在运行的 anet 包重新解析即可;升级后 `anet daemon restart` 就是重新钉死。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.110
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.110 @sleep2agi/agent-node@2.5.0-preview.83
```

🔴 **两个包要一起在位。** 配对是精确的(`.110 ↔ .83`);本版 agent-node 不变,仍是 `.83`。

## 证据

- `daemon-anet-bin.test.ts` 11 条;main 的 cli.ts 3 红、删调用 1 红、钉死改成退出 / 去掉角色判断 / 去掉 mode 检查各 2 红;恢复 11/11。
- 真 CLI(bun、临时 HOME、不可达 hub)跑一次性 daemon 配置:修后打印 `#1353 "daemon-e2e" is a daemon started via node start — pinned anet binary: …`;775 二进制打印未验证 + 修复命令并继续;main 的 CLI 在同一夹具上什么都不打。
- agent-network `bun test src` 1300 pass / 0 fail;`tsc` 0 错;doc 门 rc=0。

## 未覆盖(明写)

- 没做真实重启的 Docker 端到端;发出后在 DEV 用 `anet node restart daemon-dev`(不经 `anet daemon`)验一次 create capability 仍 ready。

## promote 时的 must_contain

`"version": "2.3.0-preview.110"`
