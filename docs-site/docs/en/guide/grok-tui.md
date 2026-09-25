# Grok Co-presence TUI (Preview)

::: danger Preview — for a stable Grok node use `grok-build-acp`
`grok-build-cli` co-presence is a **preview** capability. Known limits: while a human has text in the TUI input box, network tasks only queue and then time out; after grok self-updates to a version outside the verified list, the node fails on its **next restart** (the error prints a `GROK_BINARY=<verified older build> anet node start <node>` recovery command, and a successful start pins it). For an unattended Grok node that reliably takes work, use `anet node create <name> --runtime grok-build-acp`.
:::

`grok-build-cli` gives one Agent Network node ownership of the only real Grok TUI. You enter that same interface from another terminal with `anet grok attach`, while CommHub tasks queue into the same session. Human input has priority and network tasks run FIFO.

::: warning Experimental (included in the published npm packages)
Co-presence ships in the published npm packages on both the `latest` and `preview` channels (see the "Grok co-presence" section of `anet --help`). It is experimental and does not replace `grok-build-acp`, which remains the default recommendation. Co-presence only accepts **verified grok builds**: `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`; anything else is rejected.
:::

## Prerequisites

- Linux, macOS, or WSL with Node.js, Bun, and the native `node-pty` dependency
- Grok Build CLI installed and logged in
- A clone of the Agent Network repository only if you want to run unreleased source changes; with npm-installed `anet` / `agent-node` you can skip the "Build from source" section below

```bash
grok --version
# Must be a build on the verified list: grok 0.2.93 (f00f96316d) or grok 1.0.5 (5115b46bc909)

grok
# Complete login in the UI on first use, then exit
```

## Build from source

Run from the repository root:

```bash
cd agent-node
bun install
npm run build
cd ../agent-network
bun install
npm run build
cd ..
```

If you build from source, the remaining commands on this page must use the CLI you just built, not the globally installed `anet`. In bash/zsh, define a function scoped to the current shell and point it at the matching agent-node:

```bash
export ANET_SOURCE=/absolute/path/to/agent-orchestra
export ANET_AGENT_NODE_BIN="$ANET_SOURCE/agent-node/dist/cli.js"
anet() { bun "$ANET_SOURCE/agent-network/dist/bin/cli.js" "$@"; }

anet --help | grep grok-build-cli
# Output should include grok-build-cli and `anet grok attach` help
```

## Start and attach

Start the Hub and log in as described in [Getting Started](/en/guide/getting-started), then use two terminals:

```bash
# Terminal 1: create and keep the node running
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo
```

The TUI is ready when this marker appears:

```text
[grok-copresence] ...; attach with anet grok attach grok-demo
```

```bash
# Terminal 2: enter the same live TUI
anet grok attach grok-demo
```

Press `Ctrl-]` in the attached terminal to detach that terminal only; the node and Grok session keep running. Only one human terminal may be attached at a time.

Network work is visibly injected as:

```text
[Agent Network/from=<sender>/task=<task-id>] <message>
```

Ordinary human conversation stays local. Only an explicit delegation such as `send_task reviewer inspect the current changes` dispatches work to Agent Network.

## Stop and resume

Stop the node normally:

```bash
anet node stop grok-demo
```

The next `anet node start grok-demo` resumes the same `grokCliSession`. The runtime never silently falls back to headless mode or guesses another session. If the process crashes during a network turn, that task fails instead of being replayed across a possible side-effect boundary.

## Switching models inside the co-presence TUI

The co-presence TUI is **one input box shared by a human and the agent**: every keystroke you type reaches the agent's session, so leading-slash commands are blocked as a class by default (palette completion could turn a short prefix + Enter into `/always-approve`, bypassing the approval gate). There are two safe ways to change the model:

- **Type `/model <model>` right in the TUI** (agent-node `2.5.0-preview.45`+): a pristine `/model <id>` line is **proxied out-of-band** — the keystrokes are still cancelled (the slash palette never sees an Enter), the switch runs through the guarded entry, and the result is printed straight into the TUI (`[anet] 已代为切换模型 → <model>`). Extra tokens, a bare `/model`, or a line touched by arrow-key edits are not proxied and stay blocked.
- **From another terminal: `anet grok model <node> <model>`** — works on any version, even while attached; the session restarts on the new model.

Run `anet grok attach` from the node's working directory (nodes resolve by cwd, see [#1402](https://github.com/sleep2agi/agent-network/issues/1402)).

## Legacy headless mode

To launch a separate non-interactive Grok process for each network task:

```bash
anet node create grok-headless --runtime grok-build-cli --grok-headless
```

Headless nodes cannot use `anet grok attach`. Existing profiles without `grokCopresence: true` retain their old behavior and are not migrated automatically.

## Troubleshooting

### Version mismatch

Run `grok --version`. Co-presence only accepts the exact builds on the verified list (currently `0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`). Install a listed build before starting; do not bypass the gate. On 1.0.5, sandbox and leader mode are mutually exclusive — the runtime adjusts its launch flags per version automatically.

### An existing bare grok session cannot join co-presence by default (but can be transplanted)

Sessions created in plain `grok` (sandbox=off) **cannot by default** be resumed into a co-presence node: the runtime enforces a sandbox profile and grok refuses cross-profile resume (`cannot resume this session under sandbox profile … it was created with 'off'`). Pinning such a session directly into `grokCliSession` yields repeated `Grok recovery TUI exited before recovery drain` (diagnosability follow-up: [#1400](https://github.com/sleep2agi/agent-network/issues/1400)).

**Verified transplant** (keeps all history, no need to disable the sandbox, see [#1409](https://github.com/sleep2agi/agent-network/issues/1409)): the refusal only keys off the session metadata recording `created with 'off'`, so **clone** the session and flip that one field —

1. Copy the old session directory (`sessions/<cwd-key>/<old-id>/`, whole tree: `chat_history.jsonl`/`events.jsonl`/`compaction/`) to a new UUID; delete the `*.lock` files.
2. In the clone's `summary.json`, change `sandbox_profile`: `"off"` → the node's current workspace profile (like `anet-<hash>-workspace`; it is the only occurrence of that field in the tree).
3. Point the node config's `grokCliSession` at the new id and restart the node.

grok then resumes the clone cleanly; recent technical context comes back intact (early/low-frequency content may fall outside the active window due to grok's session compaction). The original session is never touched and can still be viewed with `grok --resume <old-id>`. If you prefer not to transplant, let the node create a fresh sandboxed session (drop the pinned id, or `--new-session`).

> ⚠️ Don't let `auto_update` push grok off the verified list: an unverified build (e.g. `1.0.13`) makes co-presence fail with `requires a verified grok build`. Pin a verified build with `GROK_BINARY`, or disable `auto_update` in the node's private `GROK_HOME` ([#1409](https://github.com/sleep2agi/agent-network/issues/1409)).

### `Installed agent-node does not support grok-build-cli`

The command found npm stable agent-node, or `ANET_AGENT_NODE_BIN` points to the wrong file. Rebuild `agent-node` and set the variable to the absolute path of its `dist/cli.js`.

### attach says it requires a TTY

Run `anet grok attach` directly in an interactive terminal. Pipes, redirected input/output, and non-interactive CI are unsupported.

### attach says the node is legacy headless

That profile does not enable co-presence. Create a new `grok-build-cli` node; do not copy or guess private socket paths.

### Start fails with `<hub> did not answer /health within 2000ms` (hub across a WAN)

`anet node start` probes `<hub>/health` once. From `2.3.0-preview.92` a loopback hub gets a 2 s budget and any other hub 10 s, and `ANET_HUB_HEALTH_TIMEOUT_MS=<1000–60000>` overrides both. Older versions used 2 s for every hub, so a healthy hub behind a 2 s+ round trip was declared down and the node exited. Upgrade; first check the real latency with `curl -o /dev/null -w '%{time_total}\n' <hub>/health`.

### `cannot resume missing session <id>`

The session directory named by `grokCliSession` in the node config is gone (cleaned up, or `GROK_HOME` changed). The runtime deliberately does not start a new session on its own, because that would silently drop the human's TUI history. Recover by deleting `grokCliSession` from `.anet/nodes/<name>/config.json` and running `anet node start` again; a fresh session is created and its id written back.

### Five zero-byte files appear in the project directory (`.grok` `.claude` `.cursor` `.mcp.json` `.envrc`)

These read-deny placeholders are planted by the **grok binary itself** at start so it cannot read those external surfaces in the project; on `anet node stop` the co-presence runtime reclaims only the exact shape "owned by me, zero bytes, single link, mode 0444" (deliberately fail-closed against substitution), and since `agent-node 2.5.0-preview.66` a normal stop leaves nothing behind. On some hosts, however, grok 1.0.5 plants these five files **explicitly as 0666** (measured on a TM cloud HCE host: the same grok process creates its own config and lock files as 0600, only the placeholders are 0666; on DEV the same build plants 0444). There **every** stop, a clean one included, reports `refuses post-stop project placeholder … expected … mode 0444` and leaves five 0666 files, and the next start fails with `expected a real directory`. Recovery: after stop run `chmod 0444 .grok .claude .cursor .mcp.json .envrc` and start again; start reclaims them as stale placeholders. From `agent-node 2.5.0-preview.70` the refusal names this command. Tracked in [#1887](https://github.com/sleep2agi/agent-network/issues/1887). Only "start was killed and left them behind, on an older version" makes the next start fail with `.grok: expected a real directory` — delete the five files and start again.

### `bwrap exec failed` / a hint to `apt install -y bubblewrap`

That `apt` hint is printed by the grok binary itself and ignores your distribution. On dnf/yum systems (HCE, CentOS, Fedora) install the `bubblewrap` rpm (`sudo dnf install -y bubblewrap`, or an offline rpm).

### The TUI stops at `Login with Grok`, and `grok login --device-auth` cannot connect

A co-presence node reuses the login state left by `grok login` on **this machine** (`~/.grok/`); without it the TUI waits at the login gate. Logging in needs direct reachability of `auth.x.ai` / `api.x.ai` / `grok.com`; on egress-restricted hosts (a corporate proxy tunnels, but x.ai's edge rejects the egress IP) not even the device code is issued. `GROK_OIDC_ISSUER` overrides the issuer for a corporate IdP; it is not a proxy and does not fix egress. Either have the network allow x.ai, or create the node on a machine with direct egress. Do not copy another machine's `~/.grok/auth.json` — the login state is bound to the machine and the account.

### Egress only works through a corporate proxy, and `HTTPS_PROXY` on the node changes nothing

The co-presence runtime hands the grok child a **fixed allowlist** of environment variables (`PATH`/`TMPDIR`/`LANG`/`LC_*`/`TZ`/`SHELL`/`USER`/`LOGNAME`/`TERM`/`COLORTERM`/`NO_COLOR` plus `HOME`/`PWD`/`GROK_*`/`ANET_*`); `HTTP(S)_PROXY` is always stripped as part of the sandbox and there is no per-node opt-out. Pushing proxy variables into the node is therefore a dead end. What works on an egress-restricted host is a **host-side** setup: point `auth.x.ai` / `api.x.ai` / `grok.com` at the machine itself in `/etc/hosts` and run a local SNI-based 443 relay that goes out through the corporate proxy, so grok believes it is connecting directly. Verify in two separate steps (TM team, cloud host, 2026-09-16): ① **relay side** — with no proxy variables set, `curl --connect-to auth.x.ai:443:127.0.0.1:443 https://auth.x.ai/.well-known/openid-configuration` returns 200, which only proves the relay can terminate TLS for x.ai and forward upstream; ② **end to end** — grok inside the node uses normal DNS and normal TLS, so it only works once `/etc/hosts` pins `auth.x.ai` / `api.x.ai` / `cli-chat-proxy.grok.com` / `code.grok.com` to 127.0.0.1; check that the node answers a hub probe. Passing ① does not mean ② passes.

To list subcommands use bare `anet grok` (prints both attach and model); `anet grok --help` on `2.3.0-preview.92` and earlier prints only the attach line, from `.93` both agree.

### Project skills (`.agents/skills/<name>/SKILL.md`) make start fail with `refuses external skills source`

**Co-presence `grok-build-cli` does not load skills**: the tool inventory is fixed and runtime-owned, `SKILL.md` counts as an executable source, on Linux any skills source outside the isolated home is refused by the pre-spawn audit, and the isolated home's own `skills/` directory is wiped before every start and every turn (together with hooks, plugins, agents, commands, lsp, settings.json, managed_config.toml, requirements.toml). For the same effect, put the content in plain project documents and have the task prompt tell the agent to `read_file` them, or use a codex / claude node.

**Headless `grok-build-acp` does load** `.agents/skills/<name>/SKILL.md` from the project root (verified on DEV: the isolated-home environment and the symlink farm cwd change nothing). But **the skill list is frozen when the grok session is created**: an acp node resumes the `grokSession` stored in its config every time, so skills added after that session was created stay invisible. After adding or changing skills: stop the node, delete `grokSession` (and `session`) from `.anet/nodes/<name>/config.json`, start the node again (a new session is created and its id written back).

### Can the co-presence TUI run always-approve / full access?

No, by design: the TUI is shared between a human and the agent, and any task from the network lands in that same session, so approval has to stay with the person at the TUI. `flags.dangerouslySkipPermissions: true` in the config makes the node refuse to start (`approval decisions must remain owned by the attached human TUI`); `--dangerously-allow-full-access` only applies to codex co-presence. To let grok edit files or run commands, create a separate `grok-build-acp` node (headless; `dangerouslySkipPermissions: true` works there, but nobody can attach to a TUI). A common setup is one TUI node to talk to and one acp node to do the work.

### `grok-build-acp` on a host that must egress through a proxy: ACP initialize never returns, stderr only shows `Settings fetch failed`

The headless path passes your shell's `HTTP(S)_PROXY` straight to grok (the proxy-stripping environment is only used for the TUI); when the corporate proxy cannot reach `*.x.ai` / `*.grok.com`, grok's settings fetch hangs inside initialize. Fix: `NO_PROXY="x.ai,.x.ai,grok.com,.grok.com,localhost,127.0.0.1"` so those hosts go through the host-side `/etc/hosts` pin and relay (previous entry). Note that CIDR entries in `NO_PROXY` (such as `10.0.0.0/8`) do not match literal IPs for curl / reqwest; add the literal too. (TM team, cloud host, 2026-09-16: initialize returned immediately after the change and a task completed in 38 s.)

### Permission prompts

Only the attached human handles approval prompts. The runtime never selects permanent approval and blocks TUI commands that would change the shared approval policy. At an approval screen, use Enter for allow-once or `Ctrl-C` to reject/cancel.

For implementation details, security boundaries, and Docker verification, see the [complete Grok Build runtime guide](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md).
