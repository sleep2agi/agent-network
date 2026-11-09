# agent-node 2.5.0-preview.190

Since `.189`: a node forked/created by a daemon behind an HTTP proxy can reach the Hub.

## What changed

```text
create-node-daemon.ts  DAEMON_CHILD_INHERITED_ENV_KEYS += NODE_USE_ENV_PROXY
```

The daemon passes `HTTPS_PROXY` & co. to children through `minimalEnv`, but Node's built-in
`fetch` ignores them unless `NODE_USE_ENV_PROXY=1`. On vdev (proxy-only egress) the fork of
TM基建欧 → AgentAPI基建欧 got through evidence → execute → deliver, then the child exited with
`TypeError: fetch failed` before registering, and the fork ended `unknown_rotation_required`.

## Verified

- `create-node-daemon.test.ts` 98 pass (new witnessed-red: NODE_USE_ENV_PROXY reaches the child);
  `daemon-extra-path` 3 pass, `runtime-readiness` 33 pass
- `tsc -p agent-node` = main (80 pre-existing)

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.190
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.190
```

## What it does not do

- Does not pass any other variable; the allowlist is otherwise unchanged.
