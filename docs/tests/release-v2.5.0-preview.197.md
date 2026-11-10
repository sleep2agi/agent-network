# agent-node 2.5.0-preview.197

Since `.196`: 思考档位在「等不到空闲」时**排队**，在这一轮结束时应用一次。

## Why

`setSelectedVariant` 的闸门是对的（档位只对下一轮生效，中途写会悄悄改变正在跑的那一轮），
但一台**正常在干活**的节点几乎总是有轮次在飞：实测同一台节点连续 14 次写入全部
`rejected / variant_busy`，只有重启后到下一轮开始前那几秒能落进去。
对用户来说，「点档位 → 被拒 → 自己过一会儿重试」不是可接受的默认体验。

## What changed

```text
轮次在飞、等不到空闲  →  ack 仍 rejected/variant_busy（确实还没生效）+ 记下意图
inFlight 恰好归零     →  应用一次（同一写入器 + 回读校验）
超过 10 分钟          →  丢弃并打日志
```

ack 语义没有变：`applied` 仍然只表示「写入并回读一致」，绝不表示「已排队」。
变的是客户端那句「这一轮还在跑，档位会对下一轮生效」**第一次成为事实**。

语义没有移动：档位仍然只在两轮之间生效；`applied` 仍然只表示**真的写入并回读一致**，
不是「ack 收下了」。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.229 @sleep2agi/agent-node@2.5.0-preview.197
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 CLI `2.3.0-preview.229` 精确配对。

## What it does not do

- 不把闸门放宽（中途改正在跑的那一轮仍然是错的）
- 排队有 10 分钟上界；过期即丢弃（一个几小时后突然生效的档位比直接拒绝更坏）
