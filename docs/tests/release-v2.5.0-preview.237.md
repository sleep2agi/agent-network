# agent-node 2.5.0-preview.237

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.272** 配对；CLI `2.3.0-preview.273` 起精确配对到本版本。配套 Hub `0.9.0-preview.307`。

## Why

- **密钥热生效 Phase-1（`#5675` PR-3）**：对 5 个自拉起 runtime（`claude-agent-sdk`、`codex-sdk`、自建 `codex-app-server`、`grok-acp`、`antigravity-acp`）开放 `secrets_hot_capable`。保存密钥后，下一轮请求直接用新值：**不重启进程、会话 ID 不变**；节点正在跑时延后到空闲（`hot_pending_idle`），被同名外层变量遮住时报 `shadowed` 且不重启不唤醒。
- **不改变运行中进程的 `process.env`**：只重建该节点的子进程调用环境；删除严格限 `managedSecretKeys`，不碰系统/外层环境变量。
- **激活状态四态**：`hot_applied` / `hot_pending_idle` / `shadowed` / `next_start`，App 直接展示，不用猜。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.237 @sleep2agi/agent-network@2.3.0-preview.272
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.237
anet upgrade
```
