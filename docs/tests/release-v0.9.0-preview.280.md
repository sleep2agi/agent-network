# commhub-server 0.9.0-preview.280

Since `.279`: `/api/status` carries `node_secrets_capable`, so the app's node 密钥 page unlocks for capable nodes.

## Why

The app gates the 密钥 page on `node_secrets_capable` (capability-first). The Hub stores that flag in
`nodes.config_snapshot`; `/api/status` never projected it, so the app fell back to the runtime version — null for
claude-code nodes — and showed "upgrade required" on a capable node.

## What changed

```text
server.ts /api/status (full projection): node_secrets_capable: true from nodes.config_snapshot,
  one batched lookup; emitted only when true (other rows byte-identical); light projection unchanged.
```

## Verified

- new `status-node-secrets-capable-http.test.ts` passes (fails on .279)
- status suites green: node-token-privilege-http 15/15, node-logs-transport 10/10, host-supervisors-daemon-version 3/3,
  route-callers-http 5/5, status-read-cache-http 10/10, status-alias-resolver-http 7/7, agent-acl-slice3-http 38/38
- tsc 196 (= main)

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.280
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.280
# production: install into ~/.commhub/runtime-0-9-0-preview-280, point hub-daemon.sh at it, pm2 restart commhub-hub
```

## What it does not do

- Does not change who may write secrets; the app still needs a capable node.
