# CommHub v0.9.0-preview.225

This release carries the Hub changes merged since `0.9.0-preview.224`, built from main at `84649f44e`.

## What changed

- **新增 `GET /api/nodes/:id/provider-selection`**（用户令牌；节点须在可见网络内）。
  - 客户端要「显示这个节点当前用的是哪个 provider / 模型」，此前 REST 没有读口，
    只能显示「上次操作的结果」——而「上次操作」与「现在生效」不是同一件事。
  - `state ∈ never_switched | pending | applied | failed`（四态，不是有/没有）；
    `selection` / `revision` / `observed_at` 原样带回；`failed` 必带 `error`；
    `never_switched` 带 `hint`（显示的是节点本地默认配置，不是 Hub 的读数）。

- 仅内部：部署脚本 `scripts/deploy-hub-runtime.sh`（7 个 stage 枚举，含「装到的版本不符」这一格）。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.225`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.225
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.225
```

No schema change. New route only; existing clients are unaffected.

## Rolling back

`0.9.0-preview.224` starts on a database that `.225` has run on; nothing to undo. Its tree lacks the `provider-selection` route (404), so a client must fall back to "unknown" rather than treating it as `never_switched`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
