# Is this node still alive

When a dispatched task goes unanswered, the first question is not "what broke" but
**"can it still do work at all"**.

This page gives one table, **ordered by how much each signal is worth**. It does not explain
failures — it answers that single question, and **only the last row gives a definite answer**.

## The table

| What you see | Strength | Why |
| --- | --- | --- |
| Text in the `task` field | **Worthless** | The **sender** writes that field (`send_task` does it itself). What it says depends on who last sent something, not on the node. Seeing something like `session disconnected` there does **not** make it a status field. |
| `status = idle` | **Weak** | `idle` only means "not busy". Measured, it covers at least four different realities (below). |
| Fresh heartbeat (`last_seen_at`) | **Weak** | The heartbeat comes from the outer process. The outer process can be alive while the inner reasoning process is dead. |
| `send_task` returns `ok` rather than `alias_offline` | **Moderate** | Routing works and the message is queued. **It says nothing about anyone processing it.** |
| 🔴 **It answered you** | **Hard evidence** | The only signal that does not depend on the observer's vantage point. |

**So: only the last row counts.** All four rows above can be green on a dead node; all four can
look dim on a node that simply has not been spoken to.

## The four realities behind `status = idle` (measured)

1. **Idle** — the literal meaning;
2. **Reasoning but not reporting** — measured: a node's TUI clearly showed
   `Wandering… (1m 12s · ↓ 2.1k tokens)` while `anet node ls` still reported `idle`;
3. **Just failed** — agent-node's error path reports `idle` back **unconditionally** in a
   `finally`, so a node that has just failed closed also advertises `idle`;
4. **Crashed** — nothing updates the status when a bare process dies.

⚠️ A statistical corroboration: measured across a fleet of a hundred-plus nodes, among those
with a fresh heartbeat the `status` field took **exactly one value (all `idle`), never `working`**.
**A status field that in practice only ever takes one value carries no discriminating information.**

## How to send the probe

```
commhub_send_task(alias="<node>", task="Reply with only the output of `git rev-parse --short HEAD`. Do not start any work.")
```

🔴 **The probe must ask for something only a node that actually executed could know.**

Anti-example: asking it to reply `OK` / `done`. Such an answer **takes the same value whether it
really ran or merely replied** — it proves something is answering on its behalf, not that it executed.

Good examples (each requires a value from **its own machine**):

- `git rev-parse --short HEAD` (the checkout's current commit)
- `hostname` plus the current working directory
- the line count of a file only it has locally

**And say "do not start any work" in the probe** — otherwise you hand it a task while diagnosing
it, and you can no longer tell answering from working.

## Suggested order

1. `anet node ls` / `anet info <alias>` for `status` and heartbeat — **use these only to rule out
   "never registered", never to judge liveness**;
2. send one probe as above;
3. **wait for a reply.** If none comes, treat it as unavailable and record exactly that — do not
   write "probably busy", which turns an unknown into a specific claim.

## What this page does not answer

It does not say *why* something broke, and it offers no self-healing. There is currently **no**
built-in crash recovery at the node level (the Hub has a watchdog; nodes do not) — see
[issue #534](https://github.com/sleep2agi/agent-network/issues/534). The "still reports idle after
failing" row is [issue #811](https://github.com/sleep2agi/agent-network/issues/811).
