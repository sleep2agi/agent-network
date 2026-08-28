# agent-node v2.5.0-preview.41 — owned BTW executor

**Channel:** `preview` only

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.41
```

Codex co-presence keeps its human TUI bridge unchanged and starts a separate
package-owned app-server for native BTW. The executor must resume the exact
source thread; a missing process identity or fallback thread fails closed.

## Upgrade

Install the exact version and restart the node. Enable `flags.sideThreads` only
after the node token has an authenticated owner binding. Verify the Hub status
snapshot reports `side_thread_capability.supported=true` before using BTW.

Docker verification: agent-node build PASS; SideThread and Codex focused suite
146/146 PASS; owned-session selection 4/4 PASS.
