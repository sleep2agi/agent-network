# `@sleep2agi/agent-network@2.3.0-preview.105`

`.104` 之后 `agent-network/` **没有功能提交**。本版是**配对 bump**:`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.79`(grok-build-acp 传模型 + set_model 回读,#1958)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.105
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.105 @sleep2agi/agent-node@2.5.0-preview.79
```

🔴 **两个包要一起升。** 配对是精确的(`.105 ↔ .79`);本版内容与 `.104`(fork 5 坑,#1954)相同,修复在 `agent-node` 里。

## 边界与证据

- 本包 `dist/` 与 `.104` 的差异只有 `opencode-agent-node-pair` 里的配对常量与 `getting-started` 的版本戳。
- doc 门(symbol pins / source pins / version claims)rc=0;pair parity 测试绿。
- 发版判据仍是 registry 直读(tarball HEAD 200);同日 `.102/.103` 经历过约 6 小时的 registry 延迟,超时**等**,不重发。

## promote 时的 must_contain

`"version": "2.3.0-preview.105"`
