# agent-network (CLI) 2.3.0-preview.242

与 `@sleep2agi/agent-node` **2.5.0-preview.210** 精确配对。

## Why

主要改动在 **agent-node 侧**：daemon 创建 / 克隆节点时**不再改写本机用户的 `~/.anet/config.json`**（#3627），
子进程改用 `COMMHUB_URL` 获得 Hub 地址。

CLI 这一版做版本对齐（配合 App 0.2.557 把 pin 升到这一对）。`anet pair` 会打印与当前 CLI 精确配对的那一行。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.242 @sleep2agi/agent-node@2.5.0-preview.210
```

## Upgrade

```bash
anet pair
anet upgrade
```

⚠️ 与 agent-node `2.5.0-preview.210` 精确配对。
