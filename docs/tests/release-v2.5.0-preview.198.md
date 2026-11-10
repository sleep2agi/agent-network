# agent-node 2.5.0-preview.198

Since `.197`: 修好排队路径本身。`.197` 里的「排队」**只引用不声明**，走到忙分支会抛 `ReferenceError`；
这一版把状态补上，并守住一个可选写入器。

## Why

`.197` 的排队逻辑引用了 `queuedVariant` / `queuedVariantAt` / `turnStartedAt` / `waitUntilIdle`，
但这四个在文件里**只有引用、没有定义**。`tsc` 报 TS2304 + TS2722：

```text
Cannot find name 'queuedVariant'
Cannot find name 'queuedVariantAt'
Cannot find name 'turnStartedAt'
Cannot invoke an object which is possibly 'undefined'
```

运行时后果不是「少一行日志」，而是**有轮次在飞、需要排队时直接抛 ReferenceError**。
`.197` 没有暴露它，因为这段代码晚于 `.197` 发布；是版本 bump 命中 `agent-node/**` 的 typecheck 才照出来。

## What changed

```text
补上三个状态值 + waitUntilIdle（有上界、可被会话停止打断）
轮次开始记 turnStartedAt，inFlight 归零时清空 —— 否则日志里的 turn_age_ms 恒为 -1
apply 前先确认 setSelectedVariant 存在；不存在就如实跳过，不在应用处抛 TypeError
typecheck 基线按门自己的提示收缩（39 身份）
```

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.230 @sleep2agi/agent-node@2.5.0-preview.198
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 CLI `2.3.0-preview.230` 精确配对。

## What it does not do

- 不改变 ack 语义：`applied` 仍只表示「写入并回读一致」，不表示「已排队」
- 不改变 25 秒内层预算与 45 秒外层预算的关系
- 未在真机取到「有轮次在飞 → 排队 → 应用」的成功样本（见需求池 #4415）
