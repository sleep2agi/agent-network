# agent-node 2.5.0-preview.197

Since `.196`: 思考档位在「等不到空闲」时**排队**，在这一轮结束时应用一次。

## Why

`.196` 让写入在轮次跑着时**等 35 秒**；但一轮常常超过 35 秒，等不到仍然只会回 `variant_busy`。
而客户端那句话是「这一轮还在跑，档位会对下一轮生效 —— 跑完再切」——在 `.196` 之前它只是安慰：
节点什么都没记住，用户得自己再点一次。

## What changed

```text
轮次在飞、等不到空闲  →  ack 仍 rejected/variant_busy（确实还没生效）+ 记下意图
inFlight 恰好归零     →  应用一次（同一写入器 + 回读校验）
超过 10 分钟          →  丢弃并打日志
```

ack 语义没有变：`applied` 仍然只表示「写入并回读一致」，绝不表示「已排队」。
变的是客户端那句提示**第一次成为事实**。

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

- 队列有 10 分钟上界，过期即丢弃（一个几小时后突然生效的档位比直接拒绝更坏）
- 垃圾时间戳（NaN / 0 / 时钟倒流）一律当过期，绝不当成「新鲜」
- 不在这一轮还没结束时抢写
