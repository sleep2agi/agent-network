# `@sleep2agi/agent-network@2.3.0-preview.111`

`.110` 之后 `agent-network/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 102ad172 | #1977 | Claude Code 会话节点也能远程读写规则文件(CLAUDE.md);节点上报 `rules_file_capable`,hub 可按别名定位会话 |

- Claude Code 会话的通道进程(`node-server`)新增 `rules_file` 门铃处理:读写会话项目目录的 `CLAUDE.md`,路径安全规则与 agent-node 相同(逐字节同一份,parity 测试钉住);注册、心跳、重注册都上报 `rules_file_capable`。
- 🔴 已在跑的 Claude Code 会话要**重启到本版**才会上报能力;在那之前客户端继续隐藏规则文件区块(与旧行为相同)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.111
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.111 @sleep2agi/agent-node@2.5.0-preview.84
```

🔴 **两个包要一起升**(`.111 ↔ .84`);hub 需 `commhub-server@0.9.0-preview.56`。

## 证据

- node-server rules helper + parity 8 pass;agent-network 1297 pass / 0 fail;`tsc` 0 错;doc 门 rc=0。
- 已知:`readRulesFile` 跟随符号链接,与 agent-node 那份逐字节一致;两边一起收紧另开变更。

## promote 时的 must_contain

`"version": "2.3.0-preview.111"`
