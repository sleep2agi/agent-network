# agent-node 2.5.0-preview.187

Since `.186`: OpenCode V2 nodes no longer get stuck "working" behind a busy serve; adopted hand-started nodes pass the fork reader.

## What changed

```text
opencode-copresence/v2-session.ts
  history read timeout 10 s → 60 s default (ANET_OPENCODE_HISTORY_TIMEOUT_MS, clamped 1 s–10 min);
  consecutive read failures back off 250 ms → 2 s; warning logged on the 1st and every 10th failure.
session-source-evidence.ts
  source config identity: alias ?? node_name (refused if both exist and differ) — hand-started nodes
  write only node_name, so adopted TMA客户端欧 failed fork with source_config_mismatch.
```

## Verified

- `v2-history-timeout.test.ts` 2 pass; with v2-session / late-reply / adopt-opencode-v2: 46 pass / 0 fail
- `tsc -p agent-node` = main (80 pre-existing); server `session-source-evidence` 37/2 (= main)

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.187
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.187
npm i -g @sleep2agi/agent-network@2.3.0-preview.221   # pairs .187 (published after this)
```

## What it does not do

- Does not add incremental history reads (next step); a long single read still waits up to the timeout.
