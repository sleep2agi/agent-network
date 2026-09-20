# agent-node 2.5.0-preview.70

`.69` 之后 `agent-node/` 两个提交(都来自 外部团队 2026-09-16 在其云主机起 grok 共存节点的实测):

| 提交 | PR | 内容 |
|---|---|---|
| main after #1882 | #1882 | grok 共存 resume 找不到 session 目录:仍 fail-closed,但报错说明恢复办法(删 config.json 的 `grokCliSession` 再起) |
| main after #1888 | #1888 | 启动拒绝「0 字节、本人、单链接、mode≠0444」的占位文件时,报错附上 mode 与 `chmod 0444 .grok .claude .cursor .mcp.json .envrc` 恢复命令(判据不放宽;根治见 #1887) |

## 这一版带给用户什么

grok 共存节点在两种最常撞的启动失败上不再只给一句「missing session」/「expected a real directory」,而是直接告诉你改哪个键、跑哪条命令。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.70
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.70
anet node stop <name> && anet node start <name>      # 或 anet daemon restart <daemon>
```

## 证据

- `grok-build-cli-home.test.ts` 45/45(+1,变异「去掉提示」见证红);agent-node typecheck 0 新增错误。

## promote 时的 must_contain

`"version": "2.5.0-preview.70"`
