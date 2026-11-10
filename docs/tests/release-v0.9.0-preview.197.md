# 0.9.0-preview.197

> 凭据过期的节点，现在**发得出告警**了。

## 问题

`#2840` 的节点失败告警会分类「确定性失败」，其中登录类是：

```ts
/login required|Unauthorized|\b401\b/i
```

而生产里真实的文案（`agent-node/src/runtime/codex-health.ts` 生成）是：

```
codex-app-server 错误: model login expired: this node's CODEX_HOME (…) needs a fresh login
— log in again there: CODEX_HOME=… codex login. Not taking work until then (…).
```

**三处都对不上**：不是 "login required"，也没有 401。分类器返回 `null`，于是这个节点在告警系统里是隐形的。

实测（2026-10-29，`dsh副责人`）：凭据过期的节点启动后每一轮都以这句失败，而告警一条都不会发。

## 本版

```ts
/login required|Unauthorized|\b401\b|model login (?:expired|revoked)|needs a fresh login/i
```

只补两种状态词与那句固定结尾，**不泛化到 auth 字样**（宽泛匹配会把「任务正文在讨论这件事」也算进来）。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version   # 0.9.0-preview.197
```

有凭据过期的节点时，收件箱应出现 `node_failure_alert`，类别 `login_required`。

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.196`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.197
commhub-server --version   # 0.9.0-preview.197
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.197
commhub-server --version   # 0.9.0-preview.197
```
