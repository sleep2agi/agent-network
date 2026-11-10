# commhub-server 0.9.0-preview.250

Since `.249`: the "never picked up" gate now covers **both** dispatch surfaces. `.249` closed the MCP
`send_task` path; REST `/api/task` is a separate implementation and kept dispatching.

## Why this release exists

`.249` added `neverConsumeGate` to the MCP `send_task` handler. REST `/api/task` has its own dispatch
implementation (its own `assertNodeHealthy` call), so a task sent over REST to a node that had expired
everything still queued.

This is the same class the day already produced once (the `assignee` leak lived on two read surfaces;
only one was fixed first). The rule that came out of it: **before saying "fixed", count the entry
points.**

## What changed

- REST `/api/task` runs the same `neverConsumeGate(...)` right after the existing degraded-target
  check, with `forceAllowed = !restAuth?.networkId` (user tokens may force, node tokens may not).
- The refusal body is **byte-identical** to the MCP one; only the transport status differs
  (409, matching REST's existing refusals).

## Verification

`node-health-dispatch-http.test.ts` (21 pass):

- three never-consumed expiries ⇒ `409 target_never_consumes` with `window_since`, and **no task row
  is written**;
- the same target with `force: true` from a user token ⇒ 200;
- counter cleanup happens in `finally` — the counters are process-level state and leaking them
  poisons later cases (which is exactly what happened on the first attempt).

The node-token-cannot-force rule is pinned at the **predicate** level (`expiry-counters.test.ts`),
not here: at the HTTP level a node token hits the degraded gate first (health is keyed by network and
a node token has none), so asserting it here would measure the *ordering of two gates* instead of
this gate.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.250
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.250
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-250 pm2 restart <name> --update-env
```
