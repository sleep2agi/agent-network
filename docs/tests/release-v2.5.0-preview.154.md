# agent-node — OpenCode V2 background control, v2.5.0-preview.154

Ships `main` after `.153` (published 2026-10-22). The node runtime now carries
the bounded "move the original OpenCode session to the background" relay that
the desktop client and the Hub have been waiting for.

```
@sleep2agi/agent-node@2.5.0-preview.154
```

## What changed

- **#2016 — bounded OpenCode V2 background control** (`agent-node/src/runtime/session-control-bridge.ts`).
  A node can answer `state` and `background` for the *original* session it is
  already bound to (`node / network / session / binding_id`), with a short TTL and
  a one-shot claim. It does **not** expose arbitrary keys, paths, URLs, commands
  or prompts, and an `unknown` request is never replayed. A missing capability
  answers with an explicit refusal instead of a silent 204.
- **#2050 — requested V2 model restart is restored** when the hot capability is
  missing, instead of leaving the node on the old model.
- **#2903 — known OpenCode runtime failures are never replayed** through the
  vendor retry path: a failure the runtime already classified is surfaced once.
- **#2901 — owner-left evidence is reset on any non-404 observation**, so a stale
  "owner left" verdict cannot survive a successful observation.
- **#2912 — test-only**: the CLI wiring check moved into its own suite; no
  runtime behaviour change.

## Why this version matters

`.153` was published before #2016 merged, so a node on `.153` (or older) has no
`backgroundControl` at all: the Hub answers
`403 {"ok":false,"error":"session_control_unavailable"}` for
`POST /api/node-session-control`. That is correct behaviour for an old node —
this release is what turns the capability on for nodes that upgrade.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.154
```

Or let the CLI fetch the exact pair (`anet` reads `PAIRED_AGENT_NODE_VERSION`,
which this release bumps to `2.5.0-preview.154`):

```bash
npx -y @sleep2agi/agent-node@2.5.0-preview.154 --print-entrypoint
```

## Upgrade

Existing nodes upgrade by pointing at the new exact version — the daemon keeps
running the old process until it is restarted, so the order matters:

```bash
# 1) what the node runs now (the Hub shows it as node.version)
curl -s localhost:9200/api/status | head -c 200

# 2) upgrade the pinned runtime and restart the node process
npm i -g @sleep2agi/agent-node@2.5.0-preview.154
agent-node --version    # must print 2.5.0-preview.154

# 3) restart the node so the new runtime is picked up, then read the version back
#    (in the desktop app: the node's restart action; on a self-managed box: restart the daemon)
```

A node that has not been restarted still reports `.153` and still refuses
background control — that is expected, not a failure.

## Verification

- `agent-node` unit gates (package version consistency, runtime session-control
  bridge, retry classification) run in CI on the release commit; the tarball the
  gate publishes is the one built from that commit.
- Hub-side refusal for old nodes is unchanged and covered by
  `server/src/node-session-control-http.test.ts` (23 pass).
