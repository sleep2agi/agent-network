# agent-network (CLI) 2.3.0-preview.244

与 `@sleep2agi/agent-node` **2.5.0-preview.212** 精确配对。

## Why

带两笔 CLI 侧改动 + 配对到 agent-node .212：

1. **Windows 放行 ACP stdio（opt-in）**（#3728）—— `anet node start` 在 win32 上原先只允许
   `claude-agent-sdk`；现在 `antigravity-acp` 在 `ANET_ALLOW_ACP_WINDOWS=1`（字面 1）时放行，
   其余 TUI / co-presence 运行时仍然挡。报错文案也补上了这个开关名与「Windows 原生
   first-reply + stop 未验证」的事实。
2. **配对常量** —— 指向 agent-node `2.5.0-preview.212`（该运行时含 agy 跨任务会话持久化
   #3727 与 Windows 子进程 PATH 补全 #3729）。

默认行为不变：不设 `ANET_ALLOW_ACP_WINDOWS=1` 时，Windows 上的可用运行时与 `.243` 完全一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.244 @sleep2agi/agent-node@2.5.0-preview.212
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 agent-node `2.5.0-preview.212` 精确配对；只升一边会配不上。
