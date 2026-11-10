# commhub-server 0.9.0-preview.268

Since `.267`: 修 `created_since` 的**时间格式比较错**——用 ISO（带 `T`/`Z`）传参时，
`.267` 几乎总是返回空列表。

## Why（上线后十分钟就发现了）

`.267` 用字符串比较：

```sql
AND created_at > ?          -- created_at 存 'YYYY-MM-DD HH:MM:SS'（空格）
```

而客户端按文档传 ISO 8601（`2026-11-05T00:00:00Z`）。两者在第 11 个字符分高低：

```text
'2026-11-05 12:34:26'   vs   '2026-11-05T00:00:00Z'
             ^                          ^
         空格 0x20  <  'T' 0x54   ⇒ 库里所有当天记录都被判成"更早"
```

生产实测（部署 `.267` 后直读）：

```text
created_since=2026-11-05T00:00:00Z  → {"tasks":[],"count":0}
created_since=2099-01-01T00:00:00Z  → {"tasks":[],"count":0}
两个窗口给出同一个答案 ⇒ 过滤没有在工作
```

`.267` 的单测没抓到，因为测试里用的是**空格格式**——测试和文档各说各话。

## What changed

```sql
AND julianday(created_at) > julianday(?)
```

`julianday` 两种格式都认（ISO 带 T/Z、空格格式），并正确处理时区后缀。
代价是这一列上不能用索引直接比 —— 可接受：它只影响轮询窗口，而轮询本来就该返回极少行。

## Verification

```text
server/src/list-tasks-since.test.ts  6 pass（新增 ①b：ISO 带 T/Z 必须生效）
witness：退回 `created_at > ?` ⇒ 3 例红（同一格式问题的三种表现，记连坐）
```

## What it does not do

- 不改 `.267` 的其它行为（`omit_stats` / `server_time` 不变）。
- 不建索引；若将来窗口查询成为热点，应改成「存 epoch 整数列 + 索引」。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.268
```

## Upgrade

```bash
anet hub upgrade
```
