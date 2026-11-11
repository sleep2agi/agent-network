# agent-network (CLI) 2.3.0-preview.238

与 `@sleep2agi/agent-node` **2.5.0-preview.206** 精确配对。

## Why

`.206` 修的是 **control 消息的唤醒**：`send_message(alias, control="interrupt")` 发出的
`inbox.type=control` 行，`.205` 之前两条 SSE lane 都不收（工作通道只在 `new_task`/`broadcast`
时唤醒），实测节点在跑长回合时发出去 `acked=0`、回合结束后仍未取，看起来像「停止按钮没反应」。

修复在 agent-node 侧。CLI 这一版**没有行为变更**，只做版本对齐 —— 因为 `anet pair` 是按
「CLI ↔ agent-node」精确配对给升级命令的，少一边就会配错。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.238 @sleep2agi/agent-node@2.5.0-preview.206
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.206` 精确配对；单独升 CLI 不会让停止生效，必须同时升节点。
