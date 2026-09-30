# agent-node 2.5.0-preview.93

Since `.92`, `agent-node/` has one commit (`files: ["dist", "README.md"]`; the change is in `src/` and is bundled into `dist/cli.js`):

| Commit | PR | What |
|---|---|---|
| 7fee51d1 | #2196 | The node finds its own current alias with a small filtered read instead of the whole network's status. `CurrentAliasResolver` used to call the full `GET /api/status` every 30 s on every node just to pick out its own row by `node_id`. The transport now lives in `src/runtime/status-alias-fetch.ts`: if the Hub's `/health` lists `status_node_id` in `capabilities`, the node calls `GET /api/status?network_id=…&node_id=<id>&light=1` and gets one small row back; otherwise it does the same full read as before |

No new runtime dependencies.

## Behaviour

| Situation | What the node does |
|---|---|
| `/health` advertises `status_node_id` | Filtered read `?node_id=<id>&light=1` (one row) |
| Older Hub (no flag), `/health` error or non-2xx | Full read, same URL as `.92` |
| Filtered read returns an empty list | Keeps its cached alias; no full read (the filter runs under the same scope, so the full read could not find the node either) |
| Filtered read returns rows, none with this `node_id` (Hub ignored the parameter) | Full read now; the flag is not trusted again until the next probe |
| Filtered read returns non-2xx | Full read now |

- The `/health` probe result is cached for 10 minutes, so a Hub upgrade or rollback is picked up without restarting the node. Cost: one small anonymous `/health` read per node every 10 minutes.
- The 30 s alias cache is unchanged. The token is read on every request, as before.

## Compatibility

- 🔴 **The saving needs Hub `@sleep2agi/commhub-server@0.9.0-preview.78` or newer** (#2194 adds `?node_id=` and the `status_node_id` capability). Against an older Hub the node behaves exactly like `.92`.
- **No config changes.** No config keys were added, removed or renamed. A node on `.92` can point its existing `config.json` at the new build.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.93
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.120 @sleep2agi/agent-node@2.5.0-preview.93
```

Nodes must be restarted on the new build for the change to take effect. The Hub does not have to be upgraded first.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.120 ↔ agent-node@2.5.0-preview.93`).

## Evidence

- #2196: `src/runtime/status-alias-fetch.test.ts`, 10 tests (new Hub, old Hub, `/health` throwing / 503 / non-JSON, unknown node, parameter ignored, filtered 500, upgrade picked up after the probe TTL, token rotation, the real `CurrentAliasResolver` still making one request per 30 s). Six mutations of the transport each turn at least one test red.
- End to end against throwaway Hubs (port 0, temp HOME and DB, 40 seeded nodes): a Hub with #2194 answers the filtered read with 421 B; a Hub without it gets the full read, about 127 KB per call, as today.

## promote 时的 must_contain

`"version": "2.5.0-preview.93"`
