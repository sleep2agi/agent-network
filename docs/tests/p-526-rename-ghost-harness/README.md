# #526 · rename-ghost harness — PTY wrap + trailer trap + preflight

**One-line purpose**: the `rename-ghost-gate` CI job was red 13/13 on main because Claude CLI 2.1.220+ refuses to start without a TTY, but `run.sh` was running `nohup anet node start ...` — no PTY, no `--accept-dev-channels`. anet correctly fail-closed with a "requires TTY" error; the harness never reached the trailer emit, so the CI gate reported "no trailer → treat as regression". This is *harness缺前提*, not product regression.

## Fix, in order of narrowness

1. **Preflight per-condition**: assert `script`, `tmux`, `anet`, `bun`, `claude`, `curl`, `jq`, `python3`, `sqlite3`, `pgrep`, `ps`, `kill`, and ≥ 200 MiB free on `/tmp` — each with its own ✗ line naming what's missing (not "the harness didn't produce a trailer"). #526 §1.
2. **Trailer trap**: `trap emit_trailer EXIT` at the top so every exit path — happy path, `exit 1` from A.1/B.1 bailout, preflight refusal — emits `PASS=N FAIL=N`. The CI gate always sees a trailer; distinguishes "detected ghost" (FAIL > 0) from "harness bailed" (FAIL ≥ 1 from A.1/B.1 bad) rather than losing both to "no trailer".
3. **CASE A: `script -q -c ...` PTY, NOT tmux**: wraps `anet node start` with a real PTY so `process.stdin.isTTY` is true for the child. Claude CLI 2.1.220+ auto-switches to `--print` without TTY and refuses interactive; anet #494 preflight fail-closes with the "requires TTY" hint pointing at `--accept-dev-channels`. **We do NOT switch to `--accept-dev-channels`** — that spawns a *detached tmux session* (see `agent-network/bin/cli.ts` L4476/L4499), collapsing CASE A into a copy of CASE B while the label still claims "no tmux". CASE A's "no tmux" is load-bearing because the process-tree shape drives ghost-production conditions (cleanup path is shared, production is not). Judgment call by 通信龙 2026-07-30.
4. **Mock upgrade: `setsid` on mock-mcp spawn**: without `setsid`, mock-mcp lived in the parent's process group, so a SIGHUP cascade killed it whenever mock-claude died. That meant sweep-stubbing produced no ghost — the harness had *never* actually witnessed a red case in this test. `setsid` detaches mock-mcp into its own session, making it survive parent death via the exact mechanism sweep is meant to catch.

## What this harness verifies (that unit tests do NOT)

| Layer                              | Unit test | This harness |
|------------------------------------|-----------|--------------|
| `sweepMcpOrphansForAlias` code correctness (function-level) | ✅ | ❌ |
| Env-alias regex against `/proc/PID/environ` reality | ❌ | ✅ |
| Whole-flow: rename → parent SIGKILL → orphaned subprocess survives → sweep reaps → `/api/status` clean | ❌ | ✅ |
| SIGHUP-cascade vs setsid detach behaviour | ❌ | ✅ |
| CI gate can distinguish "green" / "ghost detected" / "harness bailed" | ❌ | ✅ |

## Run

```bash
docker build -t anet-qa180 -f tests/qa-180-rename-ghost/Dockerfile .
docker run --rm --tmpfs /tmp:rw,exec anet-qa180
```

Expected trailer (production sweep, setsid mock):

```
PASS=20 FAIL=0
```

## Witnessed-red evidence

`witnessed-red.txt` — captured 2026-07-30 with:
1. `sweepMcpOrphansForAlias` stubbed to `return []` (no-op) in `agent-network/bin/cli.ts`
2. Mock-mcp `setsid`-detached (this branch's improvement)

Result:

```
✗ A.6b GHOST DETECTED: 1 MCP subprocess(es) still heart-beating with OLD alias=rename-target-a
✗ B.6b GHOST DETECTED: 1 MCP subprocess(es) still heart-beating with OLD alias=rename-target-b
PASS=18 FAIL=2
```

CI gate now reports **`rename-ghost regression: FAIL=2 (any FAIL > 0 = ghost process reproduced)`**, not `no trailer → treat as regression`.

**Judgment cross-check for future readers**:
- Production sweep + setsid mock → `PASS=20 FAIL=0` (fix works)
- Sweep stubbed + setsid mock → `PASS=18 FAIL=2` "GHOST DETECTED" (门 truly witnesses ghost)
- Sweep stubbed + non-setsid mock (pre-branch state) → `PASS=20 FAIL=0` (mock's SIGHUP cascade masks the missing sweep — 门 has never witnessed red)

The third row is the discovery that motivated the mock upgrade. Before this branch, disabling the entire `#180` fix would have shown the same green as keeping it — the门 was not actually protecting anything. Now it does.

## Why `--accept-dev-channels` was rejected (deliberate design record)

The purpose-built headless flag `--accept-dev-channels` exists in anet for this class of scenario:

```
• For headless / CI / systemd / docker without -it:
  anet node start '<alias>' --accept-dev-channels
  (detached tmux session with a real PTY; auto-confirms the
   dev-channels prompt if the node uses server: channels)
```

Reading anet source confirms it **always** spawns detached tmux (`agent-network/bin/cli.ts` L4476/L4499). Substituting it for CASE A's `nohup ...` would:

- fix the "no PTY" symptom (green)
- silently transform CASE A into "detached tmux" — a duplicate of CASE B
- leave the label "foreground start (no tmux)" in place
- lose real ghost coverage of the non-tmux path

That is precisely the "test name lies" shape that we treat as a P0 defect elsewhere. See 通信龙 hard 裁定 2026-07-30 (task 2a95a950).

Fallback ladder if `script` becomes unavailable: `socat` PTY, `expect` PTY, then **only if all three fail**, switch to `--accept-dev-channels` **AND** simultaneously (a) rename CASE A's title + file header to reflect the change, (b) open a follow-up issue tracking "non-tmux ghost coverage lost".

## Related

- Issue #526 (this fix)
- Issue #494 (the TTY-required preflight in anet that fail-closed correctly)
- Issue #518 (the `--accept-dev-channels` flag is anet's own suggested fix in error messages but is absent from `--help`; add this case as a real-world example of a harness red for 13 runs because the writer couldn't find that flag in `--help`)
- Issue #180 (the ghost bug this harness was created to prevent)
