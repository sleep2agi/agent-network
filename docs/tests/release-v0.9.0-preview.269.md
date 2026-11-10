# commhub-server 0.9.0-preview.269

Since `.268`: `list_tasks` 新增 **`since_last`** —— 服务端水位，让「自上次以来新增」
不需要调用方记时间。

## Why

近 6h 生产读数（总 12,567 次调用）：

```text
org_whoami      1,556  12.4%   （11-01 是 29.8%）
get_all_status  1,346  10.7%   （11-01 是 26.4%）
list_tasks      6,316  50.3%   （11-01 是 19.1%）  ← 唯一的大头，还在涨
get_task        1,380  11.0%
```

提示词把前两项各砍了约 78%，但 `list_tasks` 绝对值涨了 38%。
`.268` 给了 `created_since`，可它要求**调用方自己记住上次的 server_time** ——
而「记住一个状态」正是每个调用方都会记错或忘掉的事。把状态放到服务端，就没得忘。

## What changed

```text
since_last: true
  首次调用（无水位）⇒ 全量，返回 since_from: null（不假装有水位）
  之后每次 ⇒ 只回「上次返回时刻之后创建」的，并把水位推到本次 server_time
  返回带 since_from / since_to
  与 created_since 同时给 ⇒ 明确报错 created_since_and_since_last_are_exclusive

新表 list_tasks_watermarks(network_id, caller_key, watermark) —— 按 (network, caller) 隔离
  节点令牌 → n:<bound_node_id>；用户令牌 → a:<username>
```

向后兼容：不传 `since_last` 时行为与 `.268` 完全一致，且**不写**水位。

## Verification

```text
server/src/list-tasks-since-last.test.ts  5 pass
  ① 首次无水位 ⇒ 全量 + since_from=null
  ② 中间插入一条 ⇒ 第二次只回它
  ③ 镜像：不传 ⇒ 全量且不写水位
  ④ 水位按 (network, caller) 隔离（B 不受 A 影响，仍是首次）
  ⑤ 与 created_since 同时给 ⇒ 明确报错
witness A（永不读水位）⇒ 只有 ② 那 1 例红
witness B（永不写水位）⇒ 只有 ② 那 1 例红
```

## What it does not do

- 不改调用方：节点仍要主动传 `since_last: true` 才生效（提示词能否办到，下一轮读数说了算）。
- 不保证「两次调用之间创建又删除」的任务被看到（轮询本就不保证完整历史）。
- 不与 `before_created_at` 分页联动：两者可以同时用，但语义不要混。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.269
```

## Upgrade

```bash
anet hub upgrade
```
