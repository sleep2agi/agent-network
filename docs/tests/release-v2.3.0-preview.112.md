# `@sleep2agi/agent-network@2.3.0-preview.112`

`.111` 之后 `agent-network/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| ecf2564c | #1984 | 节点「技能」只读查看:hub `list_node_skills` / `read_node_skill`(复用规则文件门铃与请求表,op `skills_list` / `skill_read`),agent-node 与 Claude Code 通道按各运行时真实加载位置列出技能,上报 `skills_capable` |

- Claude Code 会话通道(`node-server`)处理 `skills_list` / `skill_read`:项目 `.claude/skills` + 用户 `~/.claude/skills`;与 agent-node 共享的实现逐字节一致(parity 测试钉住);上报 `skills_capable`。
- 已在跑的 Claude Code 会话要**重启到本版**才会上报能力。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.112
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.112 @sleep2agi/agent-node@2.5.0-preview.85
```

🔴 **两个包要一起升**(`.112 ↔ .85`);hub 需 `commhub-server@0.9.0-preview.57`。

## 证据

- 技能往返与共享代码 parity 测试红→绿;agent-network `tsc` 0 错;doc 门 rc=0。

## promote 时的 must_contain

`"version": "2.3.0-preview.112"`
