# agent-network (CLI) 2.3.0-preview.243

与 `@sleep2agi/agent-node` **2.5.0-preview.211** 精确配对。

## Why

**把 antigravity（agy）相关代码真正带进 CLI 产物**。

`sleep2agi/agent-network@2.3.0-preview.242` 的 dist 是在 agy 相关改动合入之前构建的 ——
装上去之后 CLI 层面看不到 antigravity 的运行时接线（建 agy 节点 / 登录入口会莫名失败），
这一点由闻星主苹果管家在本地实测确认（`npm pack` 检查 dist 内容）。

同时带上 agent-node 2.5.0-preview.211 的修复：agy 回合真的把配置模型传给 `session/set_model`（#3705）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.243 @sleep2agi/agent-node@2.5.0-preview.211
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 agent-node `2.5.0-preview.211` 精确配对；只升一边会配不上。
