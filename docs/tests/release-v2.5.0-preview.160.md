# agent-node — the catalog report actually leaves the node this time, v2.5.0-preview.160

Supersedes `2.5.0-preview.159`, whose two bugs made the feature a **no-op in the field** (not a
crash: the keys simply never reached the Hub).

```
@sleep2agi/agent-node@2.5.0-preview.160
```

## What was broken in `.159`

| # | bug | effect |
|---|---|---|
| 1 | the loopback endpoint record (`opencode-v2-catalog-endpoint.json`) is written into the **node state dir** (`workDir = NODE_DIR`), but `.159` looked in `process.cwd()` | endpoint never found → nothing reported |
| 2 | `opencode_catalog` / `opencode_server` were spread into the **top level** of the `report_status` payload | the Hub's top-level schema does not know those keys and drops them silently |

## What changed

- read the record from `NODE_DIR` first, keep a `process.cwd()` fallback for layouts that use the
  project dir as `workDir`;
- move both keys **inside `config_snapshot`**, where the Hub accepts them (non-strict object, and
  `server/src/tools.ts` names both keys explicitly).

## How this was proven (not by reading the diff)

An **isolated** pair was built for the check — a separate Hub (this package, fresh DB, port 29318)
plus a separate node (fresh alias, `opencodeGeneration=v2`, `opencodeMode=copresence`, real
`opencode` v2.0.22 serve). Nothing touched production.

```
GET /api/nodes   (on the isolated Hub)
{"opencode_generation":"v2",
 "opencode_server":"http://127.0.0.1:33319",
 "opencode_catalog":["opencode/flint-40b-free", … 9 models]}
heartbeat: 21:29:55 report_status: idle [net]
```

`.159` on the same environment produced `null` for both fields; `.160` produces values from a real
heartbeat.

## Install

```bash
set -e
npm install -g @sleep2agi/agent-node@2.5.0-preview.160
agent-node --version   # 2.5.0-preview.160
```

## Upgrade

```bash
agent-node --version                       # 2.5.0-preview.159 or older
npm i -g @sleep2agi/agent-node@2.5.0-preview.160
agent-node --version                       # 2.5.0-preview.160
# restart the running node process so it execs the new binary:
anet node list
# within one heartbeat (3 min) GET /api/nodes carries opencode_catalog / opencode_server
# for opencode v2 nodes
```

## What is deliberately NOT in this release

- No Hub change: `commhub-server@0.9.0-preview.158` already projects both fields.
- No permission change; node tokens still cannot call `read_opencode_catalog`.
- No `latest` dist-tag move.
- No `/api/status` change.

## Verification

- `bun run build` OK; typecheck ratchet **81 = baseline**.
- Isolated end-to-end above (both directions: `.159` → null, `.160` → values).
- Report size: catalog capped at 400 ids, endpoint capped at 200 bytes, read timeout 3 s, any
  failure returns `undefined` so a heartbeat is never rejected.
