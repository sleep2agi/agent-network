# CommHub v0.9.0-preview.222

This release carries the Hub changes merged since `0.9.0-preview.221`, built from main at `ebae392ca`.

## What changed

- **建标签的 code→status 映射，穷尽性改成运行时钉住。**
  - `TAG_CREATE_ERRORS` 数组是错误码的唯一来源，`TAG_CREATE_STATUS` 是 `Record<TagCreateError, number>`。
  - 测试断言两者键集合逐字相等、每个值都是 4xx —— 不依赖编辑器或 tsc（本仓 `server` 没有 tsc CI 门）。
  - 新增一个码但不加映射 ⇒ 测试红，而不是静默落到 400。

- **`/health` 的 (读者 × 探针) 2×2 补齐第四格。**
  - 之前只测了匿名 / 匿名+`X-Probe-Nonce` / 鉴权三格；**鉴权+探针**没测过，
    而它正是「探针回显会不会被鉴权分支吃掉」的唯一读数。
  - 现在四格都断言：探针格回显 `probe_nonce`、四格都有 `served_at`、不带头的一格不出现 `probe_nonce`、
    鉴权格键数严格大于匿名格。

仅测试变更，运行时行为与 `0.9.0-preview.221` 相同。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.222`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.222
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.222
```

No schema change, no behaviour change; this version exists so the new pins travel with a published artifact.

## Rolling back

`0.9.0-preview.221` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
