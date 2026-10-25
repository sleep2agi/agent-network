# CommHub Server — node-reported OpenCode catalog, v0.9.0-preview.158

Ships `main` after `.157`. Two additive fields on `GET /api/nodes`; no route, tool or
`/api/status` change.

```
@sleep2agi/commhub-server@0.9.0-preview.158
```

## What changed

### `GET /api/nodes` now carries what the OpenCode V2 nodes already know

`/api/nodes` deliberately does **not** return `config_snapshot` (the #312 explicit-projection
rule). The dashboard's 「Runtime · V2」 and 「OpenCode Server」 rows and its model picker were
reading `node.config_snapshot.*` — which never arrives over this endpoint, so on real machines
those rows were empty even after app#1092 merged them. Four scalars are now projected instead:

| field | shape | meaning |
|---|---|---|
| `opencode_catalog` | `string[] \| null` | `provider/model` ids **this machine's** OpenCode V2 server reported |
| `opencode_generation` | `"v1" \| "v2" \| null` | generation from `flags.opencodeGeneration` |
| `opencode_mode` | `string \| null` | `flags.opencodeMode` (`copresence`, …) |
| `opencode_server` | `string \| null` | the loopback endpoint (`http://127.0.0.1:PORT`) |

Everything else in `config_snapshot` still does **not** leave the Hub — a test seeds a
`must-not-leak` key and asserts it is absent from the response.

### Why the node reports its own list

`read_opencode_catalog` requires a daemon binding (`lifecycle_daemon_node_id` or an active
adoption). Nodes started by hand (`anet node start`) have neither, so their picker was
permanently empty and the operator had to type model ids by hand. The node now reads its own
loopback server at heartbeat time and reports the ids; **no names, settings, headers or
endpoints** are copied, and only `provider/model` strings are accepted.

### `report_status.config_snapshot.opencode_catalog` (node → Hub)

`z.array(z.string()).max(400).optional().catch(undefined)`: a malformed value drops **that
field only** and never rejects the heartbeat. `opencode_server` (≤200 B) rides beside it.

The tool list is still under the byte ceilings — they were **not** raised:

| role | before | after | ceiling |
|---|---|---|---|
| all | 85,972 B | **85,920 B** | 86,500 |
| node | 64,464 B | **64,400 B** | 64,500 |
| user | 59,680 B | **59,476 B** | 60,500 |

The room came from turning two verbose schemas/descriptions into compact forms (one array
field instead of an object, and two descriptions with their redundant clauses removed).
Nothing the contract tests pin was reworded.

## Tests

- `server/src/node-attrs.test.ts` — **real HTTP** (boots the Hub, seeds a node row, calls
  `GET /api/nodes`): the four fields are present with values, `config_snapshot` is absent, and
  a `must-not-leak` key inside `flags` never reaches the row. 11 pass.
- `server/src/api-nodes-shape.test.ts` — the handler-mirror contract: key set, valid list,
  absent / malformed / wrong-shape → `null`. 8 pass.
- `server/src/tool-audience-http.test.ts` — ceilings unchanged, 12 pass.
- `opencode-v2-catalog` 5 pass · `status-read-cache-http` 10 pass ·
  `external-schedule-edits-http` 10 pass (neighbours of the `report_status` schema).
- `agent-node`: build OK, typecheck ratchet **81 = baseline** (no new errors).

## Not in this release

- No permission change: node tokens still cannot read `read_opencode_catalog` and cannot write
  tags.
- No `/api/status` change — `?light=1` byte contract untouched.
- `latest` dist-tag is not moved by this release.
