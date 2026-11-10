# 0.9.0-preview.214

> 修一个**上线 20 分钟内**就被真实调用抓到的 bug：凭据台账的汇总被分页截断。

## 现象

```
GET /api/networks/net_399bdf86f528/token-ledger?limit=5
→ summary: {"total": 5, "bound": 1, "unbound_node": 3, "unused_24h": 4, "unbound_node_in_use": 1}
```

那个网络实际有 **580** 个令牌。管理员会以为「只有 5 把钥匙」。

原因：`summary` 是用**当前页**的 `tokens` 数组统计出来的，分页直接污染了计数。

## 改法

```
summary   独立的全量聚合，不受 LIMIT 影响
          total / bound / unbound_node / unbound_node_in_use / unused_24h
tokens    仍然分页
returned  新增：这一页实际返回多少条
```

修复后同一请求应返回 `total 580 · bound 198 · unbound_node 381`。

## 为什么单测没抓到

```
测试里令牌都是刚造的几条，limit（默认 200）永远大于总数 —— 分页根本不生效。
要抓它必须同时满足：① 数据量 > limit（生产才有）② 真的发一个小 limit 的请求
```

## 测试

```
node-permissions-http：47 pass（新增：limit=1 时 tokens 被截断，summary 与 limit=1000 完全一致）
preflight 54 passed
```

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.214
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.214
# 或在部署机重启 hub 后核对 /health 的 version == 0.9.0-preview.214
```
