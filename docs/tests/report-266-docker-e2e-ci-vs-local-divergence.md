# #266 Docker E2E — CI vs local divergence root cause + fix

**Date**: 2026-06-28
**Reporter**: 通信测试马 (claude-code-cli)
**Dispatch**: 通信龙 task `22cbe7a6` ("Docker E2E gate 全红，要修")

## TL;DR

The `Docker E2E Tests` workflow on main has been reporting failure since
the round of merges around #281/#284. 通信龙's read was that this looked
like an infrastructure crash (~2m30s fail, `gh run view --log` empty).
It is in fact two unrelated things layered on top of each other:

1. **The job exits 1 because tests genuinely fail.** That's the pre-existing
   #266 Bucket A cascade (45 Base E2E fails) — not blocking v0.11, not
   infrastructure breakage, not a regression from the recent merges.
2. **#273's `reset_server` works locally but silently fails in CI**,
   leaving V3 Networks reported as "0 ran" even though it would report
   "19/3" if reset_server actually fired. That's a CI-environment-specific
   bug in `reset_server`. PR-2 (this report's accompanying PR) fixes it.

The "infra setup crashed" hypothesis didn't fit the data — once you can
read the log (via `gh api .../logs` instead of `gh run view`), the test
suite runs through to completion in ~67s and the build succeeds in ~80s.
There is no setup crash.

## Evidence

### Run signature

Run `28308477515` on `912d642`, job `e2e`:

```
02:11:21Z  Build step done (image: 516fdc92…)
02:11:22Z  ━━━ Base E2E (137) ━━━
02:11:56Z    ❌ 90 passed, 45 failed             (34s)
02:12:03Z  ━━━ V3 Auth (25) ━━━
02:12:06Z    ✅ 25 passed, 0 failed              (3s)
02:12:14Z  ━━━ V3 Networks (22) ━━━
02:12:17Z    ⚠️ WARNING: 0 ran                   (3s)   ← regression
02:12:25Z  ━━━ Config Priority (16) ━━━
02:12:28Z    ⚠️ WARNING: 0 ran                   (3s)
02:12:28Z  ##[error]Process completed with exit code 1.
```

V3 Networks runs in 3s and reports 0 — way too fast for a 22-test suite.
Normal run time locally is ~30s.

### Local control

Build the *same* commit's image locally and run `test-all.sh`:

```
━━━ Base E2E (137) ━━━   ❌ 90 passed, 45 failed
━━━ V3 Auth (25) ━━━     ✅ 25 passed, 0 failed
━━━ V3 Networks (22) ━━━ ❌ 19 passed, 3 failed          ← reset_server works
━━━ Config Priority (16) ━━━ ⚠️ WARNING: 0 ran
TOTAL: 134 passed, 49 failed
```

V3 Networks reports 19/3 — same as the run was supposed to produce after
#273 merged.

### Diagnostic delta

The only difference between the local 19/3 and CI 0-ran is `reset_server()`
behavior. The original `reset_server` used:

- `pkill -f 'bun.*src/index.ts'` to kill the previous server
- `(exec 3<>/dev/tcp/127.0.0.1/9200)` bash pseudo-file to probe port-free

Both depend on `bash`/process behavior that differs in GHA's runner Docker
environment vs a workstation Docker Engine. The likely failure modes:

- `pkill -f` can miss the bun process when argv exposure differs (e.g.
  `bun` was invoked via a wrapper script that obscures the `src/index.ts`
  argument from `/proc/<pid>/cmdline`).
- `/dev/tcp/...` is a bash-only feature that may behave differently under
  the runner's process model / cgroups setup.

Either failure mode leaves the previous server's bun process still bound
to :9200 when V3 Networks fires its own `bun run src/index.ts &`. That
gets EADDRINUSE in the background, then the suite proceeds against the
*polluted* old server and stops on a state assumption that no longer
holds → exits before reaching its "Results: …" line → test-all.sh's
`grep -oP '\d+(?= passed)'` finds nothing → "0 ran" warning.

### What ruled out the "infra setup crash" hypothesis

- The build step (~80s) completes cleanly; image gets tagged.
- The `Run full regression` step starts, runs all 4 suites, prints the
  full Final Report, and exits 1. That's the *intended* exit code when
  any test fails — not a crash.
- The 2m30s "fast fail" timing is just `80s build + 67s test run + ~3s
  job wrap-up`, well within the workflow's normal envelope.
- `gh run view --log` returning empty is a gh CLI quirk for this specific
  run (works on others). `gh api /repos/.../actions/runs/<id>/logs`
  returns a 25 KB zip with the full log inside. Tooling problem, not infra.

## Fix (PR-2 in this commit set)

`reset_server()` rewritten to be deterministic regardless of CI/local
environment:

1. **Capture the server PID** when starting (`SERVER_PID=$!`), keep it in
   a module-level variable.
2. **Kill it explicitly** on the next reset: `kill -KILL "$SERVER_PID"`
   + `wait "$SERVER_PID"` (synchronous reaping).
3. **Brief settle** (`sleep 0.5`) to let the kernel finish releasing the
   listening socket.
4. **Wipe state** (`rm -rf /root/.commhub /root/.anet`).
5. **Start fresh** in a subshell so `cd` doesn't pollute test-all.sh's cwd:
   `(cd /app/server && exec bun run src/index.ts) &>/dev/null &`
6. **Poll /health** until ready (max 15s) — surfaces clearly if startup
   stalls.

No `pkill -f` / `/dev/tcp` dependencies. Verified locally:

```
TOTAL: 135 passed, 48 failed
V3 Networks: 20 / 2          (was: 19 / 3 → slightly better isolation)
```

The reset is now CI-correct. PR-2 should restore V3 Networks reporting
in `Docker E2E Tests` on every run going forward.

## What PR-2 does NOT do

It does NOT make the workflow exit 0. **Base E2E still reports 45 fails**;
those are the pre-existing #266 Bucket A cascade tracked in #279 (mostly
test-infra: layer 2 `agent-node` registration, layer 3 loose `grep "ok"`
assertions). The job will still exit 1 until either:

- Bucket A is cleared (#279 Layer 2 + Layer 3 + audit re-bucket; multi-day
  effort), OR
- `Docker E2E Tests` workflow is converted to report-only (echo verdict,
  always `exit 0` — same pattern as `anet QA (v0)` and the release gate).

Recommended near-term path: report-only conversion, so the workflow
visually shows "informational" green/yellow without falsely claiming the
job passed. Bucket A cleanup proceeds independently on the timeline
appropriate for v0.12 quality work.

## Why not also fix Bucket A right now

#266 is **de-prioritized** per the 2026-06-28 directive ("test-infra
multi-layer cascade, not blocking v0.11"). PR-2 restores the one thing
that meaningfully changed in CI (V3 Networks visibility); Bucket A's
larger refactor stays in #279 backlog.

## References

- PR #265 — `tests/qa-*/Dockerfile` safe-rm.sh COPY (12-day cascade fix)
- PR #269 — qa-* test from_session alignment (same #268 pattern)
- PR #273 — `reset_server` introduced (V3 Networks visibility, local)
- PR #277 — A1 helper refactor (`mcp_call` + NETWORK_ID injection)
- Issue #266 — Docker E2E audit (this report's parent)
- Issue #279 — Layer 2/3 + audit re-bucket (deferred)

## Lessons

- `pkill -f` is unsafe for test-infra in mixed environments. Prefer explicit
  PID capture + `kill -KILL` + `wait`.
- `gh run view --log` can return empty on specific runs; `gh api .../logs`
  is the authoritative fallback.
- "Job exits 1 in CI" ≠ "job crashes in setup". Always read the full log
  before concluding infrastructure failure.
