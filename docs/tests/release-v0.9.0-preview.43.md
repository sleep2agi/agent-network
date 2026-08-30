# @sleep2agi/commhub-server 0.9.0-preview.43 — release notes

三条 hub 侧改动：两条把 daemon「能不能建节点」这件事变成**可判定的**，一条给
`user_inbox` 加 schema 级保险带。

- **`create_node` 派发按 daemon 自报的能力设闸**（PR #1510，#1353 Fix ①）。
  此前 hub 会把 `create_node` 派给一个**其实建不了节点**的 daemon（例如它丢了
  `ANET_BIN_ABS`），daemon 侧失败，而调用方看到的是一个泛泛的错误 —— daemon
  仍然显示在线。现在闸设在**副作用之前**：daemon 上报 `can_create_nodes=false`
  时直接拒绝派发，并带上 `blocked_reason`。

- **`/api/host-supervisors` 透出 `can_create_nodes` / `create_nodes_blocked_reason`**
  （PR #1511，#1353 Fix ②）。Dashboard 的「建节点向导」据此决定某台服务器能不能选、
  不能选时给出原因。
  🔴 **`undefined ≠ false`**：只有 daemon 真的上报了 `daemon_capabilities` 才带这两个键；
  较旧的 agent-node 不上报时两个键**整个缺席**（不是 `false`）。消费方必须把「键缺席」
  当作「未知、按可建处理」，**不能**把缺席当成 blocked 而误灰掉一台健康的旧 daemon。
  文档见 `docs-site/docs/api/rest.md` 的 `GET /api/host-supervisors`（PR #1515）。

- **`user_inbox.network_id` 升到 schema 级 `NOT NULL`**（PR #1516，#1493）。
  「不产生 `network_id = NULL` 孤儿行」原本只是**代码级**保证（`send_desktop_message`
  INSERT 之前的三道闸，#1492 有测试钉着）；这一版把它也写进 schema，belt-and-suspenders。

🔴 **本版带一条 boot 期迁移，但它不会挡住启动**：SQLite 不能 `ALTER COLUMN ADD NOT NULL`，
所以走「建新表 → copy → rename」，并按 `sqlite_master` 幂等跳过。迁移前会数一次存量
`network_id IS NULL` 的行 —— **数到非 0 时是 `warn` + 跳过迁移（列保持可空），hub 照常启动**，
不是 abort boot。理由：这条约束是冗余保险带，代码级三闸已经在挡；为它拒绝启动等于用
整个舰队的 hub 停摆去换一个尚未发生的回归。孤儿行仍有明确的运维信号，人工清干净之后
下次启动迁移会自动完成。

**升级前的可选预检**（在旁路副本上，不碰生产库）：

```bash
sqlite3 <db-copy> "SELECT COUNT(*) FROM user_inbox WHERE network_id IS NULL"
```

预期 `0` —— `user_inbox` 自 `0.9.0-preview.41` 才建表，且代码级三闸从建表起就在。
详细步骤见 `deploy/hub/README.md` 的 step 4（旁路验证）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.68 @sleep2agi/agent-node@2.5.0-preview.53
anet hub start
```

hub 自己由 `anet` 按 `PINNED_SERVER_VERSION` 拉起（本版 `0.9.0-preview.43`），
通常不需要单独装 `@sleep2agi/commhub-server@0.9.0-preview.43`。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.68
anet hub restart
curl -fsS http://127.0.0.1:9200/health
```

🔴 别只看进程起来了 —— `/health` 返回才证明它在响应。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1510 | #1353 Fix ① | `create_node` 派发按 daemon 自报 `can_create_nodes` 设闸（副作用之前） |
| #1511 | #1353 Fix ② | `/api/host-supervisors` 透出 `can_create_nodes` / `create_nodes_blocked_reason`（undefined ≠ false） |
| #1516 | #1493 | `user_inbox.network_id` schema 级 `NOT NULL` + boot 期 warn+skip 迁移 |
