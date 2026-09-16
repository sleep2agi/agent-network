# `@sleep2agi/agent-network@2.3.0-preview.94`

## 为什么发这一版:node-server 收件箱取空(#1901)+ 配对 agent-node .71

`.93` 之后 `agent-network/bin|src` 合入:

| PR | 内容 |
|---|---|
| #1901 | claude-code-cli 节点每个 new_task 事件把收件箱取到空(之前只取一页 5 条,攒下的第 6 条起要等下一个事件才投,表现为一批旧消息迟到);hub 一直回同一批时按 no-progress 停,最多 20 页(#1900) |

配对 agent-node 升到 `2.5.0-preview.71`(出队前跳过已终态任务)。

## 这一版带给用户什么

- 忙碌的 claude-code 节点不再把第 6 条起的消息拖到下一个事件才收。
- 新装节点默认拉 agent-node .71。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.94
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.94
anet node stop <name> && anet node start <name>      # claude-code-cli 节点要重启才加载新的通道代码
```

## 边界

- 其它行为与 `.93` 逐字相同。
