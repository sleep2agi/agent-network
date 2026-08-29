# @sleep2agi/agent-network 2.3.0-preview.61 — release notes

配对补发：把 npx 通道钉的 agent-node 版本从 `.47` 更新到 **`.48`**，与 main 源码的
`PAIRED_AGENT_NODE_VERSION` 一致。

## 为什么

上一版 agent-node@2.5.0-preview.48（grok 换模型崩修复）发版时 bump 了源码里的
`PAIRED_AGENT_NODE_VERSION` → .48，但**没有配对补发 agent-network** —— 于是已发布的
`agent-network@2.3.0-preview.60` 的 `PAIRED_AGENT_NODE_VERSION` 仍是 `.47`，与源码漂移
（published-pins 门本应报，但那门另有零覆盖 bug，见 #1430）。本版补齐配对。

功能影响：codex / opencode 的 npx 通道现在钉 agent-node@.48（含最新修复）；grok/claude
通道用全局安装的 agent-node，不受此钉影响。**无新增 agent-network 代码，仅版本 + 配对钉。**

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.61 @sleep2agi/agent-node@2.5.0-preview.48
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.61
```

## 本版包含

- 配对钉更新：PAIRED_AGENT_NODE_VERSION .47 → .48（消除 published-pins 漂移）

## Verification

- sync-pinned-versions.sh --apply 同步 package.json + lock + pair 文件（PAIRED_AGENT_NETWORK_VERSION=.61、PAIRED_AGENT_NODE_VERSION=.48）
- getting-started version-claim 戳 zh+en 同步 .61；check-doc-version-claims --package agent-network --version 2.3.0-preview.61 通过
