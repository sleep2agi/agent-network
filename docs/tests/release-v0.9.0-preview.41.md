# @sleep2agi/commhub-server 0.9.0-preview.41 — release notes

这一版把 **agent → 用户 desktop message 的读写两侧一次配齐**。上一版（`.40`）只做到「让丢失可见」——
`send_desktop_message` 不再谎报成功，但消息在用户 dashboard 关着时**仍然会丢**。本版让它不再丢。

- **`user_inbox` 建表打底**（PR #1481，#1459 ① P1，schema-only）。按 `user_id` 寻址的新收件表，
  不复用按 alias 寻址的 `inbox` —— 复用会让 `/api/messages` / `inbox_count` / SSE gate 那一票
  alias 域查询隐性开始返回用户消息。`message_id` 即主键，send 重投天然幂等。
- **写入落库**（PR #1485，#1459 ① P2）。`audit_log` 与 `user_inbox` 放进**同一个事务**，
  push 在提交之后 —— 此前只写审计不写收件，会出现「审计说发过、用户永远收不到」。
  返回值里 `persisted` 反映真实落库结果。
- **回读 + ack + 未读数 + 回读脱敏**（PR #1488，#1459 ① P3）。新增
  `GET /api/messages?scope=user[&unacked=1][&limit=N]` 与 `POST /api/messages/ack`：
  - 收件人**取自鉴权上下文**，`?user_id=` 传什么都不生效；复用既有 `addNetworkScope` 网络隔离；
  - 响应带 `unread` / `pending_count`（同一次计算），**客户端"不显示新消息数"从此有服务端数据源**；
  - **回读时脱敏**：写入方是 agent、不受信任，回读会遮住
    `ntok_` / `utok_` / `atok_` / `ghp_` / `github_pat_` / `xox[bpoars]-` / `sk-` 形状的串；
  - 新增 `idx_user_inbox_user_acked(user_id, acked, created_at)`。
- **写读接缝的端到端回归**（PR #1492）。此前写侧测试不碰回读、读侧测试用 SQL 播种行，
  两半各自绿而端到端从没验过。现在有一条测试走完整条：真实 `send_desktop_message` →
  真实 `GET /api/messages?scope=user`。

🔴 **关于隔离**：同一个 network 里的两个成员之间，`WHERE user_id = ?` 是**唯一**的隔离手段
（网络 scope 对他们是同一个值）。这一格有专门的夹具和变异证据，见 #1488。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.66 @sleep2agi/agent-node@2.5.0-preview.51
anet hub start
```

hub 自己由 `anet` 按 `PINNED_SERVER_VERSION` 拉起（本版 `0.9.0-preview.41`），
通常不需要单独装 `@sleep2agi/commhub-server@0.9.0-preview.41`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.66
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1481 | #1459 ① P1 | `user_inbox` 建表（schema-only，零行为变化） |
| #1485 | #1459 ① P2 | 写入落库，audit + inbox 同事务、push 在提交后 |
| #1488 | #1459 ① P3 | `?scope=user` 回读 + ack + `unread` + 回读脱敏 + 索引 |
| #1492 | #1459 | 写→读接缝端到端回归；NULL 孤儿行可达性分析（写路径产不出，三道闸） |

**下游可以接了**：客户端拿 `unread` 显示未读数、拿 `?scope=user` 在重连后补齐离线期间的消息。
