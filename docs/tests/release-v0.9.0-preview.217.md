# commhub-server 0.9.0-preview.217

Since `.216`, the Hub has one behavioural change.

| Commit | PR | What |
|---|---|---|
| 07452a4a | #3262 | #3095: the late-reply channel no longer accepts tasks that already ended `replied` |

## Behaviour

- **An already-`replied` task can no longer receive a late reply.** `.216` opened the late-reply
  channel for every terminal task. That included `replied`, where the sender had already received
  a result — so the second reply was written to `task_late_replies` **and** queued a second message
  into the sender's inbox. The sender saw two results for one task, which is exactly the duplicate
  delivery `#698` guards against. `replied` now keeps the old `reply_task_terminal` answer.
- **Unchanged for the cases the late-reply channel exists for.** `failed`, `expired` and
  `cancelled` tasks still accept a late reply from their executing node: the result is appended to
  `task_late_replies` (idempotency key `(task_id, thread_id, turn_id)`, placeholder `unrecorded`
  when the task never recorded context) and **the task row is never rewritten**. A late reply is
  not a retroactive success.
- **Non-executing callers are still refused** with `late_reply_node_token_required`; the check that
  only `task.to_node_id` may post a late result is unchanged.
- No schema change, no config change.

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.217
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.217
anet hub restart
```

`anet` pins the Hub version it starts; restart the Hub on the new build for the change to take effect.

## Evidence

- `server/src/peer-reply-atomic.test.ts` #698 — a replay after a successful reply is refused as
  `reply_task_terminal` and the task result is not overwritten (this test is what caught the `.216`
  regression: replay produced a second inbox row).
- `server/src/scheduled-stuck-http.test.ts` #464 and `server/src/task-stale-open-http.test.ts` #519 —
  updated to the `.216` contract (executing node + expired task yields `{ok:true, late:true}`;
  a `from_session` caller yields `late_reply_node_token_required`).
- `tests/qa-hub-21-schedule-stuck` — same contract in the shell QA scenario.
- Local: the three server suites 41 pass / 0 fail after the change.
- Production verification (`.216`) of the channel itself: a `failed` task with `thread_id`/`turn_id`
  both null accepted `send_reply` without ids, wrote one `task_late_replies` row (`unrecorded`) and
  left the task row `failed`.

## promote 时的 must_contain

`"version": "0.9.0-preview.217"`
