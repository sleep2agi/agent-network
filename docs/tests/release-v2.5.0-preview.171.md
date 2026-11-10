# agent-node 2.5.0-preview.171

Since `.170`: no runtime behaviour change. `build-info.json` now records the commit of the tree
that was packed, not the sha of the event that started the release.

## Why it matters here

A node's `build_commit` is only useful if it describes the bytes. `.170` was correct
(`commit=9bb1a399`, matching the dispatched commit); the CLI published alongside it was not.
`df229935` prefers `git rev-parse HEAD` and records `event_sha` separately when the two diverge.

## Verification

`src/build-info.test.ts` — 8 pass: four read-side (three states + strict validation) and four
write-side, including "GITHUB_SHA ≠ HEAD ⇒ commit = HEAD, event_sha = GITHUB_SHA".

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.171
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.206 @sleep2agi/agent-node@2.5.0-preview.171
```
