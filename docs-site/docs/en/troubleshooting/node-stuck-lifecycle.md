# A node is stuck in stopping / starting, or an action did nothing after a network blip

::: warning This page describes behavior that needs these two versions
Automatic compensation requires **`@sleep2agi/agent-node` ≥ `2.5.0-preview.49`** and
**`@sleep2agi/commhub-server` ≥ `0.9.0-preview.40`**.

Check yours with `anet -v`. **On older versions the automatic recovery described below
does not happen** — see the last section instead.
:::

## Symptoms

After stopping / starting / deleting a **daemon-managed node** from the Dashboard or CLI:

- the node sits in `stopping` or `starting` and never moves on; or
- the action appears to do **nothing at all** — and neither side reports an error.

Typical trigger: the daemon happened to be **offline at the moment the action was sent**
(daemon restart, machine sleep, network blip, the gap during an SSE reconnect).

## First: wait for one reconnect

The hub delivers the request to the daemon as a one-shot push. **If the daemon is offline
at that moment, that push is gone** — which is why this looks less like "the action
failed" and more like "the action never happened".

**On the versions above, this repairs itself**: every time the daemon reconnects to the
hub, it pulls back its own **unfinished requests and replays them**.

> **So the first step is to wait for that reconnect, not to restart anything by hand.**
> Usually seconds to a minute.
> Nodes stuck in `starting` also have a 60-second backstop that clears the stale
> intermediate state so the action can be re-issued.

## Confirming it actually recovered

Look at the log **on the daemon's own machine** — not the hub's, not the Dashboard's:

```bash
tail -f ~/daemon-<name>.log
```

After the reconnect you should see it pick up and run the request it missed, and the node
leaves `stopping` / `starting`.

🔴 **Do not treat the Dashboard state as the only criterion** — the defining trait of this
class of problem is that **neither side reports an error** and the UI looks fine.

## Still stuck

In this order:

1. **Confirm the daemon is really connected.** See [the daemon page](/en/deploy/daemon#hub-prereqs):
   `anet daemon list` only reads local config — **being listed there does not mean the hub
   knows about it**. Look for the hub-side `SSE ←` / `report_status` heartbeat.
2. **Confirm your versions** (the two at the top of this page). Builds older than that have
   **no reconnect-compensation path**: stuck stays stuck, and that is the case where
   restarting the daemon by hand is actually the right move.
3. If it still will not move, open an
   [issue](https://github.com/sleep2agi/agent-network/issues) with the daemon's local log
   for that period.
