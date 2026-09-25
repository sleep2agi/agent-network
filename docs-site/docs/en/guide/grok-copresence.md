# Grok Co-presence TUI (Experimental)

::: danger ACP mode `grok-build-acp` is the default and recommended; co-presence `grok-build-cli` is experimental
Grok nodes default to, and we recommend, `--runtime grok-build-acp` (ACP mode). `grok-build-cli` co-presence is an experimental capability: while a human has text in the TUI input box, network tasks only queue and then time out; after grok self-updates outside the verified list, the next restart fails (the error prints a `GROK_BINARY=<verified older build> anet node start <node>` recovery command). For an unattended node that reliably takes work, use `--runtime grok-build-acp`.
:::

::: tip Current status
`grok-build-cli` and `anet grok attach` ship in the published npm packages (both the `latest` and `preview` channels; the "Grok co-presence" section of `anet --help` lists them). The status is **experimental**: it works end to end (create the node → `anet grok attach` into the shared TUI → a network task is injected and answered), but it is not the default recommendation. Only grok builds on the verified list are accepted (`0.2.93 (f00f96316d)` and `1.0.5 (5115b46bc909)`). For usage see [Grok Co-presence TUI (grok-build-cli)](/en/guide/grok-tui). The danger block further down records the 2026-08-18 state and is kept for the record.
:::

::: warning `blocked` cannot tell real from false — **fixed from agent-node `2.5.0-preview.57`** ([#1606](https://github.com/sleep2agi/agent-network/issues/1606))
**With grok 1.0.5 this cell is permanently `blocked`, even while the node is working normally.**

1.0.5 is a **leaderless** build — by design it never creates `leader.sock` (`autoLeader: false` in the capability
table, on both macOS and Linux), while the liveness check requires it unconditionally. `usable` is therefore
structurally false, and the `idle` the heartbeat reports is rewritten to `blocked` every 3 minutes.

Measured: a node marked `blocked` still injected a network task, returned an answer, and replied to the sender.

**Do not rebuild the node when you see `blocked`.** Check your agent-node version first:

```bash
agent-node --version
```

- **≥ `2.5.0-preview.57`** — fixed. A `blocked` here **carries information**: check the TUI child process, composer readiness, and `attach.sock`.
- **< `2.5.0-preview.57`** — this cell is structurally false for leaderless builds and **carries no information**. Judge by the logs instead: `injected network task` / `processTask returned` means the runtime is fine.

🔴 **Upgrading is not enough — you must restart**, because liveness is computed inside the long-running process:

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.57
anet daemon restart <daemon>        # requires anet >= 2.3.0-preview.74
```

🔴 **Check your grok version before restarting** ([#1615](https://github.com/sleep2agi/agent-network/issues/1615)):

```bash
grok --version
```

**The `grok` on `PATH` can become a version outside the verified list** (for example, someone installs a
newer grok on that machine). Once it does, co-presence nodes **fail to start on the next restart** (fail-closed), while **already-running nodes look completely fine** —
they are using the process spawned earlier. The problem only surfaces when you run the restart above,
and by then the node is already stopped.

The error lists the verified versions. The older binary is usually still in `~/.grok/downloads/`:

```bash
GROK_BINARY=~/.grok/downloads/grok-<verified-version>-<platform> anet node start <name>
```
:::

::: danger Old state as of 2026-08-18 (archived)
Do not follow older instructions for the `grok-build-cli` runtime path — do not run `anet node create ... --runtime grok-build-cli`.

🔴 **Correction (measured 2026-08-18)**: this page used to say `anet grok attach` is "not included in npm `latest` or `preview`". The second half does not hold. Running the real published binaries:

```
latest  2.2.21              anet grok attach → Unknown: grok
preview 2.3.0-preview.39    anet grok attach → Usage: anet grok attach <node>
```

⇒ **The command does exist on `preview`** — it is only missing from `latest`.
**But "the command exists" is not "this co-presence path works"** — only command registration was verified, not end-to-end usability.
The rest of this page still holds: it is being requalified, do not treat it as released.
:::

## What works today

- `grok-build-acp` (**default, recommended**): the stable Grok runtime. It runs network tasks through `grok agent stdio` and **cannot attach to the same TUI**.
- `grok-build-cli` (**experimental**): a human and network tasks share one Grok TUI; see [Grok Co-presence TUI](/en/guide/grok-tui).
- `grok`: you can use the Grok CLI directly in a terminal, but that does not turn the TUI into an Agent Network co-presence node.

```bash
grok login
anet node create grok-agent --runtime grok-build-acp
anet node start grok-agent
```

For co-presence node setup and attach steps, see [Grok Co-presence TUI](/en/guide/grok-tui). See [version channels](./versioning.md).
