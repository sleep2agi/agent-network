# 节点卡在 stopping / starting，或网络抖动后操作没反应

::: warning 这一页描述的行为需要这两个版本
自动补偿恢复需要 **`@sleep2agi/agent-node` ≥ `2.5.0-preview.49`** 和
**`@sleep2agi/commhub-server` ≥ `0.9.0-preview.40`**。

用 `anet -v` 看你装的是哪一版。**版本不够时下面说的"自动恢复"不会发生**，
处理办法见本页最后一节。
:::

## 症状

在 Dashboard 或 CLI 上停止 / 启动 / 删除一个 **daemon 托管的节点**之后：

- 节点一直停在 `stopping` 或 `starting`，不往下走；
- 或者操作发出去之后**什么都没发生** —— 两边都不报错。

常见触发条件：**操作发出的那一刻 daemon 正好不在线**（daemon 重启、机器休眠、
网络抖动、SSE 断开重连的空窗）。

## 先做什么：等一次重连

hub 用一次性推送把请求送给 daemon。**daemon 不在线时那次推送就没了** ——
所以你看到的不是"操作失败"，而是"操作好像没发生过"。

**满足上面版本要求时，这件事会自己好**：daemon 每次重新连上 hub，都会主动把
自己名下**没做完的请求拉回来重放**。

> **所以第一步是等它重连，而不是手动重启。** 通常几秒到一分钟。
> 卡 `starting` 的节点另有一道 60 秒的兜底，会把过期的中间态清掉，让你能重新下发。

## 怎么确认它真的恢复了

看 **daemon 那台机器**的日志（不是 hub 的、也不是 Dashboard）：

```bash
tail -f ~/daemon-<name>.log
```

重连之后应当能看到它把漏掉的请求捡回来执行。节点状态随之离开 `stopping` /
`starting`。

🔴 **别把 Dashboard 上的状态当唯一判据** —— 这一类问题的特征恰恰是
**两边都不报错**，界面看起来一切正常。

## 还是不动，怎么办

按这个顺序：

1. **确认 daemon 真的连上了**。见 [daemon 页 §4](/deploy/daemon#hub-prereqs)：
   `anet daemon list` 只读本机配置，**列出来不等于 hub 认得它**；
   要看 hub 侧的 `SSE ←` / `report_status` 心跳。
2. **确认版本够**（本页顶部那两个）。低于要求的版本**没有**重连补偿这条路径，
   卡住就是卡住 —— 这时才需要手动重启 daemon。
3. 仍然不动的话，带上 daemon 本机日志里那段时间的输出开一条
   [issue](https://github.com/sleep2agi/agent-network/issues)。
