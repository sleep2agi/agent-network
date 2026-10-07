# agent-node 2.5.0-preview.123

自 `.122`（发版合并 `5e3c63ec`，#2485）以来，`agent-node/` 有 1 个改动（`git log 5e3c63ec..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 55ec9e15 | #2481 | 节点启动时把 `~/.anet/skills` 里的团队技能链进各运行时的用户级技能目录 |

（同期合入、不在本包里的：#2486 的 Hub 端 `keep_cli_tokens` 随 commhub-server；anet 端的 `anet passwd` 随 agent-network `2.3.0-preview.155`。）

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。**
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- claude 运行时的团队技能链到 `~/.claude/skills`，对这台机器上所有 claude 会话生效（日志会写明）。

## 你会看到的变化

### 团队技能进入运行时的用户级目录（#2481）

- 节点启动时把 `~/.anet/skills` 下的团队技能链接（或带 `.anet-team-copy` 标记复制）到运行时的用户级技能目录；技能带 `origin=team`，不新增 scope。
- 已有的同名目录不覆盖；只清理目标落在团队目录里的链接、或 source 解析后落在团队目录里的复制件。
- `~/.anet` 是软链接时按真实路径判断；同机多个节点同时启动时容忍 EEXIST / ENOENT，不再中断其余技能的安装。

该改动不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.123
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.155 @sleep2agi/agent-node@2.5.0-preview.123
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.155 ↔ agent-node@2.5.0-preview.123`）。
- 发布顺序：先 agent-node `.123`，再 agent-network `.155`，两者来自同一个合并提交。

## 证据

- #2481：`tests/test9763-team-skills-e2e/`（Docker）、`agent-node/src/runtime/node-skills.test.ts`（含 `~/.anet` 软链接、复制标记、3 并行 × 8 轮并发用例）。
- 未在真实生产节点 / daemon 上验证。
