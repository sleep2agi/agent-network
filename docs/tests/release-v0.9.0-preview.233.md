# CommHub v0.9.0-preview.233

This release carries the Hub changes merged since `0.9.0-preview.232`, built from main at `151ef0ab4`.

## What changed

- 仅测试与注释（运行时行为与 `.232` 相同）：
  - 新增断言：**枚举成员必须真的可产出**（`version_source` 4 值、provider-selection 4 值）——
    打不中的枚举值是装饰，会让读者以为那条分支存在且被测过。
  - `clip.ts` 注释更正：Node 编码孤立代理对是**替换成 U+FFFD**（静默、不可逆、非单射），
    不是「非法 UTF-8 导致管道失败」。代码行为不变。

Migration: none.

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.233`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.233
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.233
```

No schema change, no behaviour change.

## Rolling back

`0.9.0-preview.232` behaves identically; the difference is only which assertions exist in the tree.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
