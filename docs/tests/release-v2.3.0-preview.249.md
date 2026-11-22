# agent-network (CLI) 2.3.0-preview.249

与 `@sleep2agi/agent-node` **2.5.0-preview.215** 精确配对。

## Why

只改配对常量：指向 agent-node `2.5.0-preview.215`（该运行时在建节点时铺浏览器能力：SKILL.md 双目录 + wrapper，Linux 带 `--no-sandbox`、先关残留 daemon、可选域白名单）。CLI 本体与 `.248` 一致。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.249 @sleep2agi/agent-node@2.5.0-preview.215
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```
