# @sleep2agi/agent-network 2.3.0-preview.215

Since `.214`: 配对常量跟到 `agent-node@2.5.0-preview.181`（三种运行时上报 token 用量）。

## Why

`.180`（claude/codex 上报）与 `.181`（opencode 增量上报）都已发布，但启动器只跑
配对常量钉住的那一版 —— 常量不跟，机器上装了什么都不会被用。

## 这次差点造成一次停机，写清楚

`.181` 的 pair 常量与 `.181` 同一次提交推到主干，而 `.181` 当时**还没出现在 registry**。
那个窗口期里我做了一次节点重启，启动器报：

```text
No exact trusted global @sleep2agi/agent-node@2.5.0-preview.179 is available
Install the exact vetted pair: …
```

节点因此离线约 3 分钟，直到把启动器要的 .179 装回全局。

⇒ 规矩：**pair 常量必须在目标版本可见之后再改**，或两版同一提交一起发；
   否则「装什么版本都对不上」，而失败只发生在重启的那一刻。

## What changed

```text
PAIRED_AGENT_NODE_VERSION: 2.5.0-preview.179（本机实际在跑的） -> 2.5.0-preview.181
上手指南 version-claim: .214 -> .215（gate 4 要求与发布同提交）
```

## Verification

```text
安装后 anet --version 应读回：✓ agent-node v2.5.0-preview.181
节点重启后 /api/token-usage 与 scripts/report-node-token-usage.py 应出现真实行
```

## What it does not do

- 不改运行时行为；token 上报逻辑在 agent-node .180/.181 里。
- 不会自动重启任何节点。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.215
```

## Upgrade

```bash
anet node restart <name>
```
