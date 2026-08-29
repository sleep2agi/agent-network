# @sleep2agi/agent-network 2.3.0-preview.63 — release notes

配对发版：把 `anet hub start` 钉的 commhub-server 从 `.38` 升到 **`.39`**（带 inbox_count 全线 + 节点生命周期参数统一），并与 main 的 `PINNED_SERVER_VERSION` 一致。

## 为什么

commhub-server .39 带了 #1439/#1441（未读计数）+ #1281（参数统一）。本版把 agent-network 的 `PINNED_SERVER_VERSION` 同步到 `.39`，使 `anet hub start` 拉起的 hub 就是含这些修复的版本；同时 `PAIRED_AGENT_NODE_VERSION` 保持已发布的 `.48`。**无新增 agent-network 运行时代码**（承接 .62 的 #1437 node-stop 修复），仅版本 + server pin。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.63 @sleep2agi/agent-node@2.5.0-preview.48
anet node create
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.63
```

## 本版包含

- PINNED_SERVER_VERSION .38 → .39（`anet hub start` 拉起含 inbox_count 全线 + 参数统一的 hub）
- 承接 .62：#1437 `anet node stop` 不误判「进程先退了」

## Verification

- sync-pinned-versions.sh --apply 同步 server .39 + PINNED_SERVER_VERSION .39 + agent-network .63 + PAIRED（agent-node 保持 .48）
- getting-started version-claim 戳 zh+en 同步 preview=.63；check-doc-version-claims 通过
