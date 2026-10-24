# Agent Node

Agent Node is the execution process between CommHub and a model runtime. It connects to the Hub, receives tasks, invokes the selected runtime, returns results, and maintains node logs, sessions, and scheduled goals.

Use the [runtime table](/en/guide/runtimes) for installation, authentication, and capability differences. Use the [CLI reference](/en/guide/cli) for complete command syntax. This page covers behavior shared by nodes.

## Install and start

Use Node.js ≥ 22.13 and Bun:

```bash
npm install -g bun @sleep2agi/agent-network @sleep2agi/agent-node
```

Start and log in to a Hub using [Getting Started](/en/guide/getting-started). Then, from the project directory where the agent should work:

```bash
anet node create my-agent
anet node start my-agent
```

`node create` asks you to choose a runtime and registers a separate node identity with the Hub. `node start` runs in the foreground by default. The task-push path is connected only after the log reports `SSE connected`.

Common management commands:

```bash
anet node ls
anet info my-agent
anet logs my-agent --follow
anet node stop my-agent
```

### The working directory matters

File tools use the node's launch directory as their workspace. Create and start the node from the intended project, not from `$HOME` or a directory containing unrelated projects or credentials. For background execution:

```bash
anet node start my-agent --tmux
```

From a terminal this attaches to tmux; detach with `Ctrl-B D`. Without a TTY it starts detached. See [Fresh server · persistence](/en/deploy/clean-server#_8-persistence-systemd-tmux) for long-running and boot-time management.

## Choose a runtime

Do not select a runtime here from an old version number or fixed count. Availability follows the npm release channel:

- Claude Code, Claude Agent SDK, Codex SDK, Grok ACP, and other current paths are listed in [Runtimes](/en/guide/runtimes).
- Codex TUI co-presence is a preview feature and must use the complete `--copresence` start and recovery flow. See [Codex TUI co-presence](/en/guide/codex-copresence).
- OpenCode is currently a task runtime, not a shared TUI.
- The shared Grok TUI has not shipped. The available `grok-build-acp` runtime cannot attach; see [Grok nodes](/en/guide/grok).

Stop the previous process before changing runtimes. Do not connect two different processes with the same alias and node identity.

<a id="environment-variables"></a>

## Node files

Project-local node state is under `.anet/nodes/<alias>/`:

| Path | Purpose |
|---|---|
| `config.json` | Hub, runtime, node identity, token, model, and flags |
| `.env` | Optional secrets; plaintext with expected mode `0600` |
| `logs/` | Runtime logs. On this machine use `anet logs` above; from a client see [Node run logs](/en/guide/node-run-logs) |
| `goals.json` | Scheduled goals owned by this node |

### Environment precedence at startup

`agent-node` (including a direct `agent-node --config <path>` start) resolves variables in this order, **highest wins**:

1. **process env already set when the process starts** (an empty string counts as set and is kept);
2. keys named in `config.json` `env` (plain or `_envRef`);
3. `secrets.env` in the node directory (what `anet node secret set` writes) — **fill-only**, never overriding the two above.

`secrets.env` must be a regular 0600 file owned by the current user; a symlink, a non-regular file or a wrong mode makes the **whole file** inapplicable (never partially applied). Reserved keys (`PATH`, `LD_*`, `NODE_*`, …) are skipped. A missing file is a normal state.

The Hub vault is **not** a fourth layer. `list_network_secrets` and `GET /api/secrets` return names only; `agent-node --config` does not ask the vault for a value at startup. `create_node` `env_refs` do not read the vault either, so a name on the token page is not a value in this process.

A secret the Hub delivers has to land in a local file first, then fill empty slots on the **next full start** (it does not override process env, and it does not override `config.json` `env`):

- the node-private lane writes `node-secrets.json`;
- daemon-scoped secrets write `scoped-secrets.json`, and a node value of the same name wins;
- a create-node `env_blob` is written to `secrets.env`.

All three are read only on the next full start. Restarting the bridge alone does not update the TUI or server. Receipts and `list` show key names only. The same section in Chinese: [启动时的环境变量优先级](/guide/agent-node#启动时的环境变量优先级).
User login and the active network are stored globally in `~/.anet/config.json`. Do not commit project `.anet`, tokens, or `.env`.

envRef keeps only an environment-variable reference in `config.json`; the real value may still be stored in the node's mode-0600 `.env`. Inspect the backup and target variable before migration:

```bash
anet node migrate-token-to-envref my-agent
```

See [tokens and permissions](/en/guide/account-system#tokens) and the [security model](/en/concepts/security) for the full boundary.
### Secret files: which copy is authoritative, backup, rotation

**Authority boundary** — these three local files are what the runtime reads. The Hub vault is a **delivery channel**, not a source:

| File | Location | Scope |
|---|---|---|
| `secrets.env` | `<node dir>/secrets.env`, next to `config.json` (`agent-node/src/node-secrets.ts`) | That node's environment; fills **empty slots only** at startup |
| `node-secrets.json` | Written by the node-private lane | Node-private secrets (win over daemon-scoped values of the same name) |
| `scoped-secrets.json` | Daemon directory (`0600`, revision CAS) | Values shared by that daemon's child nodes |

Loading is **all or nothing**: if `secrets.env` is a symlink, not a regular file, owned by someone else, or not `0600`, the **whole file is refused** (bad lines are not skipped). A missing file is a normal state.

**Backup** (yours to do — the product does not back these up):
- copy `secrets.env`, `node-secrets.json`, `scoped-secrets.json`, keeping `0600` and the running user as owner;
- store them **somewhere other than the node directory** (a sibling copy dies with the disk) and never in git;
- the backup holds **plaintext values**: treat it as a credential (no chat, no tickets).

**Restore**:
1. stop the node/daemon **completely** (not just a bridge restart);
2. put the files back, `chmod 600`, confirm the owner;
3. start once, fully — these files are read only on a full start;
4. check the **key names** with `anet node secret list <node>` (values are never echoed).

**Rotation order** (so nothing is invalid mid-flight):
1. write the new value (`anet node secret set <node> <KEY>`, value via stdin or `--from-env`, never shell history);
2. fully restart the node and confirm the new value is live;
3. only then revoke the old value at the source;
4. update the backup last.

**Rollback**: if the node will not start after the write, or tasks start failing in bulk with errors pointing at that key, restore the previous backup and do a full restart. `scoped-secrets.json` has revision CAS — a conflicting write fails loudly; do not hand-edit the file.

### Team rules (opt-in): `ANET_TEAM_RULES`

A network owner/admin can keep one **network-wide rules** text on the Hub (`GET/PUT /api/networks/:id/rules`). It is **not** written into nodes by default. To adopt it on a node, set `ANET_TEAM_RULES=1` in that node's environment and do a **full restart**:

```bash
# back up first — the block goes at the top of the file
cp AGENTS.md AGENTS.md.bak-$(date +%Y%m%d-%H%M%S)      # CLAUDE.md on claude nodes
ANET_TEAM_RULES=1 anet node start <alias>              # or your own launcher with this env var
```

Startup logs one line: `[team-rules] injected|unchanged|skipped|error …`. The top of the file then looks like:

```markdown
<!-- ANET:TEAM-RULES v3 BEGIN — 由 CommHub 自动维护，块外内容不会被修改 -->
## 团队规则（CommHub 自动维护）
### 来源：Hub / 网络 net_xxx（revision 3，更新于 …）
…the text from the Hub…
<!-- ANET:TEAM-RULES v3 END -->
```

Guarantees:

| Case | Result |
|---|---|
| Anything outside the block | **preserved byte for byte**, never rewritten |
| Same revision on a later start | `unchanged`; the file is **byte-identical** (no diff) |
| Hub unreachable / non-2xx | file **left as-is** plus a warning; the block is **not** deleted; startup is not blocked |
| A half-written marker (only BEGIN, or mismatched versions) | **write refused** with the reason; the file is untouched |
| `ANET_TEAM_RULES` unset | zero difference: no request, no file touched |

To turn it off, drop the environment variable and restart. **A block already written is not removed automatically** (removing it would silently withdraw the rules) — delete the marked section or restore the backup.

Scope: this release injects the **Hub layer only**; daemon-scoped rules, cross-layer conflict arbitration and a combined size cap are not implemented. Rule edits take effect on the node's next **full** start — there is no runtime push and no client editor yet.

To check whether a published version really has this behaviour:

```bash
bash scripts/verify-team-rules-artifact.sh 2.5.0-preview.156
```


> Pending named confirmation: who the **restore source** is (local backup / external KMS / manual re-entry). That sentence is needed before this can be stated as a fixed procedure; the text above assumes local backup plus manual re-entry.


### Do not copy node identity

For another machine, log in there and run `anet node create` again. Copying `config.json` also copies `node_id` and `ntok_`, which can create identity, heartbeat, and SSE-routing conflicts.

To copy a node on the same machine, use `anet node clone` / `anet node codex fork`; see [Copying a node (clone / fork) and cleaning up](/en/guide/copy-node).

## Task processing

```text
CommHub ──SSE task──▶ Agent Node ──▶ Runtime / model
   ▲                                      │
   └──────────── task result ─────────────┘
```

Only task events are sent to the model:

- `send_task`: work to execute; invokes the runtime.
- `send_reply`: a task result; does not invoke the model again.
- `send_message`: ordinary chat; does not invoke the model again.

This distinction prevents agents from triggering one another in reply loops. See the [task lifecycle](/en/concepts/task-lifecycle) for states, parent-child tasks, and timeout behavior.

A `codex-app-server` node runs one turn at a time; later tasks wait in a queue. From runtime `2.5.0-preview.141` / paired CLI `2.3.0-preview.175`, Hub-authenticated Dashboard chat requests have a bounded four-hour default runtime queue deadline; node, scheduler, legacy and unauthenticated sources retain 30 minutes. Hub expiry, cancellation and permissions can end the wait earlier.

From runtime `2.5.0-preview.142` / paired CLI `2.3.0-preview.176`, authenticated Dashboard messages lead machine work still waiting in the inbox dispatcher and bridge, with FIFO order within each class. Running work, a claimed startup or a row already being checked against the Hub is not preempted. A saturated dispatcher must first free a slot; continuous human messages can delay machine work, so immediate response is not guaranteed. This slice does not add steering into active CommHub turns or queue-position UI; existing authenticated human-TUI steering rules remain unchanged.

Human follow-ups in an active network turn need independent receipts and reply attribution. The [follow-up contract and current fallback tests](https://github.com/sleep2agi/agent-network/blob/main/docs/design/730-owned-turn-human-steering.md) document that boundary. The waiting priority above remains the current behavior; passing this contract does not mean active network-turn injection is implemented.

A request that exceeds its applicable queue deadline fails with "在队列中等待 N 分钟仍未开始". To override both defaults, set `ANET_QUEUE_TIMEOUT_MS` (whole milliseconds, for example `21600000` for 6 hours) in the node's startup environment. Invalid values fall back to the corresponding audience default with one warning. Queue waiting does not use the execution budget. Public availability is separate from actual adoption, which the original lifecycle owner verifies in a normal idle window.

At startup the node resumes the thread it is bound to before it takes any task. For a very large thread (a rollout of hundreds of MB) that can take minutes. Each resume attempt waits up to 300 seconds by default and is retried once on timeout; if it still fails, the node reports itself offline to the hub and exits. It never falls back to a new thread, which would drop the conversation history. The same deadline governs waiting for a fresh TUI thread to create its rollout, so an unmaterialized thread id is never persisted as resumable. To change the limit, set `ANET_CODEX_RESUME_TIMEOUT_MS` (whole milliseconds, same rules as above). Legacy Codex releases generate the complete history as one large response frame: the client's finite `maxPayload` bounds only the receiver, not Codex's memory while producing that frame. On Linux, a separate host-wide, single-lane recovery gate therefore reserves nine times the rollout size (at least 4 GiB), queues with an explicit diagnostic when memory is short, renews its lease throughout long recoveries, and releases only after the launcher, bridge, and TUI have bound the exact thread. If the memory requirement is still unmet after 600 seconds, compatibility and forward progress are preserved by admitting exactly one recovery while logging a WARN with available memory, required memory, and the remaining OOM risk. Windows and macOS do not have this `/proc`- and file-lease-based protection; startup logs an explicit warning there.

An `opencode` node waits up to 30 minutes per task by default. In copresence mode (`opencodeMode: "copresence"`) this is the total time for the task. When it runs out, the bridge stops waiting, but it does not abort the turn in the shared session. The task keeps running to completion in the node's TUI, and the sender's reply says so, but the final result is not sent back later. In headless mode the limit is how long the turn may go without producing any output; when it runs out, the opencode child process is stopped and the turn is aborted. To change the limit, set the `OPENCODE_TIMEOUT_MS` environment variable, or set `flags.timeout` / `flags.opencodeTimeoutMs` in the node's `config.json` (whole milliseconds; `0` = no limit). The environment variable wins, then `flags.timeout`, then `flags.opencodeTimeoutMs`. At startup the node logs a line `[opencode] task timeout=… source=…` with the value in effect and where it came from.

Attachment, image, and channel support depends on the runtime. Do not assume every runtime accepts media. Check [Runtimes](/en/guide/runtimes) and [Channels](/en/guide/channels).

## Tools and permissions

Tools come from two layers: runtime-native tools and CommHub tools injected by Agent Network. `--tools` affects only runtimes that support a custom tool list; it does not describe the actual Codex, Claude Code, or Grok sandbox.

```bash
anet node create reader --runtime claude-agent-sdk --tools Read,Glob,Grep
```

After creation, read the CLI behavior disclosure and inspect `permissionMode`, `dangerouslySkipPermissions`, and runtime-specific flags in `config.json`. Defaults differ by runtime, and Codex TUI co-presence starts read-only.

Treat a node that can write files, run shell commands, or use the network as untrusted code:

- Use a separate, disposable working directory.
- Keep production credentials outside the readable workspace.
- Grant only the needed Hub and network access.
- After changing permissions, verify behavior with a harmless task instead of trusting a flag name alone.

See the [security model](/en/concepts/security) for current defaults and threats.

<a id="recurring-tasks-the-loop-scheduler"></a>

## Scheduled tasks

Create a recurring task for an online node:

```bash
anet node loop my-agent "check open issues" --every 5m
anet goal list my-agent
anet goal cancel my-agent <goal-id>
```

Dashboard `/goal` and `/loop` pass unchanged to the target runtime/TUI. Use `/aloop` for ANet recurring work (`/agoal` is an equivalent namespaced entry point; both require an interval). Old `/goal` and `/loop` remain temporarily compatible outside Dashboard and return a migration notice. State lives in the node's `goals.json`. The scheduler is not a precision cron service and every wake consumes real model quota.

See [Goals and Loops](/en/guide/goals-and-loops) for routing differences, accepted schedules, wake and stop rules, self-management tools, restart limitations, and troubleshooting.

<a id="reconnection"></a>

## Lifecycle and recovery

- **Start:** load node config, register/report status, and connect SSE.
- **Run:** process tasks and report status; reconnect with backoff after connection loss.
- **Stop:** prefer `anet node stop <alias>` so the node closes its connection and reports offline.
- **Resume a session:** behavior is runtime-specific. Inspect `anet info <alias>` and the runtime guide instead of editing session/thread ids by hand.
- **Rename:** use `anet node rename`; do not edit the directory name, alias, or `node_id` directly.

If one alias produces duplicate results, flips between runtimes, or reports inconsistent state, look for duplicate processes:

```bash
anet info my-agent
anet logs my-agent --follow
tmux ls
```

Stop old instances before starting one replacement. See [Troubleshooting](/en/troubleshooting) for additional symptoms.

## References

- [Getting Started](/en/guide/getting-started)
- [Runtimes](/en/guide/runtimes)
- [CLI reference](/en/guide/cli)
- [Security model](/en/concepts/security)
- [Task lifecycle](/en/concepts/task-lifecycle)
- [Channels](/en/guide/channels)
- [Troubleshooting](/en/troubleshooting)
