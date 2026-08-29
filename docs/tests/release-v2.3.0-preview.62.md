# @sleep2agi/agent-network 2.3.0-preview.62 — release notes

`anet node stop` 在「ps 拿到 pid」与「读 /proc 拿 birth」之间进程恰好退出时，不再把这个
**本就是想要的结果**误报成 `node stop failed`（#1437）。

## 为什么

`stopCommand` 的 legacy-fallback 支里，`processBirth(pid)` 读不到 birth 一律 throw
`NODE_OWNER_BIRTH_UNAVAILABLE` → `exit(1)`。而「进程在 ps 与 processBirth 之间退出」
正是 stop 想要的结果，却被当成失败。本版把「确证消失」（`kill(pid,0)` 抛 ESRCH）
从「读不到 birth」里拆出来：确证消失 ⇒ 跳过该 pid、不算错；进程仍在但读不到
（EPERM/未知）⇒ 仍然 throw（真问题不放过）。

无协议/DB/配置变化；纯 agent-network CLI 行为修复，不涉 hub、不涉 Codex/Grok runtime。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.62 @sleep2agi/agent-node@2.5.0-preview.48
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.62
```

## 本版包含

- #1437：`anet node stop` 不再把「ps→processBirth 之间进程消失」误报为失败（新增 `owned-roots.ts`，`processVanished` 仅 ESRCH 为真；行为级单测 + 两向 witnessed-red）

## Verification

- sync-pinned-versions.sh --apply 同步 package.json + lock(2处) + PAIRED_AGENT_NETWORK_VERSION=.62（PAIRED_AGENT_NODE_VERSION 保持已发布的 .48）
- getting-started version-claim 戳 zh+en 同步 preview=.62；正文当前 preview 版本号同步 .62；check-doc-version-claims 通过
