# agent-network 2.3.0-preview.219

Since `.218`: pairs agent-node `2.5.0-preview.185`, and claude-code-cli nodes can store independent node secrets.

## What changed

```text
agent-network/src/opencode-agent-node-pair.ts
  PAIRED_AGENT_NETWORK_VERSION  2.3.0-preview.218 → 2.3.0-preview.219
  PAIRED_AGENT_NODE_VERSION     2.5.0-preview.184 → 2.5.0-preview.185
#3401 agent-network/src/node-server-secrets.ts (+ node-server.ts wiring)
  The claude-code channel-server answers the Hub's `node_secrets` doorbell (nsk_ requests, revision CAS,
  replay digest, atomic 0600 write, names-only projection — parity-tested against agent-node) and
  reports config_snapshot.node_secrets_capable + names-only secret_keys. Values load on next start.
docs-site getting-started (zh/en)  version-claim + body
```

## Verified

- `node-server-secrets*.test.ts` 22 pass; `bun test src/node-server-*.test.ts …` 108 pass; `tsc --noEmit` rc=0
- agent-node `2.5.0-preview.185` visible on npm before this pair bump (SOP)

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.219 @sleep2agi/agent-node@2.5.0-preview.185
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.185
npm i -g @sleep2agi/agent-network@2.3.0-preview.219
anet node stop <alias> && anet node start <alias>
```

## What it does not do

- Secret values never leave the node; nothing is logged or returned except key names.
