# `@sleep2agi/agent-network@2.3.0-preview.108`

`.107` 之后 `agent-network/` 两个提交(与 agent-node `.82` 同一批):#1971(`codexBin` 进 profile 白名单与 CLI help)与 #1968(grok 共存各入口标「预览」、`anet node create --help` 的 Grok 段)。`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.82`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.108
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.108 @sleep2agi/agent-node@2.5.0-preview.82
```

🔴 **两个包要一起升。** 配对是精确的(`.108 ↔ .82`)。

## 边界与证据

- agent-network `tsc` 0 错;doc 门(symbol pins / source pins / version claims)rc=0;pair parity 测试绿。
- 打包声明 `dist/src/*.d.ts` 发版后按 `npm pack` 解包复核合作团队别名 0 命中。
- 发版判据仍是 registry 直读(tarball HEAD 200);超时**等**,不重发。

## promote 时的 must_contain

`"version": "2.3.0-preview.108"`
