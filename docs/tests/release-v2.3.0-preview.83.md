# `@sleep2agi/agent-network@2.3.0-preview.83`

## 为什么发这一版:配对 agent-node `.65`(同日成对规则)

`.82` 之后 `agent-network/bin|src` **没有**功能提交;本版只把配对版本推到 agent-node `.65`(#1809 的 agent-node 侧防御),让 `anet node create` 装到带修复的 agent-node,并让 published-pins 门与 main 一致。

| 用户看到的 | `.82` | `.83` |
|---|---|---|
| `anet node create` 配对装的 agent-node | `.64` | `.65` |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.83
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.83
```

## 边界

- anet 自身行为与 `.82` 逐字相同;不需要重启节点。
