# `@sleep2agi/agent-network@2.3.0-preview.119`

`.118` 之后 `agent-network/` 没有进 tarball 的代码改动。这是 pin-only 的 bump：`PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.92`（#2102：codex 大线程的 resume / 重连修复），`PAIRED_AGENT_NETWORK_VERSION` 随之指向 `.119`。发 agent-node 的当天必须同时发 agent-network preview，否则 `published-pins` 会红。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.119
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.119 @sleep2agi/agent-node@2.5.0-preview.92
```

🔴 **两个包要一起升**（`.119 ↔ .92`）。

## promote 时的 must_contain

`"version": "2.3.0-preview.119"`
