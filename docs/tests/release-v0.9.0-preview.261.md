# commhub-server 0.9.0-preview.261

Since `.260`: **父任务推断不再是「取最近一条 delivered」**，而是「候选唯一 + 10 分钟内」。
并且 `/health` 的 counters 里多了一组 `parent_infer`，让「收窄了多少」变成可读数。

## Why

`#669` 的前置统计（近 7 天，按 `meta_json.parent_source` 分）：

```
inferred  795 条（78% 的有父任务派发靠推断）
explicit  222 条

inferred 非正常收尾 48/795 = 6.0%（expired 43 · failed 17 · cancelled 5）
explicit 非正常收尾  1/222 = 0.5%
```

两个数一起读才有方向：

- 78% ⇒ **不能取消推断**（取消会让 795 条/周失去父链，回复链全断）
- 12 倍失败率 ⇒ 它确实在挂错父任务（子任务回复提前关掉那条还没开始的 `delivered`）

所以这一版既没删也没留原样，而是给它加上一直缺的那条条件。

## What changed

```text
旧：该节点名下最近一条 delivered ⇒ 就是父任务
新：候选必须唯一（delivered 条数 == 1）且 created_at 距今 <= 10 分钟 ⇒ 才是父任务
```

两条都是可改常量（`server/src/parent-infer.ts` 的 `INFER_WINDOW_MS`）：

| 情形 | 旧行为 | 新行为 |
|---|---|---|
| 唯一候选、刚派不久 | 挂上 | 挂上 |
| 多条候选 | 挂「最近那条」（**挂错的来源**） | **不挂**，`rejected_ambiguous` +1 |
| 唯一候选但很旧 | 挂上（那是排在后面还没轮到的） | **不挂**，`rejected_too_old` +1 |
| 唯一候选但 `created_at` 读不出 | 挂上 | **不挂**（无法证明「刚派不久」，而那是这条约束的全部价值） |
| 本来就没有候选 | 不挂 | 不挂，**不计数**（常态，不是拒绝，计入会让分母虚高） |

## New counters

`GET /health` → `counters.parent_infer`：

```json
{ "since": "2026-11-01T03:30:00.000Z", "accepted": 0,
  "rejected_ambiguous": 0, "rejected_too_old": 0, "window_ms": 600000 }
```

没有这组计数时，收窄是看不见的：任务照常派出，只是没有父——
「收窄生效」与「收窄没写对」在派发日志里同形，两者的 7 天失败率都会下降。

## Verification

```text
parent-infer.test.ts          7 pass（窗口边界 <= · 年龄未知算拒绝 · 多候选不退化成取最新）
parent-source-marker.test.ts  5 pass
受影响链路回归               115 pass / 0 fail（4 文件）+ 27 pass（health / dispatch）
```

两条断言拆成两个 test，各破一条各红一条：

```text
只把 LIMIT 5 退回 LIMIT 1          ⇒ 红「取候选必须看得到不止一条」
只把 verdict.ok 改成恒真（撤销收窄）⇒ 红「推断命中时改写为 inferred」
```

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.261
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.261
# hub run by pm2 (production profile) —— 本仓用部署脚本切运行时
scripts/deploy-hub-runtime.sh --version 0.9.0-preview.261
```

回读（收窄是否在跑，看这组计数是否随派发增长）：

```bash
curl -s http://127.0.0.1:9200/health | jq '.counters.parent_infer'
```
