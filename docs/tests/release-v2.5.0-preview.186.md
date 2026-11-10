# agent-node 2.5.0-preview.186

Since `.185`: a daemon can adopt hand-started **OpenCode V2 co-presence** nodes (registration), so they become forkable.

## What changed

```text
#3411  adopt-local-identity / adopt-daemon / adopt-opencode-v2
       OpenCode V2 co-presence (opencode-cli + v2) no longer refused with copresence_adopt_v2 by an
       up-to-date daemon. The daemon verifies the live bridge (.pid → /proc: uid, cwd, exact --config)
       and records an opencode_v2 registry entry. Nothing is signaled, spawned or rewritten.
       session-source-evidence resolves that entry for fork; start/stop of such an entry is refused
       (adopt_opencode_lifecycle_unsupported) until phase 2.
```

## Verified

- `adopt-opencode-v2.test.ts` 5 pass; `adopt-*.test.ts` 51 pass / 0 fail
- `tsc --noEmit -p agent-node` same 80 pre-existing errors as main
- server `session-source-evidence` 37/2 (= main), `node-lifecycle-read-http` 14/14

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.186
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.186
npm i -g @sleep2agi/agent-network@2.3.0-preview.220   # pairs .186 (published after this)
# restart the host_supervisor daemon; co-presence nodes themselves need no restart
```

## What it does not do

- Does not let the daemon start/stop/restart an adopted OpenCode co-presence node (phase 2).
