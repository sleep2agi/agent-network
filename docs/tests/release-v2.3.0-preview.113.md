# `@sleep2agi/agent-network@2.3.0-preview.113`

配对版本号前移:`agent-network/` 自 `.112` 起无代码改动,本版把 `PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.86`(codex 排队截止可配 #1988、启动恢复截止与离线上报 #1989)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.113
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.113 @sleep2agi/agent-node@2.5.0-preview.86
```

🔴 **两个包要一起升**(`.113 ↔ .86`)。

## 证据

- 配对测试红→绿;doc 门 rc=0。

## promote 时的 must_contain

`"version": "2.3.0-preview.113"`
