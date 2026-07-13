# Grok Co-Presence Preview

## Status and boundary

`grok-build-cli` co-presence is a dangerous experimental candidate for the npm `preview` channel. It is not production-ready, is not part of `latest`, and must not be connected to untrusted tasks or an untrusted network.

This guide describes the candidate source behavior. It does not assert that a particular npm `preview` dist-tag already contains the candidate; package publication remains gated on install-from-tarball testing, an independent review, and explicit release approval.

The main known risk is intentional and visible: CommHub tasks drive the same Grok TUI that a human uses, so both sides share one conversation context. Production-grade approval ownership is incomplete. A model action or approval prompt must not be treated as a secure boundary against untrusted task content.

The formal native Leader/Policy Gateway runtime is a separate, stricter track. Its Phase 0 protocol freeze, Phase 1A implementation gate, approval-owner work, and `latest` release gate remain locked. This preview does not claim those capabilities.

## Requirements

- Linux with procfs mounted at `/proc` (including `/proc/self/fd`).
- `@sleep2agi/agent-network` from the `preview` channel once the candidate is published.
- The exact Grok CLI build `grok 0.2.93 (f00f96316d)`; the known stable installer may append ` [stable]` to that output.
- A completed Grok CLI login for the same operating-system user that runs `anet`.
- Two terminals on the same machine and user account: one owns the node process; one attaches to its local TUI socket.
- A trusted CommHub and trusted task senders.

Verify Grok before creating the node:

```bash
grok login
grok --version
```

The co-presence runtime fails closed when the version string does not match the pinned build.

## Shared-TUI quick start

Install the preview CLI when a reviewed preview package containing this runtime is available:

```bash
npm install -g @sleep2agi/agent-network@preview
```

Create and start the node in terminal 1:

```bash
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared
```

Attach terminal 2:

```bash
anet grok attach grok-shared
```

Press `Ctrl-]` to detach without stopping the node.

The default `grok-build-cli` profile created by `anet` enables co-presence. `anet node start` owns one Grok PTY and exposes a local, same-user attach socket. The attached terminal renders that TUI. A network task sent to `grok-shared` is submitted into the same session, appears in the TUI, and its completed answer is routed to the original CommHub task.

The preview uses one runtime-owned, mode-`0600` agent profile selected with
the TUI-effective `--agent` flag. Its exact model-tool inventory is
`[todo_write]`: filesystem, shell, network, media, MCP, scheduler, and
subagent tools are unavailable. Generic `tools` and `maxTurns` settings are
rejected in co-presence because Grok 0.2.93 ignores their corresponding CLI
flags in interactive mode. This deliberate text-only restriction lets the
pinned CLI read its existing owner-only login after sandbox re-exec without
giving a network prompt a model-tool route to that file. Use another runtime
when code inspection/editing, shell execution, or web/media access is needed.

The runtime prepares Grok's owner-only folder-trust store non-interactively,
but grants trust to the exact canonical working directory only. It first
refuses project MCP, LSP, hook, plugin, permission/sandbox configuration, and
`.envrc` sources that folder trust could activate; it never widens the grant
to a repository root, parent, symlink alias, home directory, or filesystem
root. This is why a normal start requires no simulated `y` keypress.

The preview package gate covers the CommHub inbox path. Feishu is explicitly
refused for `grok-build-cli` because its forked worker does not yet share this
runtime's credential-isolated log boundary; use a separate non-Grok node for
Feishu. Other optional channel adapters are outside this preview's package E2E.

There is no separate `--copresence` flag: co-presence is the default for a newly created `grok-build-cli` node. `--grok-headless` is the explicit opt-out described below.

## Agent-node package resolution

A global `agent-node` install is optional. Before starting `grok-build-cli`, `anet` checks for the machine-readable `ANET_CAPABILITY_GROK_COPRESENCE_V2` marker; merely advertising `grok-build-cli` or the older V1 co-presence marker is not sufficient. If the installed binary is absent or incompatible, `anet` uses:

```bash
npx -y @sleep2agi/agent-node@preview
```

The command is used only to fetch and resolve the package. `anet` then validates its preview metadata and capability marker and launches the resolved `agent-node` entrypoint directly, so the PID recorded for `anet node stop` belongs to the real runtime rather than the short-lived npm wrapper. It needs npm registry access or an already populated npm cache on first use. `anet` refuses an unsupported fallback rather than silently selecting a different runtime.

The npm resolver, long-lived `agent-node`, Grok probes, PTY, and lock helpers
each receive a separately reviewed environment built from an empty object.
The node credential is read from its owner-only profile instead of being put
in those environments. Ordinary logs, pending replies, and goal state cross a
shared redaction boundary; their durable files are mode `0600`. This is an
environment-inheritance boundary, not isolation from another process already
running as the same operating-system user; same-UID processes remain inside
the preview's trusted host boundary.

## Headless choices

There are two distinct headless paths.

### Legacy process-per-turn Grok CLI

```bash
anet node create grok-turn --runtime grok-build-cli --grok-headless
anet node start grok-turn
```

This launches one streaming-JSON Grok CLI turn per task. It has no shared interactive TUI, and `anet grok attach grok-turn` intentionally fails.

### Grok ACP

```bash
anet node create grok-acp --runtime grok-build-acp
anet node start grok-acp
```

This launches `grok agent stdio` and uses ACP session handling. It is not an alias for the process-per-turn `grok-build-cli` lane.

| Profile | Execution path | `anet grok attach` |
|---|---|---|
| `--runtime grok-build-cli` | shared human/network TUI | yes |
| `--runtime grok-build-cli --grok-headless` | one streaming-JSON CLI turn per task | no |
| `--runtime grok-build-acp` | `grok agent stdio` ACP | no |

## Preview safety rules

- Use only trusted task senders. A network task influences the same model and conversation visible in the human TUI.
- Do not use this runtime for production work or connect it to a public/untrusted Hub.
- Do not enable permission bypass for the co-presence profile.
- Treat every approval prompt as human-visible experimental behavior, not as proof of production-grade owner or lease enforcement.
- Grok children and runtime lock helpers receive exact, from-empty environment allowlists. CommHub/cloud credentials are not inherited by those processes.
- The shared-TUI preview has the exact fixed tool inventory `[todo_write]`; do not treat it as a filesystem-, network-, media-, MCP-, subagent-, or shell-capable coding runtime.
- Folder trust is runtime-owned, mode `0600`, and contains exactly the current canonical working directory; project executable configuration is a startup error rather than implicitly trusted code.
- Known values loaded by the process and recognized credential shapes/assignments in network task text or replies are scrubbed before ordinary logs, status, pending replies, and external delivery. This is not a universal classifier for arbitrary opaque text: do not paste credentials into the shared conversation or TUI. The isolated Grok conversation transcript is the only owner-only raw transcript store: its directories are `0700` and regular files are `0600`; do not copy it into reports or support bundles.
- Do not infer `latest` support from this document. Promotion requires a separate review and release decision.

## Common errors

`grok copresence requires exactly grok 0.2.93 (f00f96316d)` means the installed Grok binary is not the captured build. Install the pinned build; do not bypass the check.

`Node ... uses legacy headless grok-build-cli mode` means the profile was created with `--grok-headless`. Create a new co-presence profile explicitly rather than editing socket/session fields by hand.

`grok attach requires an interactive TTY` means the attach command is running under redirected input/output. Run it from a real terminal on the same host and user account as the node.

`grok-build-cli refuses project executable configuration` means the working
tree contains a project MCP/LSP/hook/plugin/config/direnv source that Grok
folder trust could execute. Remove or isolate that source before using the
shared-TUI preview; the runtime will not click through or broaden trust.

If `anet` says the preview `agent-node` does not advertise `grok-build-cli`, the required preview package has not been published or cached yet. Do not force an older package to run the profile.
