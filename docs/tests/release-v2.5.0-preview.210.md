# agent-node 2.5.0-preview.210

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.242** 精确配对。

## Why

**daemon 创建 / 克隆节点时不再改写本机用户的 `~/.anet/config.json`**（#3627）。

以前 daemon 在起子节点时会连带改用户主目录里的那份配置，导致：
- 用户自己 `anet` 的登录态/节点列表被别人的节点创建动作波及；
- 多用户或多次 create 后，主目录配置与各节点实际配置不一致，排查时指错方向。

现在子进程用 `COMMHUB_URL` 拿 Hub 地址，**不再碰用户主目录的配置文件**。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.210 @sleep2agi/agent-network@2.3.0-preview.242
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 CLI `2.3.0-preview.242` 精确配对；只升一边会配不上。
