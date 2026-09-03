# `@sleep2agi/commhub-server@0.9.0-preview.47`

## 为什么发这一版:**名册里的 `blocked` 有出口了**(#1548)

`.46` 之后 `server/` 只有一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `72b2ad74` | #1793 | 终态 `send_reply` / `send_task` 成功后,把还标着 `blocked` 的发送方拉回 `idle`(只碰 blocked;`working` 可能真在忙,不动) |

| 用户看到的 | `.46` | `.47` |
|---|---|---|
| Dashboard 上一个活着、能收发任务的节点 | 可能永远显示 `blocked`(只有 `report_completion` 会拉回 idle,而多数 agent 用终态 `send_reply` 结束任务) | 它一回终态消息 / 一派任务就回到 `idle` |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.47
```

## Upgrade

生产 hub 按 `deploy/hub/README.md` 六步(sibling 安装 `~/.commhub/runtime-v4N-preview47`、VACUUM INTO 备份、bypass 9291 预启、只改启动器 RUNTIME_DIR 一行、`pm2 restart commhub-hub`、五点验证);自带 hub 的桌面端要等 sidecar 钉到 `.47`。

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.47   # 自托管
```

## 证据

- `server/src/blocked-exit-on-reply.test.ts` 3 条(blocked → 终态 reply → idle;blocked → send_task → idle;working 不动);变异去掉两处调用 → 2 fail。
- `bun run test`(test-aggregate,CI 同法):101 文件 1246 pass。

## promote 时的 must_contain

`releaseBlockedSession`(`.46` 产物 0 命中,已用闸 4 原样命令验;commhub-server 发的是 TS 源码,函数名保留)。
