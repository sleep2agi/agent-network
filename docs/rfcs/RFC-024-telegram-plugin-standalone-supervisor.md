# RFC-024 — Telegram plugin standalone supervisor (agent-node)

**Status**: Design — awaiting 通信龙 review, then Vincent arch-decision
**Author**: 通信工程马
**Date**: 2026-06-23
**Drives from**: #246 incident (`A站负责人` telegram poller died ~3 times today, ~20 min cadence — same class hit `TM负责人` 6-20)
**Sibling**: read-only root-cause audit (commhub conversation 8061f89d / 077ac314)

---

## 1. Problem statement

The official Anthropic telegram plugin (`claude-plugins-official/telegram@0.0.6`) is spawned by Claude Code's MCP machinery when an agent declares `--channels plugin:telegram@claude-plugins-official`. The plugin has an **orphan watchdog** that self-exits when its stdin pipe is destroyed or its parent reparents:

```ts
const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()  // → process.exit(0)
}, 5000).unref()
```

Claude Code rotates/disconnects MCP stdio servers on what appears to be an internal cadence (~15–20 min on the affected node, possibly idle-driven). When that happens the plugin's stdin closes, the watchdog fires within 5 s, and the poller exits gracefully. Claude does not reliably auto-respawn the plugin after rotation, so `bot.pid` stays absent and inbound Telegram traffic silently stops reaching the agent.

The decisive evidence: a different bot owned by Vincent (`~/.claude/channels/telegram-vincent`) has been running **13 days uninterrupted** because it is spawned standalone (`bun run --cwd <plugin path> start` from a long-lived parent), not via Claude's `--channels` MCP path. Same plugin binary, same `server.ts`, opposite lifecycle — the differentiator is the parent process.

Operationally this manifests as Vincent's primary news channel cutting out every ~20 min on an active agent. Manual restarts work but are not sustainable.

## 2. Proposed architecture: `agent-node` owns the plugin lifecycle

The fix is to take the plugin out of Claude's MCP lifecycle and put it under `agent-node`'s direct supervision, with `agent-node` mediating both directions of the data flow.

### 2.1 Process topology

**Before** (current — affected by orphan watchdog):

```
                                      ┌─ telegram getUpdates  → inbox/<id>.json
                                      │                          ↑ Claude reads
                                      │                            via MCP stdio
agent-node ─→ claude (stdio MCP) ─→ telegram-plugin (server.ts)
                                      ↑
                                      │ Claude rotates → stdin closes
                                      │ → orphan watchdog fires (5 s)
                                      │ → plugin self-exits
```

**After** (proposed — supervisor owns the plugin):

```
                                      ┌─ telegram getUpdates  → inbox/<id>.json
                                      │                          ↑ agent-node
                                      │                            tails inbox
                                      │                            and forwards
agent-node ─┬─ claude (stdio MCP)     │
            │                          │
            └─ telegram-plugin ─ (stdin pipe kept open by agent-node)
               (server.ts)                   parent = agent-node, never changes
                                            → orphan watchdog never fires
```

Key invariants:

- **Single Telegram consumer** — Telegram's Bot API allows exactly one `getUpdates` consumer per token. The supervisor MUST be the *only* spawner; Claude's `--channels plugin:telegram@...` declaration MUST be removed from the node's config to avoid a 409 Conflict.
- **Long-lived stdin pipe** — `agent-node` keeps the plugin's stdin open for the lifetime of the agent-node process, defeating the orphan watchdog the same way Vincent's standalone bot does.
- **Bidirectional bridge** — both directions of message flow are mediated by `agent-node`, since Claude no longer talks to the plugin directly.

### 2.2 Outbound bridge — agent → Telegram

Claude agents currently call `telegram_send` (and friends — `telegram_send_image`, `telegram_react`, etc.) as MCP tools exposed by the plugin. After the move, the plugin is still the only thing that knows how to talk to the Bot API, but Claude no longer has a stdio MCP connection to it.

Two options:

- **A — `agent-node` is the plugin's MCP client + re-exposer**. `agent-node` opens its own stdio MCP connection to the plugin (it spawned it, it owns the pipe), enumerates the plugin's tools at startup, and re-exposes them through the `commhub` MCP server it already runs for Claude. Agent calls `commhub_telegram_send(text, target)` → `commhub` forwards to plugin → plugin sends → reply propagates back through the same stack.
- **B — local HTTP bridge**. `agent-node` opens a UNIX socket the plugin listens on (requires plugin upstream change, out of scope).

**Recommend A.** It reuses the commhub MCP plumbing the agent already has (one new MCP server registration), no plugin upstream change, agent-side prompt changes are limited to "call `commhub_telegram_*` instead of `telegram_*`."

### 2.3 Inbound bridge — Telegram → agent

The plugin writes incoming messages to `<STATE_DIR>/inbox/<id>.json`. Today Claude's `--channels plugin:telegram` reader watches this directory and injects messages directly into the active session (the "messages from plugin:telegram inject directly in this session" banner). With `--channels` removed, that injection stops.

`agent-node` takes over the inbox tail:

1. `fs.watch(STATE_DIR/inbox)` for `create` events.
2. On a new `<id>.json`, read + parse, then push a `new_message` event via commhub SSE to the agent's own alias channel with a body containing `{from_telegram: <user>, content: <text>, message_id: <id>, attachments: [...]}`. The agent's commhub MCP `get_inbox` returns the same structured shape so polling clients also see it.
3. Atomic-delete (rename + unlink) the inbox file after successful enqueue to commhub so the plugin's inbox doesn't grow unbounded. (Plugin's own inbox cleanup behavior to be verified — see Open Question 3.)

The agent's existing tool surface for handling incoming commhub messages (`new_message` SSE event handler) then routes the telegram message into the conversation. This mirrors how telegram messages currently arrive — same "user message arriving" UX — just plumbed through commhub instead of through Claude's MCP injection.

## 3. Opt-in per-node + migration path

This is an opt-in feature. Don't disturb the many nodes whose telegram-via-MCP currently happens to work (or which don't use telegram at all).

### 3.1 Schema

Add to `config.json` (per-node):

```json
{
  "telegram": {
    "standalone": true,
    "state_dir": "~/.claude/channels/telegram-insight"
  }
}
```

- `standalone: false` (default, omittable) → existing behavior: Claude `--channels plugin:telegram@...` spawns plugin via MCP. Pre-#246 reliability.
- `standalone: true` → agent-node spawns + supervises plugin, owns lifecycle, exposes bridge.

### 3.2 Migration sequence (for an affected node)

1. operator edits `config.json` — adds `telegram.standalone: true` + sets `state_dir`.
2. operator runs `anet node stop && anet node start` once (standard restart recipe).
3. on start, `agent-node` reads `telegram.standalone`:
   - if `true`: omits `--channels plugin:telegram@...` from the spawned `claude` command, spawns plugin directly, opens stdio MCP client, registers bridge tools on its commhub MCP, tails inbox.
   - if `false`/missing: existing path, no change.
4. `anet doctor` flags telegram-channel'd nodes still on `standalone:false` after 0.8.7-preview.X has shipped, with a one-line "consider standalone mode for SLA, see RFC-024" advisory. Not a hard error.

### 3.3 What unaffected nodes see

Zero change. The default code path is `standalone: false === undefined`. Existing Vincent-personal-bot setup (already standalone-style via shell) keeps working untouched.

## 4. Reliability — restart-on-exit + thrash cap

`agent-node` watches the plugin child. On exit:

- log the exit code + signal + stderr tail
- record the death in a short-lived in-memory ring buffer (per `state_dir`)
- if fewer than 5 deaths in the last 60 s → re-spawn after a 1 s backoff
- if ≥ 5 deaths in the last 60 s → stop trying, report `status="failed"` to commhub with the death history, and surface in `anet channel status` / `anet doctor` red. Manual `anet node restart` resets the counter.

The thrash cap prevents a misconfigured node (invalid token, revoked permission, etc.) from spinning up a fork bomb of failing plugin processes. The 5-in-60 s threshold gives the watchdog room to recover from transient blips without going silent.

In addition, every successful boot writes `<state_dir>/health.json` with `{boot_at, pid, ppid, restarts_total, last_exit_code}`, surfaced by `anet channel status <node>` — same shape proposed in the #246 watchdog scope so this work composes cleanly with the existing health-visibility plan.

## 5. Threat model & open questions

### 5.1 Threats

| # | Threat | Mitigation |
|---|---|---|
| T1 | Two consumers of the same telegram bot token → 409 Conflict | Hard invariant: `standalone:true` REMOVES `--channels plugin:telegram@...`. Plugin's existing stale-pid kill (`SIGTERM` to old pid) on boot is a second-line defense. |
| T2 | Supervisor restart loop pegs CPU | 5-in-60 s cap → cold-fail and surface, don't keep retrying. |
| T3 | Bridge tools impersonation — a different agent on the network discovers `commhub_telegram_send` and uses it for the wrong recipient | Token + access.json + allowlist still gate at the plugin layer (unchanged); bridge is transparent. Bridge calls must propagate the calling agent's identity so plugin can log who sent. |
| T4 | Inbox event lost if commhub is briefly down when agent-node tries to push | Inbox file isn't deleted until commhub ACKs the push (per §2.3 step 3). Restart of agent-node redrives the queue. |
| T5 | Plugin upstream changes (≥0.0.7) break the bridge | Pin a known-good plugin version per `standalone:true` node; bump on review. |

### 5.2 Open questions (decision points before impl)

1. **Plugin tool surface stability** — will calling `commhub_telegram_send` instead of `telegram_send` from the agent require a system-prompt change, or does the LLM figure it out from MCP tool descriptions alone? Quick test: name the bridged tools `telegram_send` (no prefix) in commhub's namespace so the prompt is unchanged. Trade-off: name collision risk inside commhub MCP.
2. **Pairing flow** — `/telegram:access pair <code>` today is a Claude slash command that talks to the plugin via Claude's MCP injection. With `--channels` removed, does this command still work? If not, pairing has to either (a) move to an `anet channel pair` CLI subcommand, or (b) be bridged through commhub too. Need to read the slash command implementation to decide.
3. **Plugin inbox cleanup ownership** — verify whether the plugin deletes its own inbox files after a successful read by its MCP consumer, or whether Claude does. If plugin does, supervisor must mimic the "read complete" signal; if Claude does, supervisor takes it over.
4. **Migration of `telegram-vincent` (already standalone via shell)** — should this node be folded into the same supervisor for symmetry, or left alone? Leaving it alone preserves the 13-day uptime; folding it in unifies the operating story. Recommend leave alone unless Vincent explicitly wants the unified model.

## 6. Implementation order

**Phase 1 — supervisor + restart-on-exit** (~2-3 h)
- `agent-node/src/telegram-supervisor.ts` (new): spawn plugin from `state_dir`, hold stdin, log exit, restart with cap.
- Wire into `agent-node` startup when `config.telegram.standalone === true`.
- Strip `--channels plugin:telegram@...` from claude args when standalone.
- Verify: A站-like config in Docker, kill the plugin manually, confirm respawn within 1 s, confirm `bot.pid` reappears.

**Phase 2 — outbound bridge (commhub MCP re-export)** (~2-3 h)
- agent-node opens stdio MCP client to plugin, enumerates tools.
- Re-register each plugin tool under the agent's commhub MCP server with a `telegram_*` namespace.
- Verify: send a Telegram message via `commhub_send_task` → agent → `telegram_send` bridge → real Telegram delivery.

**Phase 3 — inbound bridge (inbox tail → commhub event)** (~2-3 h)
- `fs.watch(STATE_DIR/inbox)`, parse + push `new_message` to commhub SSE for own alias.
- Atomic-delete on push ACK.
- Verify: real Vincent → bot → agent sees the message in turn, end-to-end.

**Phase 4 — `anet doctor` advisory + `anet channel status` health** (~1-2 h)
- Read `health.json` (per §4); flag stale.
- Doctor advisory for nodes still on `standalone:false` with telegram channels.

**Phase 5 — Pairing-flow migration if needed** (~2-4 h, gated on Open Q2)
- Either implement `anet channel pair` CLI or bridge `/telegram:access` through commhub.

**Total**: ~10–14 h spread over 1–2 evenings (Phase 1–4); Phase 5 dependent on Open Q2 answer.

## 7. Non-goals / out-of-scope

- Not changing the plugin itself (no upstream PR).
- Not unifying `telegram-vincent` (Open Q4) unless Vincent asks.
- Not adding new telegram features (groups, broadcasts, etc.) — scope is reliability + plumbing.
- Not changing how SSE replies work (that's #247).

---

Author-Agent: 通信工程马
