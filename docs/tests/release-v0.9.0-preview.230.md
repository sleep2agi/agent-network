# CommHub v0.9.0-preview.230

This release carries the Hub changes merged since `0.9.0-preview.229`, built from main at `0bc59e60c`.

## What changed

- **`uptime` 与 `served_at`/`startedAt` 的「不同源」被测试钉住（运行时行为不变）。**
  - `uptime` 来自 `process.uptime()`（单调时钟）；`served_at`/`startedAt` 来自墙钟。
  - 因此「served_at 不动而 uptime 在走」是一个**单次读数、零依赖、有方向**的判别器：冻结的是墙钟，不是进程。
  - 新增测试两条：源码里 `uptime` 必须就是 `process.uptime()`（禁止 `Date.now() - …` 的同源写法）；
    读数自洽（now − startedAt ≈ uptime，±5s）。判据也写进了 `uptime` 字段的 `why`。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.230`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.230
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.230
```

No schema change, no behaviour change.

## Rolling back

`0.9.0-preview.229` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
