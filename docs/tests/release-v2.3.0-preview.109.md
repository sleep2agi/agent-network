# `@sleep2agi/agent-network@2.3.0-preview.109`

`.108` 之后 `agent-network/` **没有功能提交**。本版是**配对 bump**:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.83`(#1645 告警不再对新 codex 误报,#1973)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.109
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.109 @sleep2agi/agent-node@2.5.0-preview.83
```

🔴 **两个包要一起升。** 配对是精确的(`.109 ↔ .83`);本版内容与 `.108` 相同,修复在 `agent-node` 里。

## 边界与证据

- 本包 `dist/` 与 `.108` 的差异只有 `opencode-agent-node-pair` 里的配对常量与 `getting-started` 的版本戳。
- doc 门(symbol pins / source pins / version claims)rc=0;pair parity 测试绿。
- 发版判据仍是 registry 直读(tarball HEAD 200);超时**等**,不重发。

## promote 时的 must_contain

`"version": "2.3.0-preview.109"`
