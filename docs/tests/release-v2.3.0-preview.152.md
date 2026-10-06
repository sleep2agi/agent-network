# agent-network 2.3.0-preview.152

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.152`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.119`（见 [`release-v2.5.0-preview.119.md`](./release-v2.5.0-preview.119.md)）。

自 `.151`（发版合并 `e03a8640`，#2446）以来，`agent-network/` 没有代码改动（`git log e03a8640..<发版提交> -- agent-network/` 只有本次发版提交）。本版只移动配对，让 `anet` 拉起的 agent-node 是 `.119`。

## 你会看到的变化

- 配对的 agent-node 升到 `.119`：
  - 模型临时满载（at capacity / overloaded / 429 / 带上下文的 5xx）自动重试，30 / 60 / 120 秒退避最多 3 次，期间节点保持 working；本轮已执行过工具就不重试；裸 500 / 503、`500ms` 不再当作 5xx（#2451，#656）。
  - daemon 建节点允许中文 / Unicode 节点名，目录保持 ASCII；需要 Hub `0.9.0-preview.110`（#2449，#652）。
  - 详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.152 @sleep2agi/agent-node@2.5.0-preview.119
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.152 @sleep2agi/agent-node@2.5.0-preview.119
```

两个包一起升级（`agent-network@2.3.0-preview.152 ↔ agent-node@2.5.0-preview.119`）。
- 🔴 升级前：如果 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录、也不在系统目录，先把它们所在目录的绝对路径写进 daemon 节点 `config.json` 的 `daemonExtraPath` 并重启 daemon，否则从 app 建这几种节点会被拒绝（自 `.150`）。
- 🔴 agent-node 仍会拒绝权限不是 `0600` 的 `secrets.env`（自 `.116`）。
- 收编（`anet daemon adopt`，自 `.151`）默认关闭：`adopt_roots` 为空即不允许收编；收编节点请先停止再启动，不要 restart。

## 证据

- agent-network 本身无代码改动；配对由 `agent-network/src/opencode-agent-node-pair.ts` 决定。agent-node 部分的证据见 agent-node `.119` 说明。
- 未在真实生产节点上验证。

## promote 时的 must_contain

`"version": "2.3.0-preview.152"`
