# commhub-server 0.9.0-preview.307

Since `.306`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.307
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.307
```

## What changed

```text
#3923（#5675 PR-3 Phase-1 服务端）：子节点密钥热生效的 Hub 侧。daemon 在 dsk_ 回执后向绑定的子节点推无值门铃
  `node_secrets_reload`（只带键名、action、revision）；新增 `node_secret_reload`（REST 与 MCP action）供 App 读子节点权威
  activation；`/api/status` 与节点能力清单透传 `secrets_hot_capable`（只有 Hub 能确认的子节点才为 true）。
  不改变任何既有写入权限：reload 与 put/delete 走同一套人类权限校验；门铃与响应都不含密钥值。
只发 server；agent-node 走 .237、CLI 走 .273、App 走下一个客户端版本。
```

## Verified

```text
server/src/hot-secrets-hub.test.ts 全套（能力位、四态 activation、门铃只对绑定子节点且无值、REST/MCP reload、负控 secret-echo）；
scoped-secrets / node-secrets 相关用例随 PR #3923 在隔离库跑过；doc 版本戳检查通过。
```
