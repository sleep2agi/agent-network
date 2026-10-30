# agent-node 2.5.0-preview.166

Since `.165`, `agent-node/` has two behavioural changes (plus one Windows fix):

| Commit | PR | What |
|---|---|---|
| 07452a4a | #3262 | #3103: queueing (admission) gets its own cap and no longer eats the reply budget |
| 07452a4a | #3262 | #3095: the late-reply channel no longer accepts tasks that already ended `replied` |
| 07452a4a | #3262 | #2224: late-reply persistence no longer uses a bare `renameSync` |

## Behaviour

- **Queueing no longer consumes the reply budget.** The OpenCode copresence bridge used one
  wall-clock budget for the whole task, so a task that waited 29 minutes behind a human TUI turn
  had one minute left to reply — and was then reported as "executed but the reply was withdrawn".
  A new `OPENCODE_ADMISSION_CAP_MS` (default 10 minutes, `0` = no extra cap) bounds only the
  queueing phase: when the shared session stays busy past the cap the task is reported as
  **not submitted, please resend later**, instead of silently starving the reply phase.
  The overall task deadline is unchanged, so a single task can still never occupy two budgets.
  The timeout message now names this knob, so operators stop tuning `OPENCODE_TIMEOUT_MS`
  for a queueing problem.
- **An already-`replied` task can no longer receive a late reply.** `.216` opened the late-reply
  channel for every terminal task, which included `replied` — the sender had already received a
  result, so the second reply became a *second* message in its inbox. Task rows are still never
  rewritten by a late reply; `failed` / `expired` / `cancelled` tasks keep the late-reply channel.
- **Late-reply persistence is Windows-safe.** `late-reply-store` wrote a temp file and renamed it
  with a bare `renameSync`, which fails with `EPERM`/`EBUSY`/`EACCES` on Windows when the target is
  held by another handle. Because the write path only returns `false` on error, re-arming the same
  task could silently fail to persist — the exact loss the persistence layer exists to prevent.
  It now uses `renameOverExistingSync` (win32 only, bounded retry 10/25/50/100/200 ms).
- No dependency changes. No config file changes (one new optional env var).

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.166
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.201 @sleep2agi/agent-node@2.5.0-preview.166
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.201 ↔ agent-node@2.5.0-preview.166`):
  anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #3103: `opencode-timeout.test.ts` (5 cases: default/env/0/junk/three budget combinations);
  `runtime.test.ts` behavioural case — busy session + 400 ms cap + 60 s budget must report
  admission at 400 ms and name 400 ms in the message (with the whole budget it would wait 60 s).
- #3095: `peer-reply-atomic.test.ts` #698 — a replay after a successful reply is still refused and
  the task result is not overwritten; `scheduled-stuck-http` #464 and `task-stale-open` #519 updated
  to the `.216` contract; `tests/qa-hub-21-schedule-stuck` updated the same way (executing node +
  expired task now yields `{ok:true, late:true}`).
- #2224: `windows-rename-coverage` green; `late-reply-store-3095` + `late-reply-recover-3095` pass.
- Local: `agent-node` copresence suite 255 pass / 1 skip / 0 fail; `server` three suites 41 pass.
- CI: all 10 required status checks green; the only red on the merge commit was
  `native-turns (1.18.1)`, a known flake that passes on re-run.

## promote 时的 must_contain

`"version": "2.5.0-preview.166"`
