# 0.9.0-preview.198

> 「在线但干不了活」的节点，现在也会被告警——即使它一条任务都不接。

## 问题

`.197` 修的是：节点**产生了失败**，但分类器认不出真实的登录失效文案。

还有一种更安静的情况：

```
节点启动后登录已失效 → 它不接任何任务 → 「连续失败」那条告警路径永远不会触发
hub 上它显示在线，实际上干不了任何活
```

## 本版

patrol 每轮扫一次「状态是 error、且原因是登录失效」的会话：

```
sessions.status = 'error' 且 task 命中 login_required 分类
→ 给节点主人发一条 login_expired 告警（每节点每天一条）
```

- 类别单列 `login_expired`，不并进「连续失败」——两者处置路径不同
- 去重用日期，不是每 5 分钟重发（这是状态，不是一次失败）
- 与 `scanNodeFailureAlerts` 并列，各带 try，一路失败不影响另一路

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version   # 0.9.0-preview.198
# 有登录过期且被启动的节点时，收件箱出现 title「节点在线但不会接活：登录失效」
```

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.197`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.198
commhub-server --version   # 0.9.0-preview.198
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.198
commhub-server --version   # 0.9.0-preview.198
```
