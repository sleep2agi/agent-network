# `@sleep2agi/agent-network@2.3.0-preview.93`

## 为什么发这一版:配对 agent-node .70 + `anet grok --help` 修正

`.92` 之后 `agent-network/bin|src` 合入:

| PR | 内容 |
|---|---|
| #1886 | `anet grok --help` 也打印 `model` 子命令(此前只打 attach 一行,按 --help 自查会误判「没有 model」) |

配对 agent-node 升到 `2.5.0-preview.70`(grok 共存两处报错带恢复办法,#1882/#1888)。

## 这一版带给用户什么

- `anet grok --help` 与裸 `anet grok` 一致。
- 新装的节点默认拉 agent-node .70。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.93
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.93
```

## 边界

- 其它行为与 `.92` 逐字相同。
