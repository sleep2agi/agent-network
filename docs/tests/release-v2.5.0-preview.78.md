# agent-node 2.5.0-preview.78

`.77` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 06c64229 | #1950 | opencode 共存节点:`close()` 删掉自己写的工作区 `ANET-COMMHUB.md`;重启时遇到**自己上一代**留下的同名文件覆盖而不是 `EEXIST` 拒启(#1946) |

(同期 #1948、#1949 只改 `docs-site/` 与 `docs/`,不进本包。)

## 本版修的是什么

opencode 共存运行时把 CommHub 指令文件 `ANET-COMMHUB.md` 用 `wx` 写进**项目 cwd**——它不在 launch root 下,原有的 launch-root 清理从不碰它。于是任何一次 stop / 崩溃 / exit-75 重启都把它留在原地,下一代起到共存这一步就死在 `EEXIST`,而且死在 `[opencode-copresence] ready` 之前。

2026-09-22 21:28 在 DEV 实测(hub `update_node_config {model}`,RFC-024):hub 3 s 标 `applied`;启动器认 exit 75 并重生;新一代撞 `EEXIST` 以非 75 码退出;启动器按设计停环;**节点死而 hub 显示 applied**;旧的 `opencode attach` TUI 还指着已被杀的 serve。这条路正是「客户端里直接改模型、不经大模型」的承重墙。

**改法(两侧,fail-closed 语义保留)**:
- 启动:仍用 `wx`;`EEXIST` 时只有当现存文件**首行写的是本节点 alias**(`You are Agent Network node <alias>.`,即自己上一代)才覆盖;别的节点的文件、人写的文件照旧拒绝。
- 关闭:`close()` 与启动失败路径都会删该文件,但**只删字节与本代所写完全相同**的那份;被改过就留下并 warn。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.78
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.102 @sleep2agi/agent-node@2.5.0-preview.78
```

🔴 **两个包要一起升。** 配对是精确的(`.102 ↔ .78`);`anet` 用 `PAIRED_AGENT_NODE_SPEC` 解析并拒绝不配对的 agent-node。

## 证据

- `runtime.test.ts` 新增三条:自己上一代的旧文件 → 覆盖为新内容、mode 0600;别的 alias / 人写的笔记 → `EEXIST`、字节不动;关闭时精确删除,已不在时幂等返回 true,被人改写后留下并返回 false。
- 双向变异见证:「永不覆盖」→ 第一条红(19/20);「一律覆盖」→ 第二条红(19/20);恢复 → 20/20。
- agent-node typecheck 棘轮 81 = 基线,改动文件 0 错;doc symbol/source pins 门 rc=0。

## 未覆盖(明写)

- 端到端「`update_node_config` 改模型 → 新一代 `ready`」在本版**发到 npm 之后**才能在真机复测(发前节点跑的还是 `.71`)。发后在 DEV 的 opencode 共存节点上补一次。
- CLI 路径 `anet node edit --model` + `anet node restart` 走同一个 `close()`,同一处修复,但本版没有单独端到端跑它。

## promote 时的 must_contain

`"version": "2.5.0-preview.78"`
