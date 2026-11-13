# agent-node 2.5.0-preview.208

Since `.207`：**迟到回复不再因为「回执目标已不存在」而每次重启重报**，以及 never_consume 闸的内存计数以最后一次回复为界。

## 改了什么

1. **迟到回复的终态错误**（#4529 / #3571）
   节点重启后会给「上次没等到结果」的原发送方补一条说明。旧记录（没有 `to` 字段）只能靠 Hub 从
   `tasks.from_name` 反查目标；任务行一旦被清理，反查落空，Hub 返回 `reply_target_unresolved`，
   于是这条说明**永远补不上**、而且每次重启都重报一次（本机实测 4 条旧记录，每次重启刷 4 行 warning）。
   现在：把这个错误视为**终态**，清掉记录并打一行说明；其余错误（网络 / 5xx / 超时）保持可重试。

2. **never_consume 闸的内存计数以最后一次回复为界**（#3570）
   闸不再把「已经回过、但账本还留着」的任务算成未消费。

## Why

「不再静默丢失」这个承诺，在最该生效的场景（重启后补发）反而永远失败 —— 这不是丢数据，是
**一条永远发不出去的补偿**在每次重启时重复一遍。终态识别让它停在那里，而不是无限重试。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.240 @sleep2agi/agent-node@2.5.0-preview.208
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

## Verify（升级后）

```text
· 启动日志不再出现 [late-reply] startup notice failed: reply_target_unresolved
· 旧记录会被清掉：日志出现 [late-reply] dropped unrecoverable record <id>
· 新记录仍走显式 alias（#4529 原修复不变），补发不受影响
```
