# Grok Nodes

Agent Network runs Grok in two kinds of node:

| Mode | runtime | Status | Good for |
|---|---|---|---|
| **ACP (recommended, default)** | `grok-build-acp` | stable | unattended nodes that take network tasks reliably |
| Co-presence TUI | `grok-build-cli` | **experimental** | a human and network tasks sharing one Grok TUI |

Unless you have a specific reason, use `grok-build-acp`. The co-presence TUI is for when a person wants to sit at the terminal, watch and type alongside the agent, and it has the known limits listed below.

## Recommended: `grok-build-acp` {#acp}

The node spawns the local `grok agent stdio` and runs network tasks over the Agent Client Protocol, reusing this machine's Grok login. It is headless and **cannot be attached to a TUI**.

Prerequisites:

- Grok Build CLI installed and `grok login` completed on this machine
- `GROK_CODE_XAI_API_KEY` set in the environment
- a running Hub you are logged in to (see [Getting Started](/en/guide/getting-started))

```bash
grok login
anet node create my-grok --runtime grok-build-acp
anet node start my-grok
```

For the long-task timeout (5 minutes by default), per-node working directories and other details, see [Runtimes → grok-build-acp](/en/guide/runtimes#grok-build-acp).

**Project skills**: ACP nodes load `.agents/skills/<name>/SKILL.md` from the project root, but the skill list is frozen when the grok session is created. After adding or changing a skill: stop the node → delete `grokSession` (and `session`) from `.anet/nodes/<name>/config.json` → start the node.

**Egress through a proxy**: the ACP path passes your shell's `HTTP(S)_PROXY` to grok unchanged. If the corporate proxy cannot reach `*.x.ai` / `*.grok.com`, ACP initialize never returns and stderr only shows `Settings fetch failed`. Set `NO_PROXY="x.ai,.x.ai,grok.com,.grok.com,localhost,127.0.0.1"` and route those domains directly or through a host-side relay (see [Restricted egress](#egress) below). CIDRs in `NO_PROXY` do not apply to literal IPs; add the literals too.

## Experimental: co-presence TUI (`grok-build-cli`) {#copresence}

::: warning Experimental, with known limits
- While a human has text in the TUI input box, network tasks only queue and eventually time out.
- Co-presence accepts only **verified grok builds** (currently `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`; the error message lists the authoritative set). If grok self-updates outside that list, the node fails on its **next restart**; the error prints a `GROK_BINARY=<verified older build> anet node start <node>` recovery command.
- The co-presence TUI does not load project skills and cannot enable always-approve.
- It ships in the published npm packages (both the `latest` and `preview` channels; the "Grok co-presence" section of `anet --help` lists it), but it is not the default recommendation.
:::

`grok-build-cli` makes one node own the single real Grok TUI. You enter the same screen from another terminal with `anet grok attach`; CommHub network tasks queue into the same session. Human input has priority; network tasks run FIFO.

### Prerequisites

- Linux, macOS or WSL, with Node.js, Bun and the native `node-pty` dependencies
- Grok Build CLI installed and logged in, with `grok --version` on the verified list
- npm-installed `anet` and `agent-node` (`anet --help` shows `grok-build-cli` and `anet grok attach`); build from source only to run unreleased changes

::: details Build from source (developers)
```bash
cd agent-node && bun install && npm run build
cd ../agent-network && bun install && npm run build && cd ..

export ANET_SOURCE=/absolute/path/to/agent-network
export ANET_AGENT_NODE_BIN="$ANET_SOURCE/agent-node/dist/cli.js"
anet() { bun "$ANET_SOURCE/agent-network/dist/bin/cli.js" "$@"; }
```

If you see `Installed agent-node does not support grok-build-cli`, the agent-node you are calling does not support co-presence, or `ANET_AGENT_NODE_BIN` points to the wrong place; set it to the absolute path of `dist/cli.js`.
:::

### Start and attach

```bash
# Terminal 1: create the node and keep it running
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo
```

This line means the TUI is ready:

```text
[grok-copresence] ...; attach with anet grok attach grok-demo
```

```bash
# Terminal 2: from the node's working directory, attach to the same TUI
anet grok attach grok-demo
```

- `Ctrl-]` detaches only this terminal; it does not stop the node or the Grok session. Only one human terminal may be attached at a time.
- Run `anet grok attach` from the node's working directory, in an interactive terminal (no pipes or redirection).
- Network tasks appear in the TUI as `[Agent Network/from=<sender>/task=<task ID>] <message>`. Ordinary conversation is not sent to the network; only an explicit delegation (for example `send reviewer a task: check the current changes`) dispatches one.
- Permission prompts are handled only by the attached human: Enter allows once, `Ctrl-C` denies. The runtime never picks "always allow" for you.

### Stop, resume and switch models

```bash
anet node stop grok-demo
anet node start grok-demo      # resumes the same grokCliSession
```

The runtime never silently falls back to headless and never guesses another session. If the process crashes during a network task, that task fails and is not replayed automatically.

Two safe ways to switch models:

- Type `/model <model name>` in the TUI (agent-node ≥ `2.5.0-preview.45`): a clean single-argument `/model` is executed on your behalf and the result is shown in the TUI; other line-leading slash commands are blocked by default.
- From another terminal, `anet grok model <node> <model name>`: works on any version, even while attached.

If you want a fresh headless Grok process per task, the legacy headless mode is `anet node create grok-headless --runtime grok-build-cli --grok-headless` (cannot be attached).

### The roster shows `blocked`

With agent-node ≥ `2.5.0-preview.57`, `blocked` means something is wrong with the TUI child process, composer readiness or `attach.sock`, and is worth investigating. Older versions always show `blocked` on grok 1.0.5 (which by design does not create `leader.sock`); there, trust the node log instead: `injected network task` / `processTask returned` mean the runtime is fine.

Restart the node after upgrading agent-node; liveness is computed inside the long-running process. Check `grok --version` before restarting: if the `grok` on `PATH` is no longer on the verified list, the node is refused on restart even though running nodes look fine. Older binaries are usually still in `~/.grok/downloads/`; start with `GROK_BINARY=~/.grok/downloads/grok-<verified version>-<platform> anet node start <name>`.

### Restricted egress {#egress}

The co-presence runtime gives the grok child process a fixed environment allowlist and strips `HTTP(S)_PROXY`, so setting proxy variables on the node does nothing. What works is a host-side setup: point `auth.x.ai`, `api.x.ai`, `cli-chat-proxy.grok.com` and `code.grok.com` at this machine in `/etc/hosts`, run a local SNI-forwarding relay on 443, and send it out through the corporate proxy. First verify the relay with `curl --connect-to auth.x.ai:443:127.0.0.1:443 https://auth.x.ai/.well-known/openid-configuration`, then check that the node answers a Hub probe; the first passing does not mean the second will. `GROK_OIDC_ISSUER` overrides an enterprise IdP; it is not a proxy.

### FAQ

**Version too old or mismatched**: install a build from the verified list and start again; do not bypass the version check. Keep grok's `auto_update` from moving it off the list: pin a verified build with `GROK_BINARY`, or turn off `auto_update` in the node's private `GROK_HOME`.

**An existing plain grok session cannot become co-presence directly**: the co-presence runtime enforces a sandbox profile and grok refuses to resume across profiles (`cannot resume this session under sandbox profile … it was created with 'off'`). To port it: copy the whole session directory `sessions/<cwd-key>/<old-id>/` to a new UUID and delete `*.lock`; in the clone's `summary.json`, change `sandbox_profile` from `"off"` to the node's current workspace profile (like `anet-<hash>-workspace`); point `grokCliSession` in the node config at the new id and restart. The original session is untouched.

**`cannot resume missing session <id>`**: the session directory that `grokCliSession` points to is gone. The runtime deliberately does not create a new one (that would silently drop history). Delete `grokCliSession` from `.anet/nodes/<name>/config.json` and run `anet node start`; it creates a session and writes the new id back.

**Five 0-byte files in the working directory** (`.grok` `.claude` `.cursor` `.mcp.json` `.envrc`): grok plants these read-deny placeholders at startup, and `anet node stop` reclaims only these five files with mode `0444`. On some hosts grok 1.0.5 creates them as `0666`, so every stop reports `refuses post-stop project placeholder` and the next start reports `expected a real directory`. Fix: after stopping, run `chmod 0444 .grok .claude .cursor .mcp.json .envrc` and start again (agent-node ≥ `2.5.0-preview.70` prints this command in the error).

**`bwrap exec failed` / a hint to `apt install -y bubblewrap`**: on dnf/yum systems install the `bubblewrap` rpm (`sudo dnf install -y bubblewrap`).

**`<hub> did not answer /health within 2000ms` at startup**: happens when reaching the Hub over the public internet. From `2.3.0-preview.92`, non-loopback Hubs get 10 seconds by default, overridable with `ANET_HUB_HEALTH_TIMEOUT_MS=<1000–60000>`; on older versions, upgrade.

**The TUI stops at `Login with Grok`**: co-presence nodes reuse this machine's `grok login` state (`~/.grok/`). Login needs direct access to `auth.x.ai` / `api.x.ai` / `grok.com`. Do not copy `~/.grok/auth.json` from another machine; the login is bound to the machine and account.

**Can I enable always-approve?** No. Any task sent over the network goes straight into this session, so approvals stay with the person at the TUI; `flags.dangerouslySkipPermissions: true` refuses to start. If grok should edit files and run commands on its own, create a separate `grok-build-acp` node.

## Related

- [Node Runtimes](/en/guide/runtimes)
- [Codex TUI Co-presence](/en/guide/codex-copresence)
- [Full Grok Build runtime notes](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md) (implementation, security boundary and Docker verification)
