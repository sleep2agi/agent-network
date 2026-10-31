# commhub-server 0.9.0-preview.253

Since `.252`: no server source change. This release exists so that `.252`'s build identifier
(`commit=644c95cd` in the tarball) is superseded by one that is actually true.

## Why a release with no code change

`.252` was published from commit `9bb1a399` but its `build-info.json` recorded `644c95cd` — the
*event* sha, not the checked-out tree. The writer preferred `GITHUB_SHA`, while the release
workflow checks out `ref: inputs.commit || github.sha`; when those differ, the artifact's label
describes something other than its bytes. Fixed in `df229935` (git first, `event_sha` recorded
separately). npm versions are immutable, so the honest label has to come from a new version.

## What you can rely on in this build

`build-info.json` now reports `commit` = the tree that was packed. If the event sha differed,
`event_sha` is present alongside it — the artifact describes the former, and says so.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.253
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.253
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-253 pm2 restart <name> --update-env
```
