# agent-node 2.5.0-preview.169

Since `.168`: **hot model switching recovers from a transient disconnect**, and a failed hot switch
now degrades to a restart instead of rejecting the change.

## Behaviour

- **The "alive" predicate for a shared OpenCode v2 session is now time-windowed, not sticky.**
  A single `ECONNRESET` / `ECONNREFUSED` / `EPIPE` used to set a flag that nothing ever cleared, so
  `isRunning` stayed false until the node process restarted — and every later model switch silently
  degraded to a full restart. Now the flag is a timestamp: within 30 s the session counts as not
  alive (avoid hammering a just-broken server), after that it counts as alive again and the next
  switch is attempted for real.
  - `openCodeV2SessionAlive({closed, disconnectedAt, now, child, graceMs})` is a pure function with
    6 unit tests, including "outside the window it must return alive" and "graceMs is overridable".
- **A failed hot switch no longer acks `rejected`.**
  Both failure branches (session not usable at apply time, and `setSelectedModel` throwing) used to
  ack `rejected` and return — the model change **never happened**, while the user had asked for it.
  They now set `mode = "restart"`, which is what the same code block already documented as the
  intended behaviour for "session not running". Cost: one restart; benefit: the change takes effect.
  The success path ("switch + write config + ack applied") is guarded by `if (hotUsable)` so a
  degraded run cannot ack an `applied` that did not happen.
  - Log lines now name the branch and the inputs (`session=running|not-running`,
    `setSelectedModel=present|missing`, and `errName/errCode` on failure) instead of one blanket
    "the co-presence session is not running".

## What this does **not** claim

There is still no reading for "does `POST /api/session/<id>/model` succeed on a shared server with
no TUI attached". This release does not assert that hot switching will succeed; it only stops the
node from *predicting* failure from an unreliable flag, and makes the fallback guaranteed.

## Verification

- `agent-node` per-file suite: **273 files, 273 pass, 0 fail** (the runner previously discovered only
  179 of them — `src/**` without globstar matches one directory level; it now uses `find`).
- `config-apply` 114 pass; `opencode-copresence` 27 files green.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.169
```

## Upgrade

```bash
# paired with the CLI release that pins it
npm i -g @sleep2agi/agent-network@2.3.0-preview.203 @sleep2agi/agent-node@2.5.0-preview.169
```
