# agent-node 2.5.0-preview.221

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.255** 精确配对。

## Why

两笔：

```text
#3778（#5332）回合控制能力位：config_snapshot 上报 turn_interrupt_capable / turn_steer_capable
        —— 只有真具备通道的 runtime 为 true（当前仅 OpenCode V2 共存）；客户端据此决定显示哪些按钮
#3780  agy ACP session/load 历史全量重放修复
        —— 在 session/prompt 发出前门控历史重放，根治 agy 每轮回复飙到 96–98 KB 的复读
        （微软测试鸽 连续 10 条 98KB 导致客户端进页卡顿）
```

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.221 @sleep2agi/agent-network@2.3.0-preview.255
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 验证口径

```text
· #5332：能力位投影测试 2 pass（true/false 原样、老节点 null）
· #3780：antigravity-acp / acp-runner / grok-build-acp 14 个测试文件 107/107（通信鸽 本地）
```
