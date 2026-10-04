# agent-node 2.5.0-preview.101

Since `.100` (release merge `9d6e4f4b`), `agent-node/` has one change:

| Commit | PR | What |
|---|---|---|
| 42fb1e4b | #2342 | codex app-server watchdog: a declined restart and a down first probe are reported at once (watchdog CI flake) |

## Behaviour

- **The watchdog's "not restarting" verdict reaches the Hub at once** (#2342). A `; not restarting: …` reason now has its own phase (`blocked`), so it changes the health signature and is reported immediately. Before, if the first failed probe went out with the raw ws error, the verdict on the next probe had the same signature (`ok=false`, phase `-`) and was never reported; the Hub could keep the raw reason for 40 s.
- **A down first probe of the app-server is reported, but only after the bridge has opened a session on it** (`codexAppServerEverOpened`, an explicit gate, not a timer). Before, `lastSig === null` swallowed it, so an app-server that died before the first probe while the watchdog was already restarting it never showed `restarting` on the Hub.
- **No Windows regression.** Start-up, a TUI that isn't open yet, and a TUI that can't be probed (Windows: no tmux, always `session-missing`) stay quiet, as on `.100`. An earlier revision of #2342 reported any down first tick and turned the Windows native smoke red with 409 `node_degraded`; the merged version is gated and pinned by a unit test.
- No config changes. No dependency changes.

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.101
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.134 @sleep2agi/agent-node@2.5.0-preview.101
```

Nodes must be restarted on the new build for the change to take effect.
- 🔴 **Upgrade both packages together** (`agent-network@2.3.0-preview.134 ↔ agent-node@2.5.0-preview.101`): anet validates the exact paired agent-node version for codex co-presence and `opencode-cli`.
- Publish order: agent-node `.101` first, then agent-network `.134`, both from the same merge commit.

## Evidence

- #2342, Docker under load (`--cpus 2`, busy-loop stressor, PR/main alternating): `test-codex-appserver-watchdog` full suite main 1/6 pass → this change 5/5 pass; hung scenario 6/6. With the `noteExit()` call removed (deterministic repro of the CI race): main 2/2 fail, this change 2/2 pass. `check-mutation-pins` GREEN.

## promote 时的 must_contain

`"version": "2.5.0-preview.101"`
