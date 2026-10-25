# agent-node — the node reports its own OpenCode catalog, v2.5.0-preview.159

Ships `main` after `.158`. One additive heartbeat field; no new process, no new port, no new
config key.

```
@sleep2agi/agent-node@2.5.0-preview.159
```

## What changed

### The heartbeat now carries what the machine's own OpenCode V2 server can run

`report_status.config_snapshot` gains two keys, both optional:

| key | shape | where it comes from |
|---|---|---|
| `opencode_catalog` | `string[]` (`provider/model`, ≤400) | `GET /api/provider` + `GET /api/model` on **this node's** loopback serve |
| `opencode_server` | `string` (`http://127.0.0.1:PORT`, ≤200 B) | the endpoint record the copresence launcher already writes (`opencode-v2-catalog-endpoint.json`, mode 0600) |

Why the node and not the Hub: `read_opencode_catalog` requires a daemon binding
(`lifecycle_daemon_node_id` or an active adoption). Nodes started by hand with
`anet node start` have neither, so the dashboard's model picker stayed empty and the
operator had to type model ids by hand.

### Only ids leave the machine

`readOpenCodeCatalog()` (the same normaliser the daemon path uses) is applied to the loopback
responses; the heartbeat copies **`provider` and `model` ids only**. Names, settings, headers,
endpoints and response bodies are not copied — those can carry credentials. The endpoint file is
`0600`, is removed when the v2 session closes, and holds only url / Basic authorization /
directory.

### A failed read never costs a heartbeat

- the read happens only for `runtime=opencode` with `generation=v2` **and** only when this
  process recorded a loopback endpoint;
- timeout **3 s**;
- any error (`unauthorized`, `unavailable`, `invalid_response`, `too_large`, `scope_mismatch`)
  returns `undefined` → the key is simply absent;
- the Hub side accepts it as `z.array(z.string()).max(400).optional().catch(undefined)`, i.e.
  a malformed value drops **that field only**, never the report.

## What is deliberately NOT in this release

- No permission change: node tokens still cannot call `read_opencode_catalog` (human-only) and
  still cannot write tags.
- No `latest` dist-tag move. No `PAIRED_AGENT_NODE_VERSION` change here — the CLI release that
  pins this version ships separately.
- No `/api/status` change; the payload appears under `config_snapshot`, and the Hub projects the
  four scalars on `GET /api/nodes` only.

## Verification

- `bun run build` — OK.
- typecheck ratchet — **81 errors = baseline** (no new errors).
- `src/runtime/opencode-v2-catalog.test.ts` 8 pass · `opencode-v2-catalog-daemon.test.ts` 2 pass
  (the shared normaliser is unchanged; this release only calls it from the heartbeat).
- Real-machine proof (TMAI欧, after Hub `.158`): `GET /api/nodes` shows
  `opencode_catalog: ["deepseek/deepseek-flash", …]` and
  `opencode_server: "http://127.0.0.1:PORT"` while the node is running.
