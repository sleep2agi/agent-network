# 0.9.0-preview.194

> 未匹配的 `/api/*` 路径返回 **404**，不再用「200 + 帮助页」把错误伪装成成功。

## 现场

```
带 token: GET /api/lang/status          → 200 + 652B 帮助页
带 token: GET /api/hub/profile          → 200 + 同样的帮助页
带 token: GET /api/nodes/department     → 200 + 同样的帮助页
带 token: GET /api/schedules/failures   → 200 + 同样的帮助页
```

四个**不存在**的路径返回完全相同的字节、状态码 200。

## 为什么这不是小事

它不是「返回错内容」，而是**把错误伪装成成功**：

- 探针 / 监控把「端点改名或拼错」读成「200 正常」—— 假绿
- Agent 调错路径时拿到一大段帮助文本，可能当接口返回去解析
- 写这份发布说明的人自己就被它骗过一次：把 4 个不存在的端点列进了「冒烟通过」清单

与 `#2559`（401 被伪装成空数据）是同一类问题的第三种形态。

## 改法

```
未匹配且路径以 /api/ 开头  → 404 {"ok":false,"error":"not_found","path":"…"}
根路径 /                   → 仍返回帮助页（认证门在路由之前，行为不变）
```

## 一个已核的副作用

`/api/task` 只处理 POST ⇒ `GET /api/task` 从「200 + 帮助页」变成 404。
这个组合从未被实现为接口；更精确的 405（路径存在、方法不匹配）需要「路径 → 允许方法」映射，另议。

## 上线后怎么验

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" \
  http://127.0.0.1:9200/api/definitely-not-a-route     # 期望 404
curl -s -H "Authorization: Bearer <token>" \
  http://127.0.0.1:9200/ | head -1                      # 期望 CommHub MCP Server v…
```

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.193`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.194
commhub-server --version   # 0.9.0-preview.194
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.194
commhub-server --version   # 0.9.0-preview.194
```
