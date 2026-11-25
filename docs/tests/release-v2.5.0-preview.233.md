# agent-node 2.5.0-preview.233

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.268** 精确配对。Hub 不变（`0.9.0-preview.299`）。

## Why

- **会话交接时说清 OpenCode 为什么被拒（`#3890`）**：把会话交给新节点（source delivery）时，CLI 会打印 OpenCode 被拒的原因，但节点侧只保留错误码，原因从没进过日志。现在只放行 CLI 那一行固定格式的原因（路径 / 哈希前缀 / 平台 / 版本，最长 200 字），记为 `[source-resume] child refused because: …`；其它子进程输出照旧丢弃，不会带出密钥。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.233 @sleep2agi/agent-network@2.3.0-preview.268
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.233
anet upgrade
```
