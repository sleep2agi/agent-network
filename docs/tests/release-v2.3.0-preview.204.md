# agent-network 2.3.0-preview.204

Since `.203`: **`anet --version` now prints a build identity line**, so two installs with the same
version label are distinguishable.

| Commit | PR | What |
|---|---|---|
| addf8f50 | — | prepack 写 `build-info.json`；`anet --version` 多一行 |
| fb39e18b | — | 钉住那一行一定存在（接线测试） |

## Behaviour

`anet --version` gains one line, always present, with four possible shapes:

```
  build d9960e2fff64                                   ← clean tree
  build d9960e2fff64 (dirty tree — quote as self-reported only)
  build unknown (this install has no build-info.json)   ← source checkout / old artifact
  build unknown (build-info.json is present but invalid: invalid_shape)
```

Why four: **"absent" and "corrupt" must not look the same.** A missing file is the normal state of a
source checkout; a malformed one is a defect. Collapsing them would make "the injection is broken"
read as "nothing was injected".

`build-info.json` is written at **package time** (`prepack`): it prefers `GITHUB_SHA`, falls back to
`git rev-parse`, and **writes nothing** when neither is available — an absent file is honest, a
fabricated commit is not.

## What this does not cover yet

`agent-node` (the runtime) still reports only its version label to the Hub; that half needs a Hub
schema + storage + projection change and is tracked separately.

## Verification

- `src/build-info.test.ts` — 5 pass: three states, strict validation, and the four line shapes.
- `src/cli-exit-codes.test.ts` — 44 pass, including "the build line is always present and matches one
  of the four shapes" (that one is a **wiring** test: the pure functions above cannot prove the
  version report actually calls them).

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.204
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.204 @sleep2agi/agent-node@2.5.0-preview.169
```
