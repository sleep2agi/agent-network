# agent-node 2.5.0-preview.196

Since `.195`: 思考档位在「我方有轮次在飞」时**等它结束**再写，而不是立刻拒绝。

## Why

`setSelectedVariant` 的闸门是对的（档位只对下一轮生效，中途写会悄悄改变正在跑的那一轮），
但一台**正常在干活**的节点几乎总是有轮次在飞：实测同一台节点连续 14 次写入全部
`rejected / variant_busy`，只有重启后到下一轮开始前那几秒能落进去。
对用户来说，「点档位 → 被拒 → 自己过一会儿重试」不是可接受的默认体验。

## What changed

```text
inFlight > 0  →  waitUntilIdle(预算 35 秒)  →  照常写入 + 回读
35 秒仍忙     →  variant_busy（措辞不变，仍然诚实）
```

35 秒是对着调用方的预算挑的：`MODEL_SWITCH_DEADLINE_MS = 45_000`，留 10 秒给写入与回读。

语义没有移动：档位仍然只在两轮之间生效；`applied` 仍然只表示**真的写入并回读一致**，
不是「ack 收下了」。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.228 @sleep2agi/agent-node@2.5.0-preview.196
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 CLI `2.3.0-preview.228` 精确配对。

## What it does not do

- 不把闸门放宽（中途改正在跑的那一轮仍然是错的）
- 一轮超过 35 秒仍会拒绝：那种情况需要真正的 `queued` 状态（跨轮存续），是另一条改动
