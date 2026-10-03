# agent-network 2.3.0-preview.127

Built from main `84069df9`. `2.3.0-preview.125` (#2301) and `2.3.0-preview.126` (#2306 / #2310) were published by CI but were not yet visible on the registry when this was cut (registry `preview` still `2.3.0-preview.124`), so `.127` also carries everything listed for `.125` and `.126`.

## Behaviour

- New: `anet node clone <source> <new-name>` (#509 / #2307), and `anet node create <new-name> --from <source>` now does the same thing (`--from` used to be ignored). The clone is registered with the Hub as its own node (new `node_id` + token) before anything is written to disk. Copied: runtime, model, tools, permission flags, prompts, non-secret env, codex `config.toml` / `AGENTS.md` / `skills/`; with `--workdir` also the rules file, skills folders and `.mcp.json` (env/header values blanked). Not copied: token, sessions/threads, logs, inbox, channel bot credentials, codex `auth.json`, secret env values (key names kept; the summary lists what to set). Prints a copied / regenerated / skipped table; starts only with `--start`. Refuses an existing destination, the source's own name, a target inside the source's node directory, a non-ASCII `--workdir`, `opencode-cli` nodes and host daemons. Docs say why never to `cp -r` a node directory (same `node_id` + token ⇒ every task runs twice).
- Carried from `.126`: `anet upgrade` stays on your current npm channel, decided by comparing the installed version with the live dist-tags (#510 / #2302); `anet hub start` launches the channel's current commhub-server instead of the `0.9.0-preview.47` pin and prints version + source (#511 / #2305).
- Carried from `.125`: one tmux helper with explicit `-S` socket isolation that refuses `kill-server` (#505 / #2297); no permission override on `codex resume --remote` (#505 / #2298).
- Pairing pins: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.127`; `PAIRED_AGENT_NODE_VERSION` stays `2.5.0-preview.97`.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.127 @sleep2agi/agent-node@2.5.0-preview.97
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.127 @sleep2agi/agent-node@2.5.0-preview.97
```

Upgrade both packages together: anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2307: test745 agent-network unit 1457/0 at the PR head; new Docker suite test509 (throwaway hub: create alpha, clone to beta, two distinct node rows, none of alpha's token/secret under beta; `create gamma --from alpha`; six refusals leave the node count unchanged) 17 checks; copying the token turns the unit suite red.
- #2302 / #2305: see `release-v2.3.0-preview.126.md`. #2297 / #2298: see `release-v2.3.0-preview.125.md`.

## promote 时的 must_contain

`"version": "2.3.0-preview.127"`
