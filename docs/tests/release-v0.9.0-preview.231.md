# CommHub v0.9.0-preview.231

This release carries the Hub changes merged since `0.9.0-preview.230`, built from main at `ee4f9668f`.

## What changed

仅测试与门，运行时行为与 `0.9.0-preview.230` 相同：

- **`0` 必须是读数，不能冒充「还没测」。** `event_loop` 的窗口（`since` / `observed_at`）必须同时存在；
  当 `stall_count == 0` 时窗口长度必须 > 0 —— 否则那个 0 表示「还没观察」，不是「没有停顿」。
- **两张状态映射必须「定义一处、被读至少一次」**：`PROVIDER_WRITE_STATUS` / `TAG_CREATE_STATUS`
  在生产源码里只能有一处 `export const`，且必须被真正读到（防止复制与装饰表）。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.231`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.231
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.231
```

No schema change, no behaviour change.

## Rolling back

`0.9.0-preview.230` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
