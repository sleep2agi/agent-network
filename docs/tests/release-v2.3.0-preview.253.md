# agent-network (CLI) 2.3.0-preview.253

与 `@sleep2agi/agent-node` **2.5.0-preview.219** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.219`（CLI 等选项信号接通：agy / grok 子进程 stderr 观测 → `interactive_prompt` → Hub `prompt_pending`）。CLI 本体与 `.252` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.253 @sleep2agi/agent-node@2.5.0-preview.219
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```
