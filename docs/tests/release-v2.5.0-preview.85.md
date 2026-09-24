# agent-node 2.5.0-preview.85

`.84` 之后 `agent-node/` 一个提交(`.84` 已被 npm 接受但 3 小时仍未在 registry 可见,见 #1955;本版是其超集):

| 提交 | PR | 内容 |
|---|---|---|
| ecf2564c | #1984 | 节点「技能」只读查看:hub `list_node_skills` / `read_node_skill`(复用规则文件门铃与请求表,op `skills_list` / `skill_read`),agent-node 与 Claude Code 通道按各运行时真实加载位置列出技能,上报 `skills_capable` |

各运行时技能位置(按运行时自身二进制/文档核过):codex 0.155.1 = 项目 `.agents/skills` + `$CODEX_HOME/skills`(`.system` 标「内置」);grok 1.0.5 = 项目 `.grok/skills`、`.agents/skills`、`.claude/skills` + 用户同名;opencode = `.opencode/skill(s)` + `~/.config/opencode/skill(s)`、`~/.claude/skills`、`~/.agents/skills`。返回 name / scope / 相对路径 / ≤300 字描述;读 SKILL.md 上限 256 KiB,指向技能目录外的符号链接拒绝。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.85
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.112 @sleep2agi/agent-node@2.5.0-preview.85
```

🔴 **两个包要一起升**(`.112 ↔ .85`);hub 需 `commhub-server@0.9.0-preview.57`。

## 证据

- agent-node 新增 14 条(两处变异 2/1 红);全量 1936 pass / 0 fail;typecheck 棘轮 81 = 基线。

## promote 时的 must_contain

`"version": "2.5.0-preview.85"`
