# CommHub v0.9.0-preview.226

This release carries the Hub changes merged since `0.9.0-preview.225`, built from main at `3748cd310`.

## What changed

- **新增 `POST /api/nodes/:id/provider-selection`**（切换动作的第一步；用户令牌 + 网络 owner/admin）。
  - 复用 `requestProviderApplication`（授权、校验、加密下发都在那一边），REST 只补两件事：
    - 返回 `before`（上一次生效的 selection）——没有它，「切成功了吗」只能靠客户端记得上一次；
    - 明确下一步：`hint` 写明「已排队；用 GET 回读 `state=applied` 才算生效（`pending` 不等于生效）」。
  - 响应 `202 {request_id, state:"pending", before, expires_at, hint}`。
  - 错误分档：401 `user_token_required`｜403 `provider_admin_required`｜404 `daemon_not_found`｜
    400 `invalid_revision`/`invalid_application`/`application_target_not_bound`｜409 其它。

前置条件（测试逐一钉住）：目标节点必须是 `host_supervisor` 守护进程；`node_revision` 必须是 64 位 hex；
切的是**被守护进程监督的节点**（不是守护进程自己），需要一条 active 绑定。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.226`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.226
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.226
```

No schema change. New route only.

## Rolling back

`0.9.0-preview.225` starts on a database that `.226` has run on; nothing to undo. Its tree lacks the POST route (404),
so a client must fall back to the MCP path rather than treating 404 as `daemon_not_found`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
