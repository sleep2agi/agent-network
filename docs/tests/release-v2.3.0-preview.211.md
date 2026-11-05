# @sleep2agi/agent-network 2.3.0-preview.211

Since `.210`: 白名单里的人**在群里连发不再被"频率超限"拒绝**，改为进队列。

## Why

实测（2026-11-05）：admin 在群里连着 @ 两次，第二次直接收到
「处理频率超出限制，请稍后重试」——而他正是白名单里唯一的人。

群聊原来刻意不豁免限流，理由是「群侧限流按 chat_id 计，豁免会让一个人饿死其他人」。
这条理由在**公开形态**（通配符 `*`）下成立，但在"白名单只有一个人"时是反的：
拒绝一条本该排队的话，比让它排到第 2 位更糟 —— 前者什么都不会发生，
后者至少有序、可见、可 `/cancel`。

## What changed

把 DM 已有的「显式白名单豁免」扩到群聊：`allowFrom` 是**有限名单**且发件人在其中
⇒ 跳过限流，交给队列。洪水保护仍在两处，不依赖这条限流：

```text
① 队列上限 MAX_QUEUED_TURNS=20，满了明确回「这条没有排上」
② 通配符 allowFrom（公开形态）仍然走限流 —— 那才是"陌生人"的形状
```

## Verification

```text
feishu 目录 49 pass（既有用例覆盖通配符分支仍限流）
bun build bin/cli.ts 通过
```

## What it does not do

- 不改 DM 的既有豁免（本来就是这样）。
- 不动 agent-node 的配对（仍是 2.5.0-preview.177）。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.211
```

## Upgrade

```bash
anet upgrade
anet node restart <name>
```
