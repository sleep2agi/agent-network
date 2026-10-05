# agent-network 2.3.0-preview.143

Pairing release: `PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.143`, `PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.110` (see [`release-v2.5.0-preview.110.md`](./release-v2.5.0-preview.110.md)).

Since `.142` (release merge `89e41713`, #2392), `agent-network/` has one change:

| Commit | PR | What |
|---|---|---|
| c7f1bdba | #2399 | #562 step 1: `anet node ls --all` lists every node in the network, grouped by machine |

## Behaviour

- `anet node ls --all [--network <id|name>] [--json]` lists every node the Hub shows you in one network (default: current network), grouped by hostname, with alias, runtime, status, last seen and model. Each machine header says whether it has an online daemon (`host_supervisor`) — i.e. whether it can be managed remotely later.
- Read-only. Uses three existing Hub endpoints (`/api/networks`, `/api/status?network_id=`, `/api/host-supervisors?network_id=`); no Hub change.
- Uses only the token saved by `anet login`; it ignores `COMMHUB_TOKEN` (inside a node's shell that holds the node's own token) and refuses a saved node token.
- Restricted members see exactly what the Hub returns to them; when the Hub hides daemons from them, machines show `daemon: none visible` (with a footnote), never a flat "no daemon".
- `--network` matches by id, name or a unique id prefix; ambiguous input is refused. Without `--all`, `anet node ls` is unchanged.

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.143 @sleep2agi/agent-node@2.5.0-preview.110
```

## Upgrade

```bash
anet upgrade --channel preview
# or explicitly:
npm i -g @sleep2agi/agent-network@2.3.0-preview.143 @sleep2agi/agent-node@2.5.0-preview.110
```

Upgrade both packages together (`agent-network@2.3.0-preview.143 ↔ agent-node@2.5.0-preview.110`).

## Evidence

- #2399: 16 unit tests (`node-ls-all.test.ts`), each witnessed red under a deliberate break; agent-network unit suite in Docker 1852 pass / 0 fail; Docker suite `tests/test562-node-ls-all` (throwaway hub, two hostnames, one daemon, a second network, a restricted member) — grouped table, `--json`, `--network` by name/id/unknown, restricted view (also with a node token in `COMMHUB_TOKEN`), plain `node ls` unchanged — with 4 witnessed reds; 129/129 checks.

## promote 时的 must_contain

`"version": "2.3.0-preview.143"`
