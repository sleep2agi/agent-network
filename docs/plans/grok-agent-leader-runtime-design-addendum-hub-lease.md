# Grok Agent Leader 设计补遗：Hub Delivery Lease 与本机 Turn Lease

> 状态：设计 freeze 的规范性补遗（决策 5 落点澄清）
>
> 基线设计：`grok-agent-leader-runtime-design.md`
>
> 基线 SHA-256：`87b47cf42e8a8e2eba572ce54e799fce763ed0d11db0c9ad3d8599e9cc6d1be1`
>
> 共享 Hub P0：<https://github.com/sleep2agi/agent-network/issues/440>

本补遗不解冻或改写已冻结的 Grok wire、scheduler、approval 与 no-go 决策；只固定
基线设计 §4.1、§8、§11.4、§14 中 CommHub consumer primitive 的实现层级和命名。
如本补遗与基线设计中“由 Grok runtime 自建 row consumer 逻辑”或“把两种 lease
合成一个 token”的表述冲突，以本补遗为准。

## 1. 两个不同的 ownership primitive

### 1.1 Hub `DeliveryConsumerLease`

`DeliveryConsumerLease` 只回答：哪个 server-resolved node principal/runtime instance
可以 claim、续租、ACK、dead-letter 或 reply 某个 inbox row。

- 实现和持久化只在 `server/src` 的共享 Hub primitive；
- principal 由 Hub 认证上下文解析，不接受 payload alias/from/node id 作为权限依据；
- self-inbox claim 必须原子化，consumer identity、epoch 和有效期由 Hub 签发/校验；
- ACK/reply 在 Hub transaction 内检查 delivery lease 与 operation id；
- Codex 与 Grok 调用同一 contract，不各建 schema、SQL、身份解析或 lease 算法；
- 具体 schema/API 在 #440 freeze 前，Grok 侧不写生产实现。

### 1.2 Gateway `TurnReservation` 与 `TuiOwnerLease`

这两个本机 primitive 只回答：共享 Grok session 的当前 turn 由 human 还是 agent
占用，以及哪个真实 TUI owner 可以执行 interrupt/approval。

- 仅存在于本机 gateway/scheduler/ledger；
- 约束 native IPC prompt、Busy、FIFO、interrupt 和 approval owner；
- 不授予 inbox row 的 claim/ACK/reply 权限；
- Hub 不解析、不签发，也不把它持久化为 delivery consumer lease；
- reservation/owner lease 丢失不会自动改变 Hub row ownership，反之亦然。

因此两个状态机可以同时发生变化，但不能共享 token、epoch、续租函数或所有权字段。

## 2. Supersede 基线中的组合 capability

基线 §4.1 的组合形状：

```text
{ turnOrigin, taskId?, nodeId, runtimeInstanceId,
  consumerLeaseEpoch, reservationId, expiresAt, allowedMethods }
```

由以下两个独立对象取代：

```text
LocalTurnCapability {
  turnOrigin, taskId?, reservationId, tuiOwnerLeaseId?,
  localGeneration, expiresAt, allowedMethods
}

HubDeliveryLeaseHandle {
  consumerNodeId, runtimeInstanceId, deliveryLeaseEpoch,
  leaseExpiresAt
}
```

`LocalTurnCapability` 可到达本机 tool proxy，但模型、TUI 和 Grok child 永远看不到
`HubDeliveryLeaseHandle`。Node adapter 在本机先验证 local capability，再独立调用共享
Hub primitive；Hub 只验证 server-resolved principal、delivery lease 和 operation id，
不信任或解释本机 `reservationId`。

这是分层的 conjunctive gate，不是组合 bearer：

```text
gateway: validate LocalTurnCapability
node adapter: verify local reservation is still active
hub: validate DeliveryConsumerLease + operationId at commit
```

任一层失败都不产生对应副作用，但一个对象绝不能冒充另一对象。

## 3. 对基线 §8.2 commit fencing 的澄清

Hub transaction 的 commit-time fencing 输入为：

```text
{ serverResolvedPrincipal, runtimeInstanceId,
  deliveryLeaseEpoch, operationId }
```

本机 gateway 在调用 node adapter 前另外检查：

```text
{ localGeneration, reservationId, turnOrigin, taskId }
```

Hub 不接收 `reservationId` 作为授权字段。若本机 reservation 在 Hub 调用前丢失，
adapter 不发请求；若 delivery lease 在 Hub commit 前丢失，Hub 拒绝提交。无法撤销的
vendor turn 仍进入 ambiguous/reconcile，不把 delivery lease takeover 解释成 turn cancel。

## 4. Grok 侧只做薄 adapter 与集成测

Grok runtime 允许新增的 Hub 相关代码仅限：

- 调用 #440 freeze 后的 claim/renew/ACK/reply typed client；
- 把 Hub 返回的 delivery status 映射到本地 task ledger；
- delivery lease 丢失时通知 scheduler 进入 recovering/ambiguous；
- 使用稳定 operation id 做 reply retry；
- 一个薄 integration suite，证明 Grok adapter 使用共享 primitive。

明确禁止：

- 在 Grok gateway 复制 principal 解析、row ownership、CAS、epoch、SQL 或 reply routing；
- 接受 alias/from 作为 consumer identity；
- 用 `TurnReservation`/`TuiOwnerLease` 代替 Hub delivery lease；
- 把 Hub delivery handle 暴露给 Grok child、TUI、prompt、MCP descriptor 或本机模型工具；
- 在 #440 schema/API freeze 前猜测 production wire 并写兼容分支。

## 5. 薄 adapter 验收

等 #440 contract freeze 后，Grok 只补以下共享入口集成测：

1. server-resolved Grok node principal 原子 claim 自己的 inbox row；
2. 第二 runtime instance 不能同时取得同一 row 的有效 delivery lease；
3. ACK/reply 只接受当前 delivery epoch，旧 epoch 不改变 row/result；
4. payload alias/from 改变不改变 Hub 解析的 consumer principal；
5. response-lost 后相同 operation id 重试只有一个 reply/result；
6. delivery lease 丢失触发本机 recovering，但不伪造 human interrupt 或释放另一个
   `TurnReservation`；
7. 本机 reservation 丢失阻止 adapter 发出 Hub mutation，但不篡改 Hub lease owner。

这些测试消费 #440 的生产 handler/typed client，不引入 Grok 专属授权旁路。Hub P0
未 freeze/未通过独立审查时，正式 runtime 的 inbox/ACK/reply E2E 与发布保持阻塞。
