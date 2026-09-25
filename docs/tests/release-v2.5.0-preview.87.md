# agent-node 2.5.0-preview.87

`.86` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 182d2010 | #1991 | codex-app-server 的补偿轮询遇到 hub 对未绑定旧 token 的 `from_node_id_identity_mismatch` / `node_token_required` 拒绝时,一次性关闭出站对账并告警一次,收件箱补偿按正常间隔继续;此前这个永久拒绝连收件箱补偿一起停掉,并在每次退避时告警 |

hub 端「未绑定 token 不能读 durable 游标」的检查保持不变(安全设计)。这些节点要恢复出站对账,需要换成绑定节点的 token。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.87
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.114 @sleep2agi/agent-node@2.5.0-preview.87
```

🔴 **两个包要一起升**(`.114 ↔ .87`);hub `commhub-server@0.9.0-preview.57` 不变。

## 证据

- 新增 6 条(4 种变异各自变红);hub 侧新增 1 条钉住「未绑定 token 被拒且不会顺带绑定」。agent-node 全量 1954 pass / 0 fail;hub 1294 pass / 0 fail;typecheck 棘轮 81 = 基线。

## promote 时的 must_contain

`"version": "2.5.0-preview.87"`
