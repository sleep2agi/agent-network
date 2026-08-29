# Restarting a Codex TUI Node Safely: Keep the Session, Never Regress the Rollout

> Restarting a Codex TUI co-presence node carelessly loses its original session, shrinks the rollout record, or accidentally resumes a paused task. This checklist guarantees you get *the same node back*, not a new node that merely shares its name.

A Codex TUI co-presence node has three parts: the **app-server** (backend session process), the **TUI** (terminal UI), and the **bridge** (the link to CommHub). Their working directory, session ID, and rollout file must be identical after the restart. **"All three processes came up" is not "recovery succeeded"** — a node started in the wrong directory, attached to the wrong session, or with an overwritten rollout has every process yet is no longer the original.

## Before restarting: record the current state per node

For each node you restart (record it per alias, don't rely on memory), write down five things first:

| What to record | Why |
|----------------|-----|
| Expected **working directory** (cwd) | The TUI, the bridge, and CommHub's project_dir must all align to it |
| **Full session / thread ID** | Recovery must be exact; keep the ID complete, never a short prefix |
| **Rollout file** absolute path + current byte size | After restart the rollout must not shrink or be replaced with a new file |
| **Goal pause state** | Must be preserved after restart; must not be rewritten by an auto-resume |
| Full **command line** of app-server / TUI / bridge | Relaunch them verbatim; any drifted argument starts a *different* node |

## Six hard rules while recovering

1. **Exact session, no guessing.** Recover with the **full** session ID. Never use "the most recent session" or a short-prefix match — a short prefix silently matches a different session; the process still starts, but the content belongs to someone else.
2. **Credentials are backed up, never leaked.** Back up the auth credential file first, then `chmod 0600` the copy. Credentials must **never** appear in command-line arguments, logs, or receipts — arguments land in shell history and `ps` output.
3. **Give the TUI an explicit working directory.** Pass `-C <node working dir>` explicitly when starting the TUI; don't rely on "whatever directory I'm in".
4. **`cd` into the working directory before starting the bridge.** CommHub's project_dir, the TUI's `-C`, and the node config must all agree — a mismatch delivers returning messages into the wrong session context.
5. **Never regress the rollout.** Before resuming, check the rollout's size and content; after restart it may only stay the same or grow. If it shrinks or is replaced by a new file, you attached to the wrong session or started a fresh one — stop immediately.
6. **Preserve the goal state.** A goal that was paused stays paused; any "auto-resume" must be paused **immediately**. Recover the node cleanly and pass acceptance first, then let a human decide whether to continue the original task.

## Acceptance: recovery counts only when all six pass

- [ ] **Identity usable** — verify with a side-effect-free login probe with a fixed short reply (below); don't dispatch a real task
- [ ] **Exact session recovered** — the full session ID matches your record
- [ ] **Rollout not regressed** — byte size ≥ pre-restart, content not replaced
- [ ] **Working directory correct** — cwd == the TUI's `-C` == CommHub project_dir == node config
- [ ] **Original task still paused** — no unexpected goal running
- [ ] **Three processes online** — app-server / TUI / bridge

🔴 **Any mismatch: STOP immediately, fix it, then rerun the full acceptance.** "The process exists" is one of the six items, not the conclusion.

## How to send the login probe

To verify "identity works, session is there", use a **fixed, side-effect-free** probe — having the node reply with an agreed short string is enough. Don't use a real task as the probe: a real task writes the rollout, changes state, and may trigger a goal — the act of verifying would destroy the very thing you're verifying.

## Related

- [Is This Node Alive?](/en/troubleshooting/is-this-node-alive)
- [Remote Node CLI Login](/en/troubleshooting/remote-node-cli-login)
- [Codex TUI Co-presence](/en/guide/codex-copresence)
