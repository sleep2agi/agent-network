# `@sleep2agi/agent-network@2.3.0-preview.80`

## 为什么发这一版:**`anet hub start` 拉 commhub-server `.47`**(#1548 名册 blocked 有出口)

`.79` 之后 `agent-network/bin|src` 只有 `PINNED_SERVER_VERSION .46 → .47`(#1795);`.47` 本身只带 #1793。

| 用户看到的 | `.79` | `.80` |
|---|---|---|
| `anet hub start` 起的自托管 hub 版本 | `.46` | `.47`:活着的节点回终态消息 / 派任务后不再永远 `blocked` |
| 其它 | — | 无变化 |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.80
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.80
anet hub restart        # 自托管 hub 换到 .47;生产 hub 另走 deploy/hub/README.md 六步
```

## promote 时的 must_contain

`commhub-server@0.9.0-preview.47`(`.79` 产物 0 命中,已用闸 4 原样命令验)。
