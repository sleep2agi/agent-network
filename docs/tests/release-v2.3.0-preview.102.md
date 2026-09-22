# `@sleep2agi/agent-network@2.3.0-preview.102`

`.101` 之后 `agent-network/` **没有功能提交**。本版是**配对 bump**:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.78`,以便 `anet` 接受修了 #1946 的 agent-node。

同期合入的三个提交都不进本包:#1950(opencode 共存 `ANET-COMMHUB.md` 生命周期,`agent-node/` 独有)、#1948(`docs-site/` 桌面版 0.2.83 戳)、#1949(`docs/` 披露口径)。

## 为什么要跟着发

两个包的配对是精确的(`anet` 用 `PAIRED_AGENT_NODE_SPEC` 解析并拒绝不配对的 agent-node)。只发 `agent-node@.78` 而不发本版,`anet@.101` 会继续要求 `.77`,新修复到不了任何一台由 `anet` 启动的节点。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.102
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.102 @sleep2agi/agent-node@2.5.0-preview.78
```

🔴 **两个包要一起升。** 配对是精确的(`.102 ↔ .78`);本版内容与 `.101` 相同,修复在 `agent-node` 里。

## 边界与证据

- 本包 `dist/` 与 `.101` 的差异只有 `opencode-agent-node-pair` 里的配对常量与 `getting-started` 的版本戳。
- 打包声明(`dist/src/*.d.ts`)延续 `.100` 起的干净状态:合作团队别名 0 命中(发版后按 `npm pack` 解包复核)。
- doc 门(symbol pins / source pins / version claims)rc=0;pair parity 测试绿。

## promote 时的 must_contain

`"version": "2.3.0-preview.102"`
