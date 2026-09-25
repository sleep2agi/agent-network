# `@sleep2agi/agent-network@2.3.0-preview.114`

配对版本号前移:`agent-network/` 自 `.113` 起无代码改动,本版把 `PAIRED_AGENT_NODE_VERSION` 指向 `agent-node@2.5.0-preview.87`(未绑定旧 token 下补偿轮询降级为仅收件箱,#1991)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.114
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.114 @sleep2agi/agent-node@2.5.0-preview.87
```

🔴 **两个包要一起升**(`.114 ↔ .87`)。

## 证据

- 配对测试红→绿;doc 门 rc=0。

## promote 时的 must_contain

`"version": "2.3.0-preview.114"`
