# commhub-server 0.9.0-preview.270

Since `.269`: 节点令牌调用 `list_tasks` 时，**不传 `omit_stats` 就默认省略 stats**。

## Why

近 6h 读数里 `list_tasks` 占 50.3%（6,316 次）。它每次都会顺带算一次
「按状态的全表 GROUP BY」——而 `stats` 是给**看图的人**用的计数，
轮询的节点根本不读它。

这类浪费只有改**默认值**才治得住：提示词对 list_tasks 已经三轮无效
（占比 19.1% → 35.7% → 50.3%）。

## What changed

```text
omit_stats 原来 .default(false)  ⇒ 无法区分「没传」与「传了 false」
现在 optional，未传时：
  节点令牌（callerTokenIsNetwork）⇒ 默认 true（省略 stats）
  用户令牌                        ⇒ 默认 false（看板要计数）
显式传 false 仍然可以要回来；返回里 stats_omitted:true 说明是默认省略的
```

## 为什么不顺便给 `since_last` 也设默认

`list_tasks` 同时被用来回答「我手上有哪些活」——那是**全集**问题。
默认 `since_last` 会让「早就派给我、一直没动」的任务消失，节点据此得出「没活」。
那是把一个**成本问题**换成一个**正确性问题**，不划算。

所以：`since_last` 保持 opt-in，由调用方明确说自己要的是「增量」；
本版只把「没有人需要的那部分开销」默认关掉。

## Verification

```text
server/src/list-tasks-omit-default.test.ts  4 pass
  ① 节点令牌 + 不传 ⇒ 无 stats + stats_omitted:true
  ② 节点令牌 + 显式 false ⇒ stats 回来（默认不是强制）
  ③ 用户令牌 + 不传 ⇒ 与以前一致（有 stats）
  · 镜像否定：节点令牌默认**不**启用 since_last（早派未动的任务仍可见）
witness：把默认改回恒 false ⇒ 只有 ① 那 1 例红（可隔离）
```

## What it does not do

- 不改 `since_last` 的默认（见上）。
- 不改节点侧的调用方式：本版省掉的是「没人读的那部分」，不是「调用次数」。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.270
```

## Upgrade

```bash
anet hub upgrade
```
