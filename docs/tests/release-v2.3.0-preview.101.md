# `@sleep2agi/agent-network@2.3.0-preview.101`

`.100` 之后 `agent-network/` **没有功能提交**。本版是**配对 bump**:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.77`,以便 `anet` 在解析运行时时拉到带 #1945 修复的那版。

同期合入的两个提交都不进本包:#1945(codex 队列行出队前先问 hub,`agent-node/` 独有)与 #1944(`docs-site/` 桌面版 0.2.82 戳)。

## 为什么要跟着发

两个包的配对是精确的(`anet` 用 `PAIRED_AGENT_NODE_SPEC` 解析并拒绝不配对的 agent-node)。只发 `agent-node@.77` 而不发本版,`anet@.100` 会继续钉 `.76`,用户装不到修复;一个合作机群(~30 台 codex 节点)只想开一次升级窗口,一跳拿到 `.76`+`.77` 的整套队列修复比两跳好。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.101
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.101 @sleep2agi/agent-node@2.5.0-preview.77
```

🔴 **两个包要一起升。** 配对是精确的(`.101 ↔ .77`);本版内容与 `.100` 相同,队列修复在 `agent-node` 里。

## 边界与证据

- 本包 `dist/` 与 `.100` 的差异只有 `opencode-agent-node-pair` 里的配对常量与 `getting-started` 的版本戳。
- 打包声明(`dist/src/*.d.ts`)延续 `.100` 的干净状态:合作团队别名 0 命中(发版后按 `npm pack` 解包复核)。
- `tsc --noEmit` rc=0;parity 门仍绿;doc 门全 rc=0。

## 披露

`2.3.0-preview.97` 至 `.99`(配对 agent-node `.73`–`.75`)的 `dist/src/*.d.ts` 注释中含有合作团队的节点别名;自 `.100` 起已改为中性表述。旧版本**不撤包**:撤包会打断所有钉了版本的使用者,代价大于暴露面。

## promote 时的 must_contain

`"version": "2.3.0-preview.101"`
