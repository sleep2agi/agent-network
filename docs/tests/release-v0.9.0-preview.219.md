# commhub-server 0.9.0-preview.219

Since `.218`, one behavioural change: `update_node_config` now tells the caller when a restart-tier
patch is about to take a node offline for good.

| Commit | What |
|---|---|
| ffcd3f66 | restart-tier patch on a bare-spawn node returns `warnings: [{ code: "restart_requires_supervisor" }]` |

## Behaviour

- **A restart-tier patch aimed at a node with no supervisor is now labelled as such.** agent-node
  reports `config_update_capable` = *"this process runs under a supervisor wrapper that honours the
  sentinel-75 restart path"*. On a bare-spawn node (`nohup node …/cli.js`, no `anet start` / pm2
  wrapper) that is `false`. Sending a restart-tier patch to such a node makes it write the config,
  ack `restarting`, exit 75 — **and nothing respawns it**. The update then sits in
  `pending`/`restarting` until the 60s reaper marks it `timeout`, so the caller only ever sees
  "timed out" and never learns that the node is now offline.

  The response now carries:

  ```json
  { "ok": true, "update_id": "cu_…", "apply_mode": "restart",
    "warnings": [{ "code": "restart_requires_supervisor", "message": "…exit 75 and nothing will respawn it…" }] }
  ```

  - Only for `apply_mode !== "hot"`. A model-only patch on an OpenCode V2 co-presence node is
    `hot` (`.218` + agent-node `.168`) and produces no warning — it does not restart anything.
  - Only for `config_update_capable === false`. Missing / unparseable / non-boolean values are
    treated as **unknown**, never as `false`, so nodes that have not reported the flag yet are not
    warned at.
- **Nothing is rejected.** The patch is still queued and still applied; the warning is additive
  metadata in the response, so existing clients keep working unchanged.
- No schema change, no config change, no new flag.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.219
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.219
anet hub restart
```

`anet` pins the Hub version it starts; restart the Hub on the new build for the change to take
effect.

## Evidence

- `server/src/config-apply-validate.test.ts` — `readConfigUpdateCapable` covers
  `true` / `false` / absent / bad JSON / null / the string `"false"` (which must read as
  **unknown**, not `false`). 81 pass / 0 fail.
- `config-apply-sec1` + `node-id-alias` 75 pass / 0 fail.
- Typecheck delta against the parent commit is zero (server 218 → 218, all pre-existing).
- Production reproduction that motivated this (twice, 2026-10-31): a `nohup setsid` node with
  `config_update_capable=false` received a restart-tier patch, acked `restarting`, exited 75 and
  stayed down until it was started by hand.

## promote 时的 must_contain

`"version": "0.9.0-preview.219"`
