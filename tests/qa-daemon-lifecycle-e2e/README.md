# qa-daemon-lifecycle-e2e

`anet daemon up` → `create_node` → child registers → `update_node_config`
→ `restart_node` → `stop_node`, exercised as **one chain on one child
within one daemon lifetime**.

## Why this suite exists

The individual tools are already covered. What was not covered is the
**state handoff between them**:

| suite | covers | on a daemon-created child? |
|---|---|---|
| `qa-rfc026-create-node` | `create_node` + child register | yes |
| `qa-rfc027-stop-delete` | `stop_node` / `restart_node` / `delete_node` | yes |
| `qa-rfc024-config-apply` | `update_node_config` — **contract surface only** | **no** |

`qa-rfc024-config-apply` documents its own gap in the source:

> A real "next think uses new value" check needs a vendor key + a live
> agent-node consuming the SSE doorbell. **That belongs in the longer-form
> QA.**

It mints an `ntok_` but never starts a node, so the hub answers
`node_not_found` and the stage takes its `skip` branch. (That suite is
honest about it — `SKIP` is counted separately and the footer lists which
scenarios are stubs. The hole was left deliberately, not hidden.)

So the questions this suite answers, which nothing else did:

1. Does `update_node_config` actually rewrite the **child's on-disk
   `config.json`** — not just return an `update_id`?
2. Does that value **survive `restart_node`**?
3. Does `stop_node` reap **the same process** the earlier steps configured,
   while the daemon itself stays up?

It also drives `anet daemon up` — the one-shot path a first-time user
actually types. `qa-rfc027` hand-writes the daemon's `config.json`;
`qa-anet-daemon-cmd` drives `init` and `start` separately. Neither covers
`up`.

## Judgement rules

- **Hub-side terminal state + the child's real on-disk config.** A tool
  returning `ok:true` is a dispatch receipt, not an outcome.
- **A startup banner is not readiness.** Nothing in this suite asserts on
  stdout text; readiness is always a hub API read or a file read.
- **Witnessed-red first.** Three red gates run at moments when the
  assertion *must* fail:

  | gate | asserted before | must be red because |
  |---|---|---|
  | 1 | `create_node` | the child config file does not exist yet |
  | 2 | `update_node_config` | `maxTurns` is still 7, not 99 |
  | 3 | `stop_node` | `lifecycle_state` is not yet `stopped` |

  Each red gate calls **the same shell function** the later green
  assertion calls — not a lookalike written twice. If a red gate passes,
  that is a `FAIL`: an assertion with no discriminating power makes every
  later green reading from it worthless.

  The footer enforces `RED >= 3`, so deleting a red gate turns the suite
  red instead of silently shrinking what it proves.

- **No pattern kills.** `pgrep` resolves concrete pids, `/proc/<pid>/cmdline`
  confirms the pid is ours, then that exact pid is killed. A pattern kill
  has taken down a live hub before.
- **Container-only.** The script refuses to run without `/.dockerenv`
  (override: `ALLOW_NON_DOCKER=1`), because it boots a hub and kills pids.

## Run

```bash
docker build -f tests/qa-daemon-lifecycle-e2e/Dockerfile -t anet-dlife .
docker run --rm anet-dlife
```

Hub port `9251` and DB `/tmp/qa-daemon-lifecycle.db` are distinct from the
neighbouring suites, so it can share a container with them.

## Known gap

`start_node` is a **TODO**, not an omission: the tool is not in `main`
yet (#1273 under independent review). The chain stops at `stop_node`; add
a stage at the end once it merges.
