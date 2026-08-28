# agent-node v2.5.0-preview.40 — 让「节点删不掉」那段可读

**Channel:** `preview` only

**Date:** 2026-08-28

这一版**不修** #1286（节点 `delete_node` 后永远停在 `lifecycle_state=deleting`），
它让下一次复现**能给出答案**。

## 这一版包含什么

**① daemon 的「备份 workdir → 发 ack」那段全程留痕**（#1356）

复现时 daemon 日志**每次都停在** `backed up child workdir`，之后零输出。
那段里只有三步，而三步在源码上都有 try/catch 或 `.catch` 保护 —— **静态读不出是哪一步**。
现在三步之间各有一行日志，ack 成功也打一行：

```
[stop-daemon] entering residual sweep alias=…
[stop-daemon] residual sweep returned alias=…
[stop-daemon] dropped from children map child_node_id=…, sending ack action=…
[stop-daemon] ack accepted request_id=… action=…
```

**② 关键路径上的 `execSync` 加了 timeout 和 maxBuffer**（#1356）

`execSync("pgrep -af 'agent-node' || true")` 原来两者都没有，而它就坐在备份与 ack 之间。
🔴 **这不是 #1286 的成因** —— 同机实测 pgrep 63ms、输出 22299 字节（1MB 上限的 2.1%），
两个数量级的差距。这是一条独立成立的硬化：daemon 关键路径上不该有无上限的同步子进程调用。

## 已排除的（都有读数，写在这里免得下一个人重走）

| 假设 | 判定 | 证据 |
|---|---|---|
| pgrep 慢 / 缓冲区溢出 | ❌ | 63ms、22299 字节 = 上限的 2.1% |
| 线上产物与源码不同 | ❌ | `.39` 产物未混淆，逐字比对那一段与 main 一致 |
| 异常逃逸被静默吞掉 | ❌ | 调用方有 `.catch → warn`；正控证明 warn 确实写进该日志文件 |
| 卡在 ack 的网络等待 | ❌ | 进程只持 1 个 socket（SSE），事件循环 `ep_poll` 空转，43 分钟累计 CPU 2 秒 |
| hub 返回 `ok:false` 被忽略 | ❌ | `classifyCommHubResponse` 里 `ok===false` 走 appLevel，会抛异常并留日志 |

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.40
```

配对的 CLI 是 `@sleep2agi/agent-network@2.3.0-preview.54`，它钉住这个 runtime 和
已发布的 `commhub-server@0.9.0-preview.34`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.40
```

🔴 **装完必须 stop + start 该节点**，正在跑的 agent-node 进程不会自己换成 `.40`。
（启动横幅不等于就绪：看到节点重新注册也不代表新代码生效，要看日志里出现上面那四行。）

## 复现步骤（用来读那四行）

```
1. 通过 daemon 建一个全新子节点
2. 不 stop，直接 delete_node
3. 看 daemon 日志停在上面四行的哪一行 —— 那就是卡住的那一步
```
