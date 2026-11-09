# agent-node 2.5.0-preview.185

Since `.184`: two OpenCode V2 / daemon robustness fixes.

## What changed

```text
#3405  opencode-copresence/v2-session.ts
       Late-reply watcher interrupts OUR turn when, at window close, it is still the live turn and its
       history has not changed for 30 min: POST /api/session/:id/interrupt (V1's /session/:id/abort is
       404 on OpenCode 2.x). Seen on 通信欧: one hung MCP tool call kept the shared session busy 11 h.
#3403  cli.ts + runtime/source-hub-url.ts
       host_supervisor with ANET_SOURCE_FORK_PREVIEW=1 and a plain-HTTP (non-loopback) Hub URL no
       longer exits after registering, and no longer advertises source_fork_transport it cannot serve.
       Warns once: use https:// (e.g. https://y.vansin.top).
```

## Verified

- `late-reply-stall-interrupt.test.ts` 6 pass; with late-reply-3071 / v2-session / v2-session-alive-3166: 45 pass / 0 fail
- `source-hub-url.test.ts` 3 pass; `tsc --noEmit -p agent-node` same 80 pre-existing errors as main

## Upgrade order

agent-network must be re-paired to `.185` after this is visible on npm (opencode-cli requires an exact pair):

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.185
npm i -g @sleep2agi/agent-network@2.3.0-preview.219   # once published
```

## What it does not do

- Never interrupts a turn that is not ours, still moving, or whose history cannot be read.
