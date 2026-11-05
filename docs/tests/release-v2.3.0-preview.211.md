# @sleep2agi/agent-network 2.3.0-preview.211

Since `.210`: 配对常量跟到 `agent-node@2.5.0-preview.178`（节点侧的行为修复才能真正生效）。

## Why

`.178` 修的是「会话模型漂出配置后不自愈」：marker 记的是上次打开时的**配置**，
判据却当成上次打开时的**会话** ⇒ 配置说 xai、会话跑 deepseek，判据认为一致。

但启动器只跑**配对常量钉住的那个** agent-node 版本。常量不跟，`.178` 装在机器上也不会被用。

## What changed

```text
PAIRED_AGENT_NODE_VERSION: 2.5.0-preview.177 -> 2.5.0-preview.178
```

无其它行为改动。

## Verification

```text
gate 2（PINNED_* 版本审计）会在本 workflow 里检查配对常量与发布说明一致
安装后可用 `anet --version` 读回：
  Build ... · ✓ agent-node v2.5.0-preview.178
```

## What it does not do

- 不会自动重启任何节点；生效仍需一次 `anet node restart <name>`。
- 不改变 `.178` 里那条行为变化（TUI 手动切的模型，重启后回到配置值）。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.211
```

## Upgrade

```bash
anet node restart <name>
```
