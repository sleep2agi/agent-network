# commhub-server 0.9.0-preview.278

Since `.277`: `get_all_status` is cached for 10 s per (read scope, filters); OpenCode V2 adoption refusal codes are public.

## Why

Production 2026-11-09: ~20 LLM agents each polled `get_all_status` about once a minute (465 calls / 22 min).
Each call rebuilt a ~580 KB response; RSS swung 0.7–1.2 GB and the event loop stalled 2–9 s every few seconds
(663 stalls in ~2 h). Phone sends sat at 「发送中」.

## What changed

```text
all-status-cache.ts + tools.ts get_all_status
  identical (read scope, filters) within 10 s reuse one serialized response; bounded 256 entries
  members restricted to granted agents bypass the cache (grant/revoke applies immediately)
node-lifecycle-read.ts  public codes adopt_opencode_bridge_not_running / adopt_opencode_lifecycle_unsupported (#3411)
```

## Verified

- `all-status-cache.test.ts` 3 pass; `agent-acl-http` 61/61, `agent-acl-slice3-http` 38/38, `stale-sweeper`,
  `task-queue-ahead-http`, `alias-filter`, `network-token-membership-http`, `mcp-route-label-http` all pass
- `tsc --noEmit -p server` 196 (= main)

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.278
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.278
# production: install into ~/.commhub/runtime-0-9-0-preview-278, point hub-daemon.sh at it, pm2 restart commhub-hub
```

## What it does not do

- Roster data may be up to 10 s stale for unrestricted callers; filters and scopes never share entries.
