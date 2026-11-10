# @sleep2agi/agent-node 2.5.0-preview.174

Since `.173`: 上报模型清单时**一起报采集时刻**（`opencode_catalog_seen_at`）。

## Why

生产实测（2026-11-01，`~/.commhub/commhub.db`）：

```text
nodes 有 config_snapshot      243
  其中带 opencode_catalog     5   （51 / 51 / 51 / 51 / 10 个模型）
  其中带 opencode_catalog_seen_at  0   ← 一个都没有
```

Hub 的 schema 和 `/api/nodes` 投影早就有了这一格（`#3144`），缺的一直是**发送端**。
于是客户端拿到 51 个模型，却答不出「这份清单是刚才采的还是三周前的」——
而 `last_seen_at` 是节点心跳时间，不是采集时刻，两者不能互相顶替。

## What changed

- `runtime/opencode-catalog-report.ts`（新）：快照 → 上报形状的纯函数，两条规则
  ① 空清单不报（「0 个模型」与「没采到」是一个结论的两个方向，不能塌成一个）；
  ② 采到模型但没有采集时刻时**不编一个**（编出来的时刻会把「不知道多旧」显示成「刚刚」）。
- `cli.ts`：`opencode_catalog` 与 `opencode_catalog_seen_at` 放进同一个对象字面量，
  后者挂在 `reportedCatalog.seenAt ?` 这个条件上（空串时不发）。

## Verification

```text
opencode-catalog-report.test.ts          6 pass（含「时刻缺失 ⇒ seenAt 为空串而不是编一个」）
report-status-catalog-seen-at.test.ts    3 pass（源码契约：两格在同一字面量 + 守卫位置 + 旧写法必须消失）
witness：删掉 cli.ts 里 seen_at 那一行 ⇒ 后两例红；复原 ⇒ 9 pass
bun build src/cli.ts 通过（453 modules）
```

## What it does not do

- 不改 Hub（schema 与投影本来就有）；不需要同步发 Hub 版本。
- 不报 `defaultModel` 与 provider 的 `activation`（`auto|enabled|disabled`）——
  快照里有，但 Hub 侧还没有对应的 schema 格；那是下一个小卡。
- 采集时刻是**采集**时刻，不是**可用性**：清单里有不等于账号调得通。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.174
```

## Upgrade

```bash
anet node upgrade
anet upgrade
```
