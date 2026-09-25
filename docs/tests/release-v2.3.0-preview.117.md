# `@sleep2agi/agent-network@2.3.0-preview.117`

`.116` 之后 `agent-network/` 没有功能提交(`files: ["dist"]`;同期合入的 #2023 / #2024 只改 `docs-site/`,不进 tarball)。

本版唯一变化:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.90`(opencode 共存长任务在 300 s 整点「fetch failed」的修复,#2027),`PAIRED_AGENT_NETWORK_VERSION` 随之指向 `.117`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.117
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.117 @sleep2agi/agent-node@2.5.0-preview.90
```

🔴 **两个包要一起升**(`.117 ↔ .90`)。

## 证据

- 只改版本号与配对常量;doc 门(symbol-pins 两种调用 / source-pins / version-claims / locale-parity / home-path-baseline / release-channel-assertions)rc=0。

## promote 时的 must_contain

`"version": "2.3.0-preview.117"`
