# agent-node 2.5.0-preview.84

`.83` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 102ad172 | #1977 | Claude Code 会话节点也能远程读写规则文件(CLAUDE.md);节点上报 `rules_file_capable`,hub 可按别名定位会话 |

agent-node 侧只多一件:注册上报带 `rules_file_capable: true`(规则文件读写本来就支持),让新 hub 与客户端知道它能服务。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.84
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.111 @sleep2agi/agent-node@2.5.0-preview.84
```

🔴 **两个包要一起升。** 配对是精确的(`.111 ↔ .84`);hub 需 `commhub-server@0.9.0-preview.56` 才会记下这个能力。

## 证据

- agent-node rules-file + register-telemetry 20 pass;typecheck 棘轮 81 = 基线。

## promote 时的 must_contain

`"version": "2.5.0-preview.84"`
