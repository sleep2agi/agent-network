# commhub-server 0.9.0-preview.263

Since `.262`: `/health.status_reasons` 的**值域**从「两个字面量散在两行 if 里」变成一份
被断言的声明 —— 它与它的生产者逐个对应。

## Why

`/health.status` 只有 `ok` / `degraded` 两个值，而 `status_reasons` 是回答
「ok 到底是**真的没问题**，还是**检查没跑**」的唯一读数。值域偏离生产者时：

```text
值域比生产者少 ⇒ 两个成因合并成一个字 ⇒ 读的人分不出该修哪
值域比生产者多 ⇒ 有原因却没有任何代码产生它 ⇒ 读者为它设计一条不存在的修法
```

两种都不红：`status` 照样是 ok/degraded，`status_reasons` 照样是数组。

## What changed

```text
+ export const STATUS_REASONS = ["db_unreadable", "license_unreadable"] as const
```

push 点**保留字面量**（`statusReasons.push("db_unreadable")`）而不是引用这个常量：
改成 `push(STATUS_REASONS[0])` 之后，抽取只能看见下标、看不见成因，
而「哪一行推了什么」正是这条检查要看的东西。常量的身份是**断言的靶子**，不是运行时入口。

## Verification

`health-status-reasons.test.ts`（4 pass）：

```text
① push 的字面量集合 == STATUS_REASONS
② push 点数 == 不同字面量数（同一个成因不许两处推 —— 否则「一个成因」看起来像两个）
③ 没有死值：每个成员都真的在某处被 push
④ status 由 reasons 派生（空 ⇒ ok；任一 ⇒ degraded），不是独立写的第二个真相
```

见证：

```text
加第三种成因（只 push 不改常量） ⇒ ① 红
常量里加一个没人 push 的值       ⇒ ①③ 红
```

`health-redaction.test.ts` 98 pass（含本文件 4 条）· 路由表 `--update` 后 `path: consistent`。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.263
```

## Upgrade

```bash
anet hub stop && anet hub start --server-version 0.9.0-preview.263
# 或（生产 profile）
scripts/deploy-hub-runtime.sh --version 0.9.0-preview.263
```

回读：

```bash
curl -s http://127.0.0.1:9200/health | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'],d['status_reasons'])"
```
