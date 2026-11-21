# agent-node 2.5.0-preview.211

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.242** 精确配对。

## Why

**agy（Antigravity）节点现在真的会把配置的模型应用到会话上**（#3705）。

`processWithAntigravity()` 调用 ACP 回合时从来没把 `model` 传下去，所以
`applyConfiguredModel` 永远拿到空值、直接按会话默认模型跑 —— 真机表现是：
节点配 `claude-sonnet-5-5-high`，任务自报却是 "Gemini 4 Neon"，改成别的模型重启后也一样。

现在补上 `model: MODEL || undefined`（与 grok 链同形）；另外当 agy 的
`session/set_model` 回空对象（没有 `_meta.model.Ok`）时会打一行 stderr，
不再把「没报错」静默当成「已生效」。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.211 @sleep2agi/agent-network@2.3.0-preview.242
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

⚠️ 与 CLI `2.3.0-preview.242` 精确配对；只升一边会配不上。
