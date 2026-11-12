# agent-network (CLI) 2.3.0-preview.239

与 `@sleep2agi/agent-node` **2.5.0-preview.207** 精确配对。

## Why

`.207` 修的是 **control 消息的并发处理**：`.206` 已经让带 `control` 的 `new_message` 唤醒工作通道，
但工作通道是串行 lane、会被正在跑的回合占住 ⇒ interrupt 要等回合跑完才被取到，实测 `interrupted:false`
（没东西可停了）。现在 SSE 收到 `control` 事件时并发取一次 control 行立刻打断，不等回合结束。

修复在 agent-node 侧。CLI 这一版**没有行为变更**，只做版本对齐 —— 因为 `anet pair` 是按
「CLI ↔ agent-node」精确配对给升级命令的，少一边就会配错。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.239 @sleep2agi/agent-node@2.5.0-preview.207
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-node `2.5.0-preview.207` 精确配对；单独升 CLI 不会让停止生效，必须同时升节点。
