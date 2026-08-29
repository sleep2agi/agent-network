# daemon ↔ hub 生命周期请求的可靠性模型

> 代码已在 `main`(#1448 一族,`50fa0d87` 及其前序)。本文讲的是**仓库当前的机制**,
> 不是路线图。用户侧的表现要等发版,见 `docs-site/docs/troubleshooting/node-stuck-lifecycle.md`。

## 根因形状:门铃是一次性推送,没人接就没了

hub 用 SSE 给 daemon 发"门铃"(stop / start / delete 请求到了)。推送函数在
**没有订阅者时直接 return** —— 不排队、不重试、不留痕:

```ts
// server/src/push.ts:413
if (!arr || arr.length === 0) return;
```

daemon 只要在那一瞬间不在线(重启、网络抖动、SSE 断开重连的空窗),这次门铃就**永久丢失**。
hub 侧的请求行仍是 `pending`,daemon 侧什么都没发生 —— **两边都不报错**,
于是节点卡在 `starting` / `stopping`,而**没有任何一侧认为自己出了问题**。

🔴 这是形状,不是某个函数的 bug:**任何**基于一次性 push 的 daemon↔hub 通知都有它。

## 补偿:重连时把漏掉的门铃拉回来重放

两端各一半,镜像 create 侧已有的做法(#1394):

| 端 | 机制 | 位置 |
|---|---|---|
| hub | `list_my_pending_lifecycle_requests` —— 列出该 daemon 名下仍未完成的请求 | `server/src/tools.ts:3334` |
| daemon | `reconcilePendingLifecycleRequestsOnConnect()` —— **每次 SSE 连上**就拉一次并重放 | `agent-node/src/runtime/lifecycle-reconcile.ts:69`,调用点 `agent-node/src/cli.ts:6131` |

⇒ 门铃丢失不再是终局:**下一次重连就会把它补回来**。

## 三个 stuck-state 各自的收敛路径

| # | 卡在哪 | 成因 | 收敛机制 | commit |
|---|---|---|---|---|
| f1 | 请求发出后 daemon 毫无反应 | 门铃在无订阅者时被静默丢弃 | 重连补偿重放(上一节) | `a5a70b8f` (#1450) |
| f2 | 节点卡 `starting` | `start_node` 只受理 `stopped`;一旦卡 `starting` 就再也派不动 | `start_node` 加 **stale-starting supersede**,对齐 config/restart 已有的 60s single-flight reaper | `50fa0d87` (#1456) |
| f3 | 节点卡 `stopping` | daemon 收到 stop 但 `childrenMap` 里没有该子进程(daemon 重启过) | 不再静默忽略:**sweep + `ack_stop_request(stopped)`** 收敛,对称补 #1286 | `50d5ddf6` (#1453) |

f2 的超时基准沿用 create 侧常量 `REAPER_TTL_MS = 60_000`(`server/src/create-node.ts:28`)。

## 🔴 给后来人的护栏

**任何新的 daemon↔hub 门铃,都必须同时有"重连补偿",不能只靠一次性 push。**

判据很简单:问一句「daemon 在这条 push 发出的那一刻不在线,会怎样?」
如果答案是"这次请求就没了",那它就还没写完 —— 需要:

1. hub 侧有办法**列出未完成的请求**(像 `list_my_pending_lifecycle_requests`);
2. daemon 侧在**重连时**把它们拉回来重放(像 `reconcilePendingLifecycleRequestsOnConnect`);
3. 一条**兜底收敛**,让请求不会无限期停在中间态(reaper / sweep+ack)。

三条缺一,就会重新长出 one-shot-drop 这一族 —— 而它的症状是**两边都不报错**,
所以不会有人来报障。
