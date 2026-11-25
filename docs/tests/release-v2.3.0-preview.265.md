# @sleep2agi/agent-network (CLI) 2.3.0-preview.265

与 `@sleep2agi/agent-node` **2.5.0-preview.231** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

- **修复 `anet node ls` 的 `SSE` 列全员误显 `○`（`#3874`）**：`lsCommand` 与 `sseAllConnected` 改按 `${networkId}:${alias}` 匹配 Hub `/api/stats/sse` 键并保持跨网隔离。
- **修复 OpenCode V2 建节点误报 V1 安装警告（`#3875`）**：创建 V2 节点时指向 `@opencode/cli@2.0.22`，不再推荐 V1 `opencode-ai@1.18.34`。
- **修复 `anet node create --network <id|name>` 静默失效并补全 `--help`（`#3876`）**：按 ID / 唯一前缀 / 精确名 fail-closed 解析目标网络并校验可写角色，且不覆盖默认网络。
- **配对更新**：指向 `agent-node@2.5.0-preview.231`（含 `#3873` Antigravity 实时 `agySessionId` 上报）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.265 @sleep2agi/agent-node@2.5.0-preview.231
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.231
anet upgrade
```
