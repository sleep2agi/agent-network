# 0.9.0-preview.213

> 两处「本该看见却看不见」的修补：**钥匙清单**与**迟到的结果**。

## 1. 凭据台账：哪把钥匙、绑没绑、还在不在用

现有 `node-permission-report` 是**按流量**聚合的，只列「近 N 天有调用」的身份。生产实测：

```
未吊销令牌 760 个
  node: 开头但未绑定节点：381 个（50%）
  其中近 24h 有流量：4 个
  ⇒ 剩下 377 个在任何报表里都不存在
```

于是「这把钥匙还有人在用吗」永远答不清，也就不敢吊销。而它们正是权限体系最大的盲区：
没有 `nodes` 行 ⇒ 三张白名单都管不到。

新增 `GET /api/networks/:id/token-ledger`（人的令牌 + 网络 owner/admin；节点令牌 403）：

```json
{
  "summary": { "total": 580, "bound": 198, "unbound_node": 381, "unused_24h": 576, "unbound_node_in_use": 4 },
  "tokens": [
    { "name": "node:TM试验欧", "bound_node_id": null, "unbound_node": true,
      "last_used_at": "2026-10-29 12:00:00", "calls_24h": 30, "writes_24h": 30,
      "top_tools": [{ "tool": "mcp:send_message", "hits": 20 }] }
  ]
}
```

判据只有两列：**未绑定且有流量 → 先改它；未绑定且零流量 → 可批量吊销。**
只读、不返回 token 值（Hub 本来就只存 hash）。

## 2. 迟到结果：任务没有 turn 上下文时不再被挡掉

`通信客户端欧` 近 24h 失败 36 次、成功 26 次，全部是「共享会话被 TUI 占着超过 30 分钟」。
其中一类是**活干完了、结果不再回传**。

Hub 本来有迟到结果通道（`send_reply` → `task_late_replies` → 投递给原发送方），但判据是
「任务存的 thread/turn == 客户端给的」。实测：

```
「仍在 TUI 里运行、等待超 30 分钟」的失败任务 289 条
  其中 thread_id/turn_id 非空：0 条
全库 task_late_replies：4 行
```

存的是 `null` ⇒ 永远不等 ⇒ 迟到结果 100% 被拒。

现在：**仅当存的两个 id 都是 null 时放行**（存了 A 来了 B 仍然拒）。
归属、终态、回复目标三条判据一条没动；仍只写 append-only 账并投递给原发送方，
不改写任务行、不跑父任务回链。

## 测试

```
node-permissions-http：46 pass（新增 2 条凭据台账）
task-late-reply-http：5 pass（新增 1 条无上下文的迟到结果）
preflight 54 passed
```

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.213
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.213
# 或在部署机重启 hub 后核对 /health 的 version == 0.9.0-preview.213
```
