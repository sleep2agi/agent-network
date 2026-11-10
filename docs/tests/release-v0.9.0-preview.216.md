# 0.9.0-preview.216

> 补上 `#3244` 漏掉的一半：**没有 turn 上下文的任务，补结果时不再强制要求 thread/turn**。

## 现场（2026-10-30 通信Dash欧）

它对一条 `failed` 任务调 `send_reply` 补结果，拿到 **`reply_task_terminal`** —— 因为它没有 `thread_id` / `turn_id` 可给。
为了补这条，只好先 `retry_task` 把任务重置成 `delivered` 再回复：

```
账本里那条从 failed 变成 retried→replied
「当初失败过」这个事实被抹掉了
```

`#3244`（`.213`）只放宽了「**id 对不上**」，没放宽「**必须提供 id**」。这一版补上。

## 语义

```
任务存了 thread/turn ⇒ 仍要求调用方给出**匹配**的 id（防串号，未改）
两个都是 null        ⇒ 不要求 id；归属 / 终态 / 回复目标 三条判据照样生效
```

落库用稳定占位值 `unrecorded`（该列是 NOT NULL）。
幂等键仍是 `(task_id, thread_id, turn_id)` ⇒ 同一任务的重复补发仍收敛成一条。

## 测试

```
task-late-reply-http：6 pass（新增 1 条）
  · 无上下文的任务不带 id 也能收下，且任务行不被改写
  · 反例：有上下文时仍必须匹配（盯住「别把放宽带偏」）
preflight 54 passed
```

## Install

```bash
npm i @sleep2agi/commhub-server@0.9.0-preview.216
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.216
# 或在部署机重启 hub 后核对 /health 的 version == 0.9.0-preview.216
```
