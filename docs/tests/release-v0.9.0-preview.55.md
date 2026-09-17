# `@sleep2agi/commhub-server@0.9.0-preview.55`

## 为什么发这一版:**`POST /api/messages/ack` 支持按 agent 整体标已读**(#1909)

`.54` 之后 `server/src` 一个功能提交:

| PR | 内容 |
|---|---|
| #1909 | `/api/messages/ack` 新增 `{ "agent": "<alias>" }` 形态:把调用者收到的、来自该 agent 的 `user_inbox` 行 + `inbox` 里发给其用户名的 `reply/task/message` 行**全部** ack(只动自己的行;用户名与节点 alias 撞名时 `inbox` 半边跳过,与 id 形态同规则)。响应加 `scope: "agent" \| "ids"` 供客户端探测;`agent` 与 id 同时给 → 400 `ambiguous_ack` |

| 用户看到的 | `.54` | `.55` |
|---|---|---|
| 桌面端点开某 agent 的聊天 | 角标分母 `unread_by_agent` 数全集,客户端一页只能 ack 最近 200/300 行 ⇒ 老行永远未读,红点常驻 `99+`(生产 admin:user_inbox 522 + inbox 5660 行) | 客户端(0.2.73+)用 `{agent}` 一次清空该 agent 的未读,红点归零 |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.55
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.55
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

## 证据

- `messages-ack-by-agent-http.test.ts` 5/5:两张表都 ack、不动别的 agent / 非计数类型 / 别的用户、幂等、id 形态不变且带 `scope:"ids"`、`ambiguous_ack` 无副作用。

## promote 时的 must_contain

`"version": "0.9.0-preview.55"`
