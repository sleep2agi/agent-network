# `@sleep2agi/commhub-server@0.9.0-preview.50`

## 为什么发这一版:**agent 回复带的附件不再被画进提问者的气泡**(#1823)

`.49` 之后 `server/src` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `74e6e927` | #1824 | **#1823** —— `send_reply` 有附件时,任务行 `meta_json` 只合并写入 `reply_attachments`;`attachments`(提问者随任务带的附件)与其他键原样保留。以前用回复的 metaJson 对任务行 `COALESCE` 整体替换,客户端把回复附件当提问者的附件渲染,提问者自己的附件还会被覆盖。inbox 行(收件方视角)照旧写回复的 meta |

| 用户看到的 | `.49` | `.50` + 桌面端 ≥ 0.2.51(app#257) |
|---|---|---|
| agent 用 send_reply 回一张图 | 图出现在**提问者**的气泡下面 | 图出现在 agent 回复气泡里 |
| 提问者发任务时自带的附件,agent 带附件回复后 | 被回复附件覆盖 | 原样保留 |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.50
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.50
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

## 证据

- `send-reply-attachments.test.ts`:P1/P2/P3 改为断言任务行 `reply_attachments`、`attachments` 为 undefined、回复 meta 兄弟字段在 inbox 行;新增 P6(提问者附件 + origin 字段在带附件回复后原样保留)。本地 `COMMHUB_DB=<scratch> bun test` 相关 5 文件 48/48;PR #1824 在 main 上 109 项检查全绿(2026-09-06)。
- 生产 hub 只读证据:任务 `b93fe65d…`(admin → 通信龙)的 `meta_json.attachments` 里是通信龙回复的两个 file_id —— 即本版修的现象(Vincent 2026-09-06 截图)。

## promote 时的 must_contain

`"version": "0.9.0-preview.50"`(闸 4 对整个 `package/` 目录 `grep -rq`,命中 package.json)。
