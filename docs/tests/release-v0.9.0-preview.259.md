# commhub-server 0.9.0-preview.259

Since `.258`: `GET /api/nodes` 多一格 `opencode_catalog_seen_at` —— 让「这份模型清单有多旧」第一次可读。

## Why

`opencode_catalog` 是 daemon 上报的**快照**。在此之前，Hub 把清单投影出来，却不投影它是**什么时候**采的 ——
于是客户端能看到 51 个模型，却无法区分「刚采的」与「三周前采的」。

`last_seen_at` 不能替代它：那是节点心跳时间，与目录采集时刻是两件事——节点可以一直在线而目录很久没刷新。

## What is added

| 字段 | 来源 | 缺省 |
|---|---|---|
| `opencode_catalog_seen_at` | `node.config_snapshot.opencode_catalog_seen_at`（daemon 上报） | `null` |

三态而不是两态：

```
null        ⇒ daemon 没有上报采集时刻（「不知道」，不是「很久以前」）
"2026-…Z"   ⇒ daemon 自己给的采集时刻
```

不把 `null` 折成「当前时间」或「很久以前」：折了之后，客户端只能显示一个它**并不知道**的时刻，
而「不知道」与「刚采过」在界面上看起来一样，处置却相反。

## What it does not do

它不采集这个值——**daemon 侧要开始上报**才有值。在客户端仓完成那一半之前，这一格恒为 `null`（当前生产实测：5 个上报目录的节点全部 `null`）。Hub 只做投影，不做推断。

## Verification

`api-nodes-shape.test.ts`（10 pass）：

1. 有 `opencode_catalog_seen_at` ⇒ 原样投影；
2. 没有 ⇒ `null`（并断言**不是空串、不是当前时间**）；
3. 原有的精确键集断言同步加了这一格——那个文件自己写着「treat a diff here as re-read the handler」，不同步就等于它在描述一份旧拷贝。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.259
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.259
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-259 pm2 restart <name> --update-env
```

回读：

```bash
curl -s -H "Authorization: Bearer <utok>" http://127.0.0.1:9200/api/nodes | jq '.nodes[0] | {opencode_catalog_seen_at, catalog: (.opencode_catalog|length)}'
```
