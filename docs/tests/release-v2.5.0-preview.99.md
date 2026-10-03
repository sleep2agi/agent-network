# agent-node 2.5.0-preview.99

Since `.98`, `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 1443af71 | #2332 | #519: close skipped and low-value tasks instead of leaving them `acked` |

## Behaviour

- **Self-sent tasks now show as cancelled, with a reason.** A task a node sends to itself (and an echo of its own message coming back through another sender) is still **not run** — that guard has been there since the first release to stop a node answering its own replies forever. Before, the task was acked and then left hanging in `acked` with no result; now agent-node closes it with `cancel_task` and a reason saying no turn ran and pointing to scheduled tasks or `/aloop` for timed wake-ups. Closing writes no inbox row, so nobody is woken.
- **Low-value replies close the task.** When agent-node withholds a low-value reply, the task is now closed as `replied` via `report_completion` (result plus a "withheld" note) instead of being left `acked`. Nothing is put in the sender's inbox. Side effects, the same as a node calling `report_completion` itself: the session reports idle until its next status report, and a parent task is closed if the low-value task was a subtask.
- The Feishu bridge exemption for a node's own alias is unchanged.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.99
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.131 @sleep2agi/agent-node@2.5.0-preview.99
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.131 ↔ agent-node@2.5.0-preview.99`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.

## Evidence

- #2332: new `agent-node/src/inbox-skip-close.test.ts` against a fake Hub recording every call; 6 local mutations all red; Docker test612 (4/4 mutation layers red incl. 2 new), test698 (all red, one anchor retargeted), test725 agent-node unit 2242 pass / 0 fail; `check-mutation-pins` rc=0.

## promote 时的 must_contain

`"version": "2.5.0-preview.99"`
