# `@sleep2agi/agent-network@2.3.0-preview.85`

## 为什么发这一版:配对 agent-node `.66`(同日成对规则)

`.84` 之后 `agent-network/bin|src` **没有**功能提交;本版只把配对版本推到 agent-node `.66`(#1422 的 stop 时占位文件提前回收),让 `anet node create` 装到带修复的 agent-node,并让 published-pins 门与 main 一致。

| 用户看到的 | `.84` | `.85` |
|---|---|---|
| `anet node create` 配对装的 agent-node | `.65` | `.66` |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.85
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.85
```

## 边界

- anet 自身行为与 `.84` 逐字相同;不需要重启节点。
