# CommHub v0.9.0-preview.229

This release carries the Hub changes merged since `0.9.0-preview.228`, built from main at `46368988f`.

## What changed

- **截断改成 `clipSafe`：不再切断 UTF-16 代理对。**
  - `s.slice(0, n)` 数的是 code unit；若切点落在 emoji 的高/低代理之间，会产出**孤立 surrogate**：
    `JSON.stringify` 仍合法（写成 `"\ud83d"`），但编码成 UTF-8 时就可能被替换或报错——
    也就是说**那一行审计/日志本身可能不是合法 UTF-8**，日志管道会在那一行出问题。
  - 新 `server/src/clip.ts` 只在边界处理：切点在代理对中间就少取一个 code unit，长度上限语义不变。
  - 接入两处由用户输入驱动的截断：`task-rejection-log.clip`、`requirements.clipTitle`。

- 仅测试与门（不影响运行时）：元门补阳性对照（门数下限 30 / 实际执行自检数下限 8），
  否则「欠账变少」与「扫描器坏了」同形。

Migration: none.

Behaviour to be aware of: 极长且含 emoji 的描述/标题，截断点可能比之前少 1 个字符（为了不切开 emoji）。

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.229`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.229
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.229
```

No schema change.

## Rolling back

`0.9.0-preview.228` starts on a database that `.229` has run on; nothing to undo. Its truncation can produce
lone surrogates at emoji boundaries.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
