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
| `status = offline` | **moderate (not conclusive)** | Carries more than `idle`, but it is **not enough to conclude the node is dead**. At least one path marks a live node offline — see below. |
| `status = blocked` | **useless (weaker than `idle`)** | Measured: a `blocked` node answered a dispatched task in **22 seconds**. `blocked` means **there is no exit**, not "it stopped" — see below. |
| 🔴 **It answered you** | **Hard evidence** | The only signal that does not depend on the observer's vantage point. |

**So: only the last row counts.** All four rows above can be green on a dead node; all four can
look dim on a node that simply has not been spoken to.

## `status = offline` is not conclusive either

Observed once (2026-08-19, in a container, [#1027](https://github.com/sleep2agi/agent-network/issues/1027)):
a node that was **alive, registered with CommHub, and SSE-connected** produced this from `anet node stop`:

    [anet] "<alias>" is not running locally (server notified offline)

**and it exited 0** — while its two processes were still there nine minutes later.

Mechanism: that node was not started under tmux (the test started it as a bare background
process), and `anet node stop` decides "is it running locally" by tmux session, so it could not
see it — and then **told the server to mark it offline**.

So: **a node shown as offline in the Hub may be working normally.**

⚠️ This was seen **once**; a later full run of the same path did not reproduce it
(2–3 containers were running concurrently that time; whether that is the cause is unproven).
It is written here not because it is common, but because **`offline` is not proof that a node is dead** —
as with every other row, the verdict still has to come from the last one.

## `status = blocked` does not even mean "it stopped"

Measured on the production hub, 2026-08-31:

| | |
| --- | --- |
| Node | an `agent-node:grok-build-cli` |
| Roster status | `blocked` |
| Heartbeat | 4 minutes ago |
| Dispatch a task -> it replies | **22 seconds** |

[#1548](https://github.com/sleep2agi/agent-network/issues/1548) has a second case: the node that builds the
installers showed `blocked` for **8.3 hours** while being alive the whole time. It has no stand-in, so
concluding "that lane is down" from the status field was simply wrong.

**Mechanism**: the only path that moves `status` off `blocked` is `report_completion`
(`server/src/tools.ts`). Once an agent has reported `blocked` via `report_status` and then does all its
work through `send_task` / terminal `commhub_reply`, it stays `blocked` **forever**.

Do **not** patch around this by showing "how long has it been blocked": the roster has **no**
"when did it become blocked" field. `updated_at` is refreshed by the heartbeat — the long-blocked node
above had an `updated_at` of **4 minutes ago**. Using it as a blocked-duration prints "4 minutes ago"
for a node that has been stuck for hours, which is **worse than showing nothing**.

**As with every other row on this page, only the last row is conclusive.**

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

## The stdout `✅` from `anet node start` doesn't count either

`exit 0` plus a printed `✅ node "…" started detached (tmux session live)` does **not** mean the node came up.
Versions predating [#895](https://github.com/sleep2agi/agent-network/pull/895) (fixed as of `2.3.0-preview.40`) can lie on the detached path.

**Real check**: `tmux has-session -t "=<alias>"` returns 0 — **the `=` is required**; a bare alias is a prefix match and can go green on the wrong session.

For bulk launches use `anet project up`; its exit code is trustworthy since [#896](https://github.com/sleep2agi/agent-network/pull/896) (also `2.3.0-preview.40`).

## A node is stuck in stopping / starting, or an action did nothing {#stuck-lifecycle}

::: warning The automatic recovery below needs these two versions
Automatic compensation requires **`@sleep2agi/agent-node` ≥ `2.5.0-preview.49`** and
**`@sleep2agi/commhub-server` ≥ `0.9.0-preview.40`**.

Check yours with `anet -v`. **On older versions the automatic recovery described below
does not happen** — see the last part of this section instead.
:::

### Symptoms

After stopping / starting / deleting a **daemon-managed node** from the Dashboard or CLI:

- the node sits in `stopping` or `starting` and never moves on; or
- the action appears to do **nothing at all** — and neither side reports an error.

Typical trigger: the daemon happened to be **offline at the moment the action was sent**
(daemon restart, machine sleep, network blip, the gap during an SSE reconnect).

### First: wait for one reconnect

The hub delivers the request to the daemon as a one-shot push. **If the daemon is offline
at that moment, that push is gone** — which is why this looks less like "the action
failed" and more like "the action never happened".

**On the versions above, this repairs itself**: every time the daemon reconnects to the
hub, it pulls back its own **unfinished requests and replays them**.

> **So the first step is to wait for that reconnect, not to restart anything by hand.**
> Usually seconds to a minute.
> Nodes stuck in `starting` also have a 60-second backstop that clears the stale
> intermediate state so the action can be re-issued.

### Confirming it actually recovered

Look at the log **on the daemon's own machine** — not the hub's, not the Dashboard's:

```bash
tail -f ~/daemon-<name>.log
```

After the reconnect you should see it pick up and run the request it missed, and the node
leaves `stopping` / `starting`.

🔴 **Do not treat the Dashboard state as the only criterion** — the defining trait of this
class of problem is that **neither side reports an error** and the UI looks fine.

### Still stuck

In this order:

1. **Confirm the daemon is really connected.** See [the daemon page](/en/deploy/daemon#hub-prereqs):
   `anet daemon list` only reads local config — **being listed there does not mean the hub
   knows about it**. Look for the hub-side `SSE ←` / `report_status` heartbeat.
2. **Confirm your versions** (the two at the start of this section). Builds older than that have
   **no reconnect-compensation path**: stuck stays stuck, and that is the case where
   restarting the daemon by hand is actually the right move.
3. If it still will not move, open an
   [issue](https://github.com/sleep2agi/agent-network/issues) with the daemon's local log
   for that period.
