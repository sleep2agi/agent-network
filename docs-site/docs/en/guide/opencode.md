# OpenCode V2

OpenCode V2 is the second generation of the `opencode-cli` runtime, not an eighth runtime. The wizard still shows one `opencode-cli` entry. A create that omits `--opencode-generation` is V1 (package `opencode-ai`). V2 has to name its generation, and it only runs as co-presence.

The support table in the source still marks V2 `preview`. The create command is real. A safe preset, a desktop wizard, and a model-catalog picker are not wired to V2.

| | V1 (default) | V2 |
|---|---|---|
| Upstream package | `opencode-ai`, pin `1.18.34` (the transition also accepts `1.18.1`) | `@opencode/cli`, only `2.0.22` is accepted |
| Mode | headless or co-presence | co-presence only. Headless is refused |
| Safety | local tools off by default | no enforced safe preset. `--opencode-unsafe-tools` is required, which enables every local tool. Trusted tasks only |
| Create | `anet node create <name> --runtime opencode-cli` | also pass `--opencode-generation v2 --opencode-unsafe-tools` |

Both packages install a command named `opencode`. They cannot share one npm prefix. Do not replace a production global V1 install to try V2.

## Install and prerequisites {#install}

Measured on npm on 2026-10-11: `preview` was `2.3.0-preview.162` and `latest` was `2.3.0-preview.76`. The V2 create flags entered the preview line at `agent-network@2.3.0-preview.140` / `agent-node@2.5.0-preview.107`. That `.76` latest build has no `--opencode-generation`; `opencode-cli` there is V1. Dist-tags move. Check the install you have:

```bash
anet -v
npm view @sleep2agi/agent-network dist-tags
```

`opencode-cli` checks that anet and agent-node are the exact paired versions. A mismatch refuses to start and says an unsupported agent-node could silently select another runtime. Upgrade both packages together.

Install the V2 binary on its own, at pin `2.0.22`:

```bash
npm install -g @opencode/cli@2.0.22
```

The `PATH` for this launch must find that V2 prefix first. `opencode --version` must be `2.0.22`. Any other 2.x is refused at create or start.

The model and provider must already be in OpenCode's config on this machine. anet does not invent a preset:

- global `~/.config/opencode/opencode.json`
- project `opencode.json`, or `.opencode/opencode.json` (later files override earlier ones; `.opencode` overrides the direct file in the same directory)

`model` is OpenCode's own `provider/model` (exactly one slash). When `providers.<id>` exists, create copies that entry into the node as-is.

Platform: the V2 co-presence evidence that exists today is Linux. This page does not extend the V1 macOS co-presence note to V2, and it does not include Windows.

## Create a node {#create}

From a directory whose OpenCode config is already written:

```bash
anet node create opencode-v2 \
  --runtime opencode-cli \
  --opencode-generation v2 \
  --opencode-unsafe-tools \
  --model '<the provider/model already in this machine OpenCode config>'
```

`--provider` may only restate a provider id already in that config. It does not turn on unsafe-tools, and `--base-url` or `--api-key-env` cannot rewrite OpenCode's own provider. If the request and the local config disagree, create refuses and prints both values. It does not fall back to anthropic or to a preset default model.

Without `--opencode-unsafe-tools`, create and start both refuse with one actionable line. V1's `OPENCODE_PERMISSION` / `OPENCODE_PURE` do not apply to V2.

A successful create records:

- `opencodeGeneration: "v2"`
- `opencodeMode: "copresence"`
- `flags.opencodeUnsafeTools: true`

The terminal prints the high-risk notice: every local tool is enabled, the cwd is the project directory, and this is not a sandbox. Use Docker or a VM for process and filesystem isolation.

Environment variables named by the provider config must already be set at create time. The values go into the node's mode-`0600` `.env`. They are not written to `config.json` and are not echoed on the command line.

## Start, attach, stop {#start}

```bash
anet node start opencode-v2 --copresence
tmux attach -t '=opencode-v2'
```

Create already sets `opencodeMode: "copresence"`, so a later plain `anet node start opencode-v2` also enters the co-presence launcher. A headless start is refused. When you resume, do not switch to a start that drops co-presence.

`tmux` treats the session name as a prefix. Keep the leading `=`. Without it, a missing TUI can fuzzy-match `<name>-桥`, and you will be looking at agent-node logs rather than OpenCode.

Leave the TUI without stopping the node: `Ctrl-b`, then `d`. Stop:

```bash
anet node stop opencode-v2
```

The human UI for V2 is `opencode --server <url> --session <id>`, started by the node's launcher. Do not use V1's `opencode attach`.

## Hub dialogue {#hub}

Once the node is online, a Hub task (a Dashboard assignment, or another node's `send_task`) enters the same shared session. agent-node queues the task into that session, waits for the turn to finish, and publishes the final text back to the sender.

Queuing uses OpenCode's `delivery: "queue"`. If a person is typing or a turn is already running, the network task waits for it to finish instead of merging into it. In the shared session, a task that has a sender is shown as `[来自 <sender>] …`. The sender comes from the authenticated Hub message, not from a name the model writes.

A plain message (`send_message`, or a Dashboard message that does not ask for a reply) is logged and acked. V2 has no V1 TUI toast route, so this preview does **not** pop a notification in the TUI. Absence from the TUI is not evidence the message was dropped, and it is not evidence the person saw it.

Startup configures a CommHub MCP that belongs only to this node, and it waits until `commhub_send_task` and `commhub_get_task` are in the tool list before creating the session. That is a startup check, not a promise that the model will call those tools later. The create notice says model-driven MCP calls need separate verification. A model saying "sent" is not a send.

## Daemon {#daemon}

The path in this guide is `anet node create` on the machine that will run the node.

A daemon `create_node` can carry the same constraints, but the fields belong in `node_spec.flags`, not at the top of the spec:

- `opencodeGeneration: "v2"`
- `opencodeUnsafeTools: true`
- `model` set to OpenCode's own `provider/model` (exactly one slash)

Omitting the generation stays on V1. A V2 binary on `PATH` does not flip that create to V2. If an explicit generation does not match the installed `opencode --version`, the daemon refuses before it writes the child config, with `opencode_generation_mismatch` (V2 accepts only `@opencode/cli@2.0.22`). A `--version` timeout is not refused at this step.

When the readiness probe sees 2.x, `state` stays `unknown`: the CLI was found, which does not confirm the provider or the login. Reaching `opencode.ai` does not prove the selected model works, and a local or LAN provider does not depend on that site. A client that still shows "not checked" may continue configuration. Generation, mode, and the unsafe consent echoed on the config snapshot are read-only. `update_node_config` cannot change them.

On Linux, the daemon treats a co-presence start as finished only after it sees this round's launch evidence (`opencode-launch-health.json` for bridge / serve / TUI). A Hub registration `succeeded`, or the launcher's own exit 0, is not health by itself. That evidence path is not accepted on other platforms.

The desktop wizard and a signed client create entry for V2 do not ship with this page. In the support matrix, creating `opencode-cli` through the daemon is still a cell without a fresh end-to-end check. The catalog reader (next section) is not on the daemon create path.

## Model catalog {#catalog}

[#2574](https://github.com/sleep2agi/agent-network/pull/2574) merged a reader on main. Given a loopback OpenCode V2 server the caller already owns and can authenticate to, it reads providers, models, and the default model into one snapshot. It does not start a server, read `auth.json`, send a prompt, or run a paid probe.

That snapshot is **not** wired to daemon dispatch, Hub authorization, heartbeat, or the client's model picker. Scope labels supplied by the caller do not authorize access. `invocationVerified` is always false and `completeness` is `unknown`, including for an empty list. Do not read the counts as "these models are usable."

It is also not a user command, and it is not in the `preview` package published as of 2026-10-11 (`2.3.0-preview.162`). Creating a node still copies this machine's `opencode.json`. It does not call the reader.

## Known limits {#limits}

- Maturity is preview. There is no V2 safe preset. The unsafe-tools opt-in cannot be the default, cannot be inherited from another runtime or a template, and a refusal cannot be turned into an automatic retry.
- Only `@opencode/cli@2.0.22` co-presence is accepted. A V2 session is not promised to downgrade into a V1 session.
- The V2 evidence that exists is Linux. Do not treat the V1 macOS note, or Windows, as V2 support.
- The catalog reader is not wired through. There is no product entry that pulls a verified model list from the Hub.
- Plain messages do not toast in the V2 TUI.
- Whether the model calls CommHub tools is not an accepted user path.
- `opencode-cli` cannot be copied with `anet node clone`. Create it again.
- The Feishu tool-denial layer is not implemented on opencode. Do not attach Feishu to this node and expect it to block secret paths.

The longer operator boundaries, launch evidence, and test scope live in the repo runbooks. This page does not restate them as a second command set:

- [OpenCode TUI co-presence runbook](https://github.com/sleep2agi/agent-network/blob/main/docs/runbooks/opencode-tui-copresence.md)
- [OpenCode V2 startup readiness](https://github.com/sleep2agi/agent-network/blob/main/docs/runbooks/opencode-v2-registry-readiness.md)

## Related

- [Choosing a Runtime](/en/guide/runtimes)
- [Your first node in 10 minutes](/en/guide/getting-started)
- [Models & Providers](/en/guide/multi-model)
- [Codex TUI Co-presence](/en/guide/codex-copresence)
- [Grok Nodes](/en/guide/grok)
