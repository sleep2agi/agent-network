# agent-network v2.3.0-preview.54 — daemon 的 anet 二进制 pin 传给子进程

**Channel:** `preview` only

**Date:** 2026-08-28

## 这一版修什么

`#1354` —— daemon 起子节点时，**`ANET_BIN_ABS` 等二进制 pin 一个都没传给 spawn 出来的
agent-node 子进程**。

起因是我在 `#1299` 里的一个错误假设：`prepareDaemonAnetBin()` 往 `process.env` 上写这几个
变量，注释还写着「daemon start/up 是同进程」—— **同进程是对的，但 `startCommand` 会 spawn
一个子进程，而 `childEnv` 是从窄的 `env` 变量组的，不是 `process.env`**。于是子进程一个都拿不到。

真机实测（两台机器）：`nohup anet daemon start <name>` 起来的 daemon 环境里只有
`ANET_CONFIG_UPDATE_CAPABLE`，随后 `create_node` 一律报
`anet_bin_unsafe_path: no ANET_BIN_ABS resolved`。

🔴 **症状具有欺骗性**：daemon 照常注册、在线、收 doorbell，hub 返回 `ok:true` + `request_id`，
失败只出现在 daemon 自己的日志里。**「在线」和「能干活」是两件事。**

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.54
```

配对的 runtime 是 `@sleep2agi/agent-node@2.5.0-preview.40`，Hub 是已发布的
`@sleep2agi/commhub-server@0.9.0-preview.34`。本版的 `PAIRED_*` 常量钉的就是这一组。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.54
npm install -g @sleep2agi/agent-node@2.5.0-preview.40
```

🔴 **升完必须 stop + start 每个节点** —— 正在跑的进程不会自己换成新版本。
daemon 尤其要重启，因为这一版修的正是它 spawn 子进程时的环境传递。

🔴 **重启 daemon 时别丢了它的环境**。2026-08-28 实测：用干净的 `anet daemon start` 重启后，
`create_node` 立刻卡在 `anet_bin_unsafe_path` —— 新进程没有旧进程的环境变量。
生产上正确的做法是把 pin 落到 `/etc/anet-daemon/path.conf`；
`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS=<realpath>` 是 Docker/dev/manual-ops 的便利路径。

## 验证方式

升级并重启 daemon 后，起一个子节点，然后**读 daemon 日志确认真的 spawn 成功**：

```
[create-node] spawned child '<alias>' pid=<pid>
[create-node] post-spawn kill-0 verify OK: pid=<pid> alive
[create-node] +5000ms capability check OK: pid=<pid> still alive
```

🔴 只看 `create_node` 返回的 `ok:true` **不构成验证** —— 那个 ok 在 spawn 失败时也一样返回。
