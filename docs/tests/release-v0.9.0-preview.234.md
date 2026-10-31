# CommHub v0.9.0-preview.234

This release carries the Hub changes merged since `0.9.0-preview.233`, built from main at `df24c7978`.

## What changed

仅测试（运行时行为与 `.233` 相同）：

- **匿名 `/health` 的响应头不得带指纹**：头名里出现 `git` / `commit` / `build(sha|id)` 即红。
  body 有白名单断言，头此前没有——而两者对匿名读者同样可见。
- **「被读过」不能由注释满足**：状态映射的读点必须是**非注释代码**，且落在实现/路由文件里；
  单纯一句注释提到常量名，会满足「读到过」而实际没有任何代码用它。
- **枚举成员必须真的可产出**（`version_source` 4 值、provider-selection 4 值）。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.234`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.234
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.234
```

No schema change, no behaviour change.

## Rolling back

`0.9.0-preview.233` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
