# #146 rename — 5-case re-verification (2026-07-30)

Runs the **original 5-case matrix from the issue body**, against current
`main` (`6ab578ad`), in Docker. Raw request/response for every step is in
`evidence.log`; machine-readable outcomes in `verdicts.json`; the harness
that produced both is `harness.ts` (re-runnable, see below).

## Verdict

| # | case (issue wording) | verdict | what actually proved it |
|---|---|---|---|
| 1 | rename while agent **running** → `send_task` to `after` received | **PASS** | commit ok; task addressed to the new alias found **inside the node's inbox** |
| 2 | rename while agent **stopped** → received after restart | **PASS** | task sent while no heartbeats were flowing, then found in the inbox once the node re-registered under the new alias |
| 3 | sender still uses the **old** alias → clear error, not a silent timeout | **PASS** | hub answers `ok:true` **with `renamed_from`/`renamed_to`** and the task lands on the new alias — an explicit, self-describing outcome rather than silence |
| 4 | rename a **purely-created** node → error message clear | **PASS** | `ok:false`, `code:"node_local_only"`, message names the node and the reason, plus `suggested:"rename locally"` |
| 5 | post-rename surfaces show `after`, not `before` | **PASS** | `/api/nodes` and `/api/status` both contain the new alias and **no** stale alias |
| — | **negative control (MUST FAIL)** | **FAIL — as designed** | asserted a marker that was never sent; it was correctly not found |

`SUMMARY 5/6 PASS` in the raw output = **5/5 real cases pass, control fails
as intended**.

## Why the negative control is here

Cases 1–3 conclude "delivered" by finding a marker inside the node's inbox.
If that lookup could never fail, all five greens would be worthless. The
control asserts a marker that was **never sent**: it must FAIL. It does
(`found_bogus_marker=false`). A PASS there would invalidate the entire run.

## Scope — what this does and does not cover

**Covers:** the hub-side rename semantics — the same 2PC endpoints
`anet node rename` calls internally (`/api/node-rename/prepare|commit`) —
and message routing across the rename.

**Does not cover:**
- The CLI's process-restart choreography (stop → verify dead → relaunch).
  That is what the existing 14-case `p-146-pr5-rename` run exercised.
- A Playwright screenshot for case 5. The issue asks for one; this run
  asserts the **data surfaces** (`/api/nodes`, `/api/status`) instead,
  because that is where a stale alias would originate. A dashboard
  screenshot would add UI-layer confirmation on top and is not claimed here.
- No LLM is involved. The question under test is whether a message
  addressed to an alias **reaches** the node — routing, not generation — so
  the agent is a mock that registers with the identical MCP `report_status`
  call a real `agent-node` makes and polls `get_inbox`.

## Why the prior artifacts were not reused

`docs/tests/p-146-pr5-rename/` (2026-06-15) records 14 cases, but:
- every per-case file contains only a one-line self-assessment
  (`PASS|N|x/x checks`) — no commands, no request/response, no verify output,
  none of the artifacts the issue asks each case to produce;
- `REPORT.md` contains **two** verdict matrices and **two** contradictory
  summaries (`13/14 PASS, 1 FAIL` followed by `14/14 PASS, 0 FAIL`), with
  duplicated rows;
- it was produced 45 days ago against a different `main`.

So it could not be used as the evidence this issue asks for. This run
records every request and response verbatim instead.

## Reproduce

```
docker run --rm -v <repo>:/src:ro -v <workdir>:/work -w /work oven/bun:1 \
  bash -c 'mkdir -p /work/home && bun run /work/harness.ts'
```

Everything runs inside the container: the hub is booted **from source**
(`server/src/index.ts`), so the verdict describes the code about to ship,
not a published package. No host hub, no production database, no network
egress beyond loopback.

`evidence.log` is scrubbed: all `utok_` / `ntok_` values and token hashes
are replaced with `<redacted>` (verified: zero raw tokens remain).
