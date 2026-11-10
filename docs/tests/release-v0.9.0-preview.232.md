# CommHub v0.9.0-preview.232

This release carries the Hub changes merged since `0.9.0-preview.231`, built from main at `b7d97beab`.

## What changed

- **`/health` 的 `version_source` 把两类失败分开。**
  - 原来是 `unknown` 同时表示「读 package.json 失败」与「读到了但是空」——
    前者要去查文件权限/路径，后者要去修 package.json。
  - 现在：`read_failed` / `empty_value`（不新增字段，只是不再把两个成因压成一个值）。

- **节点 404 明说「这是有意合并的两种成因」。**
  - `GET/POST /api/nodes/:id/...` 的 `node_not_found` 同时表示「不存在」与「不在你的可见范围」，
    两者修法相反；合并是为了避免枚举网络里有哪些节点。
  - 载荷新增 `note` 说明这一点，前端不再臆断，同时「存在性」仍然不泄露。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.232`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.232
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.232
```

No schema change. Readers of `version_source` must accept the two new values (`read_failed`, `empty_value`);
they replace `unknown` (which is no longer emitted).

## Rolling back

`0.9.0-preview.231` starts on a database that `.232` has run on; nothing to undo. Its `version_source` collapses
both failure causes into `unknown`, and its node 404 carries no `note`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
