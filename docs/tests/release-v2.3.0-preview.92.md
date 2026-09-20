# `@sleep2agi/agent-network@2.3.0-preview.92`

## 为什么发这一版:跨 WAN 起节点被健康探测误杀(#1882)

`.91` 之后 `agent-network/bin|src` 合入:

| PR | 内容 |
|---|---|
| #1882 | `anet node start` 的 hub 健康探测:loopback 仍 2s,**非 loopback 默认 10s**,可用 `ANET_HUB_HEALTH_TIMEOUT_MS`(1000–60000)覆盖;fatal 文案带实际预算与覆盖方法。外部团队的云主机到 `y.vansin.top:9300` 响应 2.1–2.7s,2s 预算把好的 hub 判成没起(2026-09-16 外部团队节点 实测) |

## 这一版带给用户什么

- 在跨 WAN 连 hub 的机器上起节点不再因 2 秒预算被判「hub 没起」;慢链路可以 `ANET_HUB_HEALTH_TIMEOUT_MS=15000 anet node start <name>`。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.92
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.92
```

## 边界

- 配对 agent-node 仍为 `2.5.0-preview.69`(#1882 里 agent-node 的报错文案改动随下一版 agent-node 发)。
- 其它行为与 `.91` 逐字相同。
