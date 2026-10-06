# agent-network 2.3.0-preview.151

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.151`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.118`（见 [`release-v2.5.0-preview.118.md`](./release-v2.5.0-preview.118.md)）。

自 `.150`（发版合并 `822ebb57`，#2441）以来，`agent-network/` 有 2 个改动（`git log 822ebb57..<发版提交> -- agent-network/`）：

| 提交 | PR | 内容 |
|---|---|---|
| df7a06b7 | #2436 | #626：新命令 `anet daemon adopt` / `unadopt` / `adopted` |
| f87b66ef | #2437 | #627：`anet node clone` / `anet node codex fork --workdir` 写 `.anet/child-workdirs.json` 时保留 daemon 的收编条目，不用克隆索引覆盖绑定 |

## 你会看到的变化

- **`anet daemon adopt` / `unadopt` / `adopted`（#2436，#626）。** 需要 `anet login` 的人类账号。
  - `anet daemon adopt <alias> --daemon <id-or-alias>`：在手工节点的工作目录运行，不带 `--yes` 只展示计划，带 `--yes` 请求收编；`--all` 只枚举当前目录的 `.anet/nodes`，不扫机器上其它目录。请求成功只代表 pending，要等 daemon 独立核验、Hub 绑定成为 active 才生效。不停、不重启节点。
  - `anet daemon unadopt <alias> --yes`：撤销绑定，运行中的节点不会被停止，工作目录不删除。
  - `anet daemon adopted`：在 daemon 工作目录运行，列出本机有登记且 Hub 绑定有效的节点，只读。
  - daemon 节点 `config.json` 的 `adopt_roots` 默认为空，即不允许收编。
- **收编条目不会被覆盖（#2437，#627）。** `anet node clone` / `anet node codex fork` 带 `--workdir` 时会往源目录的 `.anet/child-workdirs.json` 记一条索引；现在保留文件里 daemon 的收编条目（对象形式），同名别名已被收编时不写，不再用字符串索引覆盖绑定。
- 配对的 agent-node 升到 `.118`：收编节点可以经 daemon 停止 / 启动，restart 被 Hub `0.9.0-preview.109` 拒绝（`adopted_restart_requires_daemon`，先停止再启动）；OpenCode 共存回复超时只在我们的提交是未答队头时才中止会话（有未解决的 N5 情况）。详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.151 @sleep2agi/agent-node@2.5.0-preview.118
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.151 @sleep2agi/agent-node@2.5.0-preview.118
```

两个包一起升级（`agent-network@2.3.0-preview.151 ↔ agent-node@2.5.0-preview.118`）。
- 🔴 升级前：如果 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录、也不在系统目录，先把它们所在目录的绝对路径写进 daemon 节点 `config.json` 的 `daemonExtraPath` 并重启 daemon，否则从 app 建这几种节点会被拒绝（自 `.150`）。
- 🔴 agent-node 仍会拒绝权限不是 `0600` 的 `secrets.env`（自 `.116`）。

## 证据

- #2436：`tests/test626-daemon-adoption/`，`agent-network/src/daemon-adopt.test.ts`；#2437：`agent-network/src/node-locate.test.ts`，`tests/test627-adopted-lifecycle/`。agent-node 部分的证据见 agent-node `.118` 说明。
- 未在真实生产节点上验证。

## promote 时的 must_contain

`"version": "2.3.0-preview.151"`
