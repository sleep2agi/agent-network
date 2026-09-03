# `@sleep2agi/agent-network@2.3.0-preview.79`

## 为什么发这一版:**配对钉跟上 agent-node `.63`**(published-artifact-drift 的 `published-pins` 要求)

`.78` 之后 `agent-network/bin|src` 没有功能改动;只有 `PAIRED_AGENT_NODE_VERSION` 从 `.62` 走到 `.63`(agent-node 今天发了 `.63`,#1645 两道门)。`scripts/verify-published-pins.sh preview` 每天拿 main 的配对钉比已发布的 preview 包,agent-node 发了而 anet 没跟着发就会红 —— 这一版就是让它对上。

| 用户看到的 | `.78` | `.79` |
|---|---|---|
| `anet` 与 `agent-node` 的配对钉 | `.62` | `.63` |
| 其它 | — | 无变化 |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.79
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.79 @sleep2agi/agent-node@2.5.0-preview.63
anet daemon restart <daemon>
```

## promote 时的 must_contain

`2.5.0-preview.63`(`.78` 产物 0 命中——它钉的是 .62)。
