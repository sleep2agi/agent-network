# CommHub v0.9.0-preview.223

This release carries the Hub changes merged since `0.9.0-preview.222`, built from main at `73df43491`.

## What changed

- **`PUT /api/providers` 的错误 → 状态码改成穷尽表。**
  - 原来是三元式：未映射的码默认落 400（例如 vault 不可用本该 503）。
  - 现在 `PROVIDER_WRITE_STATUS: Record<ProviderWriteErrorCode, number>`（13 个码），路由只调 `providerWriteStatus()`。
  - 测试两条：映射键 == 码清单；**码清单里每个码都能在 `hub-provider-config.ts` 里找到产出点**（跨源，防止清单独自漂移）。

- **`/health` 的字段必须被测试读过（未被读 = 未被验证）。**
  - 新增 ratchet：`HEALTH_FIELD_META` 的每个键都必须至少被一条 server 测试提到；例外要登记并写理由（当前无例外）。
  - 它当场抓出两个字段并补了断言：`alert_baselines`（null 或 `{at, rows, aliases}`）、
    `clk_tck_assumed_reason`（与 `clk_tck_source` 配对：`assumed` ⇒ 非空理由，否则必须空串）。

运行时行为变化只有一条：`PUT /api/providers` 在 vault 不可用时返回 503、`hub_provider_disabled` 返回 409，
而不是一律 400。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.223`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.223
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.223
```

No schema change. If any client branches on `PUT /api/providers` returning 400 for every failure, check the new 503/409 cases.

## Rolling back

`0.9.0-preview.222` starts on a database that `.223` has run on; nothing to undo. Its provider write path reports 400 for the codes that `.223` maps to 503/409.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
