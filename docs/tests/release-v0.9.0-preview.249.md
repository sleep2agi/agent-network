# commhub-server 0.9.0-preview.249

Since `.248`: the count of "tasks that died without ever being picked up" is now **acted on**, not
just reported — a dispatch to such a target is refused unless a human passes `force: true`.

`.248` (the readout alone) was published but never deployed; `.249` carries both halves.

## Why the readout is not enough

A node expired nine tasks in a row (each after 60 min, none ever consumed). Every expiry produced a
"task expired" notice to the sender — but nothing anywhere said *"this node has now expired N tasks
without taking any"*, so the dispatching side had to remember it by hand. Counting alone does not
stop the next dispatch.

## What is added

`send_task` now runs a second gate, structurally identical to the existing degraded-target gate
(`assertNodeHealthy`), before anything is written:

```
neverConsumeGate({ alias, counters, force, forceAllowed })
  0–2 expiries in this window  ⇒ allow  (one or two may be a host restart; three is a pattern)
  ≥3 expiries                  ⇒ refuse: { ok:false, error:"target_never_consumes",
                                           alias, expiries, window_since, message }
  force                        ⇒ honoured only for user tokens (forceAllowed = !callerTokenIsNetwork)
```

The refusal carries `window_since` on purpose: the counter resets when the hub restarts, so "3" means
"3 since `<window_since>`", never "3 ever".

## Verification

`expiry-counters.test.ts` (10 pass) — the predicate is a pure function, so each branch is pinned:

- 0–2 ⇒ allow; ≥3 ⇒ refuse, with `alias` / `expiries` / `window_since` / `force:true` hint;
- a **user** token with `force` ⇒ allowed (the escape hatch is explicit);
- **a node token passing `force` ⇒ still refused** (a node cannot whitelist itself);
- another node's count does not affect this target (bucketed, not a total);
- plus the readout's own positive control and negative case from `.248`.

`send_task`'s three suites stay green (`agent-acl-http`, `task-consumption`,
`node-health-dispatch-http`) — the gate does not fire on their fixtures, as expected since counters
start at zero.

## Behaviour

- Additive refusal only; the success path is unchanged.
- No new field appears on success — the refusal is a separate response.
- The escape hatch is `force: true`, which already existed for the degraded-target gate.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.249
```

## Upgrade

```bash
# hub started by `anet hub start`
anet hub stop && anet hub start --server-version 0.9.0-preview.249
# hub run by pm2 (production profile)
HUB_RUNTIME_DIR=~/.commhub/runtime-0-9-0-preview-249 pm2 restart <name> --update-env
```
