# agent-network 2.3.0-preview.206

Since `.205`: pair constant only (→ agent-node `2.5.0-preview.171`) plus a corrected build
identifier.

## Why

`.205` was built from `9bb1a399` but labelled `commit=644c95cd`: the writer preferred
`GITHUB_SHA`, and with `ref: inputs.commit || github.sha` those can differ. `df229935` prefers the
checked-out tree and keeps the event sha separately.

## What this release does not claim

`.205`'s label is not quotable. If you cite a build commit for a CLI release, cite `.206` or later.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.206
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.206 @sleep2agi/agent-node@2.5.0-preview.171
```
