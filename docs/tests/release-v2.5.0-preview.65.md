# agent-node 2.5.0-preview.65

`.64` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `b2575551` | #1811 | **#1809** —— 每次 `report_status` 都带 `version`(此前只有 3 分钟心跳带),旧 hub 上换 resume_id 后「没版本」的窗口从「到下一次心跳」缩到「到下一次状态变化」 |

## 这一版带给用户什么

名册里 grok 共存 / claude 节点的 version 列不再在每次任务后消失几分钟(hub 侧根治在 commhub-server `.49`,见 `release-v0.9.0-preview.49.md`;两边任一升级都有效,都升最好)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.65
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.65
anet daemon restart <daemon>        # 或 anet node stop <name> && anet node start <name>
```

## 证据

- `report-status-carries-version.test.ts` 2 条(状态上报字面量 + 心跳 payload);变异去掉新加行 → 1 红。typecheck 棘轮 81/81。
- PR #1811 在 main 上 109 项检查全绿(2026-09-04)。

## promote 时的 must_contain

`"version": "2.5.0-preview.65"`(闸 4 对整个 `package/` 目录 `grep -rq`,命中 package.json;`.64` 产物 0 命中)。
