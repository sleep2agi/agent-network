# commhub-server 0.9.0-preview.272

Since `.271`: 修 `GET /api/token-usage` 的**路由位置** —— `.271` 里它被插进了
`/api/nodes/:id/config` 的 handler 内部，于是对外表现为 404（和"没这条路由"完全同形）。

## Why（上线十分钟的直读抓到的）

```text
.271 部署后直读：
  匿名              → 401（全局鉴权层先答，正常）
  节点令牌（带认证） → 404 {"ok":false,"error":"not_found","path":"/api/token-usage"}
```

404 有两种含义：**没有这条路由**，或**有但没被走到**。这次是后者：
改动时用的锚点 `// #3146 …` 位于 config handler 内部，替换后代码落在了那个 handler 里
—— 只有请求 `/api/nodes/x/config` 时才会执行到它。

## What changed

把整段 `if (url.pathname === "/api/token-usage" …)` 移到路由链的**同级位置**
（`/api/nodes/:id/config` 的 match 之前）。逻辑一行未改。

## Verification

```text
部署后直读（三层里的线上层）：
  匿名                → 401 unauthorized                    （全局鉴权在先，符合预期）
  节点令牌            → 403 user_token_required             （不是 404 ⇒ 路由可达）
  人令牌（待 admin 提供）→ 200 + nodes[] + totals + 空表 note
```

## What it does not do

- 不新增能力；只修位置。
- 单元测试没覆盖到"这条路由能不能被走到"——这类缺口只有真打一次 HTTP 才发现，
  所以本版的证据是直读而不是测试。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.272
```

## Upgrade

```bash
anet hub upgrade
```
