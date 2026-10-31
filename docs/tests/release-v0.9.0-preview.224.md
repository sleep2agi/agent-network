# CommHub v0.9.0-preview.224

This release carries the Hub changes merged since `0.9.0-preview.223`, built from main at `c09701e10`.

## What changed

- **`/health` 增加 `version_source`（结束「有覆盖、零仲裁」）。**
  - `version` 有两个来源：standalone 二进制注入的 `ANET_EMBEDDED_COMMHUB_VERSION`，或磁盘 `package.json`。
  - 以前只报结果、不报谁赢了；现在 `version_source ∈ embedded_env | package_json | unknown`，
    读法与 `version` 自洽（`unknown` ⇔ `version === "?"`）。
  - `resolveServerVersion()` 抽成纯函数，四例单测覆盖（env 合法 / env 形状不对 / 磁盘失败 / 空 env）。

- **`/health` 的 `granularity=instant` 字段必须写出反事实。**
  - 这一档（`startedAt` / `served_at`）的值在变，但变的可能只是「读的时刻」。
  - 现在这类的 `why` 必填（>8 字符）；`served_at` 补上：「变了不代表状态变化，只代表又问了一次」。

新的匿名字段只有 `version_source`（gauge / label，不暴露路径或提交）。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.224`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.224
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.224
```

No schema change. Anonymous `/health` gains one field (`version_source`); clients that pin the exact anonymous key set must accept it.

## Rolling back

`0.9.0-preview.223` starts on a database that `.224` has run on; nothing to undo. Its `/health` omits `version_source`, so a reader cannot tell whether the version came from the binary env or the package.json on disk.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
