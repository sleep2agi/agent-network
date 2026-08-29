# @sleep2agi/agent-network 2.3.0-preview.64 — release notes

- **#1438 `anet node stop` 的 owned-roots 判定**（PR #1455）：修掉 pid 复用导致的误判。

本版同时把两个 pin 推到本批次的新版本：

- `PINNED_SERVER_VERSION` → `0.9.0-preview.40`
- `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.49`

所以装了这一版的 `anet`，`anet hub start` 会拉起 server `.40`，配套 agent-node 是 `.49`。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.64 @sleep2agi/agent-node@2.5.0-preview.49
anet login
anet hub start
```

需要 Node.js ≥ 22.13。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.64
anet hub restart
cd ~/anodes && anet project restart
```

hub 与节点都要重启才会用上新的 pin。

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1455 | #1438 | `anet node stop` owned-roots 判定，抵御 pid 复用误判 |
| — | — | pin 同步：server `.40`、agent-node `.49` |

未包含：#1464（#1448 findings 4-6）在本版切版时尚未合入 main，走 fast-follow。
