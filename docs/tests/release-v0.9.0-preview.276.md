# commhub-server 0.9.0-preview.276

Since `.275`: the published package **can start again**, and fork refusals say why.

## Why

`.275`-era `main` (since 7c12d59c) imported `../../contracts/*` from the repo root. The npm package only
ships `src/` + `bin/`, so a packed Hub died on boot with
`Cannot find module '../../contracts/session-source-delivery'` (e2e "Loop npm-pack install").

## What changed

```text
#3404  server/src/contracts/*  canonical contract files inside the package; root contracts/* re-export
       server/src/package-self-contained.test.ts  shipped code may not import outside server/
#3402  session-source-transport.ts  fork-create 409 now carries `reason`
       (daemon_offline / daemon_not_capable / hub_busy / evidence_unavailable / intent_reused),
       only after the caller's source permissions are verified; `error` and status codes unchanged
```

## Verified

- `npm pack` → extract → `bun bin/commhub.ts --port 9311` → `/health` `{"ok":true}` (crashes on `.275`-era main)
- `session-source-evidence` 37 pass / 2 env-only fail (same 2 as main), new reason test passes
- `package-self-contained.test.ts` fails on old main (9 escaping imports), passes here

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.276
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.276
# production hub: scripts/deploy-hub-runtime.sh --version 0.9.0-preview.276
```

## What it does not do

- No schema change, no new tools, no change to who may fork.
