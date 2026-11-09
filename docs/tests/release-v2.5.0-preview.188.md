# agent-node 2.5.0-preview.188

Since `.187`: the daemon says why a source-control (fork / directory) tick failed instead of a fixed "transport unavailable".

## What changed

```text
agent-node/src/cli.ts
  [source-control] transport unavailable; no automatic replay (<error code or message>)
  tokens (ntok_/utok_/stok_/ghp_) redacted, 200 chars max; logged once per distinct reason,
  or once a minute while the same reason repeats. Behaviour unchanged — logging only.
```

Why: fork attempts on vdev reach `unknown_rotation_required` and the daemon log only showed the
fixed sentence, so the cause could not be diagnosed.

## Verified

- `tsc -p agent-node` = main (80 pre-existing)

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.188
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.188
```

## What it does not do

- Does not change fork behaviour or retry anything; it only makes the failure visible.
