# @sleep2agi/agent-node 2.5.0-preview.177

Since `.176`: 飞书入站的**队列有了把手** —— 能看见、能提权、能撤回。

## Why

admin 2026-11-04：队列要可操作、可控制 —— 能提优先级、能删掉某条。
`.176` 之前只有串行（thinkQueue 一条 promise 链）：保证不并发，但看不见排了谁、
改不了顺序、撤不掉。对用户来说，"发了还没跑"和"发了被吞了"是一回事。

## What changed

```text
· 飞书入站从「直接 await 跑一轮」改成「入队 + drain」
  串行语义不变（drain 内部同时只跑一条），但排队中的条目有 id、能被操作
· /q            看排了谁（位次 · id · 谁发的 · 等了多久）
· /cancel <位次> 撤掉还没开始的那条（幂等；找不到返回 false 不抛）
· /prio <位次>   提到前面（不越过已有的 high）
· /clear        撤掉自己还没开始的全部
· 只有发件人能撤/提自己的；撤不掉的两种情形分开回话
· 一条抛错不中断队列；运行中入队的会被同一次 drain 接着跑
```

## Verification

```text
feishu-turn-queue.test.ts      12 pass
feishu-queue-command.test.ts    7 pass
feishu-role.test.ts            21 pass
feishu-channel-failsoft.test.ts 3 pass
typecheck ratchet：新增 0 / 变多 0；bun build 通过
```

## What it does not do

- **不打断正在跑的那一轮**（V2 steer）。撤回只覆盖"还没开始"的条目 ——
  两者混在一起时，用户会以为撤了，而那一轮其实还在跑，那比不撤更糟。
- 队列没有上限；跨会话仍是全局 FIFO。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.177
```

## Upgrade

```bash
anet node restart <name>
```
