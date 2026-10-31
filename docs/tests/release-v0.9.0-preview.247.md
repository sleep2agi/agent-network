# commhub-server 0.9.0-preview.247

Since `.246`: **build identity now exists in production** — injected at package time instead of
looked up from a `.git` directory that a `npm install` tree never has.

| Commit | PR | What |
|---|---|---|
| 5ab69479 | — | 构建期注入 `build-info.json`；`/health` 的 `git_identity_root` 加第三支 `build_info` |

## Why

`detectBootGitIdentity()` reads `git rev-parse` at **runtime**. Production runs an `npm install`
tree — there is no `.git` — so `/health` reported `build_identified: false` (measured after
deploying `.246`). Consequence: **two releases with the same version label are indistinguishable**;
`.245` and `.246` were exactly that case.

## What changed

- **Package time** (`prepack` → `server/scripts/write-build-info.mjs`) writes `build-info.json`
  with `{schema, commit, dirty, built_at, source}`. It prefers `GITHUB_SHA` (CI), falls back to
  `git rev-parse`, and **writes nothing** when neither is available — an absent file is honest,
  a fabricated commit is not. The file ships in the tarball (`files` includes it).
- **Runtime** reads that file first and only then falls back to git. New readings in `/health`:
  - `git_identity_root` gains the value `"build_info"`
  - `build_identity_note` gains the reason `"build_info_invalid"` — a *corrupt* injection is a
    defect and must not read like `"not_a_git_checkout"` (the normal state of an npm tree)

## Honesty about the three states

`readBuildInfo` returns `present` / `absent` / `invalid`. `absent` is the normal state for
source checkouts; `invalid` is a real defect. Collapsing them would make "the injection is broken"
read as "nothing was injected", so they are reported separately.

A dirty tree can still be injected — but `dirty: true` means the identity may only be quoted as
`prod@自称`, never as `prod@<sha>`.

## Verification

- `build-info.test.ts` — 5 pass: three states + nine rejected malformed shapes + dirty visible.
- `health-redaction.test.ts` — 91 pass, including a new invariant:
  **`git_identity_root === "build_info"` ⇒ `build_identified` must be `true`.**
- `npm pack --dry-run` shows `build-info.json` (153 B) inside the tarball.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.247
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.247
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-247 pm2 restart <name> --update-env
```
