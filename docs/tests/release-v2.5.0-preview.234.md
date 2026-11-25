# agent-node 2.5.0-preview.234

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.270** 精确配对。配套 Hub `0.9.0-preview.301`。

## Why

- **Antigravity 节点换模型不再重启（`#3889`）**：`agy` 每轮都会起 `agy acp` 并在发提示前 `session/set_model`，所以只改模型时节点就地更新：不掉线（以前 12–60 秒）、`agySessionId` 保留；写回 `config.json`（原子写、留 `.prev`）后立刻上报状态，App 里马上显示新模型。同时改设置（flags）或频道的仍会重启。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.234 @sleep2agi/agent-network@2.3.0-preview.270
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.234
anet upgrade
```
