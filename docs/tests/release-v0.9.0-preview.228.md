# CommHub v0.9.0-preview.228

This release carries the Hub changes merged since `0.9.0-preview.227`, built from main at `f087db6da`.

## What changed

- 仅测试与门（不影响运行时行为）：
  - `/health` 的匿名投影新增「单一出口」ratchet：`Response.json(shape(` 只能出现一次。
    一个「必须在所有字段写完之后执行」的变换，多出口 × 惰性 = 迟早漏。
  - 恒真键集检查（`Object.keys(X).every(k => Object.hasOwn(X, k))`）纳入 `report-vacuous-assertions` 的扫描；
    本仓当前 0 处。

运行时行为与 `0.9.0-preview.227` 相同。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.228`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.228
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.228
```

No schema change, no behaviour change; this version exists so the new pins travel with a published artifact.

## Rolling back

`0.9.0-preview.227` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
