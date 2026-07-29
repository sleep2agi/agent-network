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

---

# Part 2 — the CLI restart choreography (2026-07-30)

Covers the half Part 1 deliberately excluded: `anet node rename <old> <new>
--force` stopping the old agent, confirming it is dead, and what it claims
about the relaunch. Files: `cli-harness.sh`, `deaf-agent.mjs`,
`cli-evidence.log`, `cli-verdicts.txt`.

Targets the two blockers a prior review raised against the #146 fix.

| # | requirement | verdict | evidence |
|---|---|---|---|
| R1 | a SIGTERM-**deaf** old process is escalated to SIGKILL — no survivor left to heartbeat the old alias back | **PASS** | `old_pid_alive=0`; the shell independently reported `356 Killed`, and the mock only dies to SIGKILL |
| R1b | after the rename the hub holds no live session under the OLD alias | **PASS** | `stale_before_alias_present=0` |
| R2 | a relaunch that cannot happen is reported honestly — no false "restarted + re-registered" | **PASS** | `false_success_claims=0`, 3 honest signals in output |
| R3 | after the CLI rename the hub accepts traffic for the NEW alias | **PASS** | `send_task_to_new_alias_ok=1` |

## Two FAILs on the way, both mine — recorded because they matter

This did not go green on the first run, and neither red was a product
defect. Reporting only the final green would hide how easy it is to
manufacture a false bug here.

**Attempt 1 — 3 FAILs.** The container had no `ps`. The CLI refused the
rename outright:

```
[anet] ❌ cannot inspect the process table (`ps` failed) — refusing the rename.
       Rename must locate + stop the old agent; without `ps` it risks a
       ghost or stopping the wrong process.
```

That is the product being **correct** (fail-closed rather than risk killing
an unrelated process). Had the red been reported as-is it would have read
as "rename is broken".

**Attempt 2 — R1 still FAIL.** The CLI reported `Node was not running` and
skipped the kill path entirely. Cause: `findNodeProcessesByAlias` only
matches genuine agent executables (`agent-node` / `claude` / `codex` /
`grok` or the package path) **and** requires an `--alias <name>` argv pair —
a deliberate #180 R1 guard so a substring match cannot get an unrelated
process killed. My mock ran as `bun deaf-agent.mjs`, so it was correctly
not recognised as that node's process. Fixing the *mock* to satisfy the
real identity contract (run from a path carrying the package name, pass
`--alias`) turned R1 green.

Both reds were harness defects meeting correct product defences. The
green only counts because the mock now meets the same identity bar a real
agent process does.

## Still not covered

- The relaunch **succeeding** end to end. This container has no runtime
  credentials, so R2 verifies the honest-failure path, not a live restart.
- Whether `latest` (the published package users install) carries these
  fixes. Part 1 and Part 2 both test source at `main` — as #491 showed,
  main being fixed does not mean users stopped hitting it.
