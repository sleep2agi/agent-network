# Support Matrix: which feature works on which Runtime / OS

This page answers two questions:

1. For a given feature, does it work on each of the 7 runtimes?
2. On a given OS, which capabilities are available?

## How to read the table

Each cell is one of three states, not two:

| Mark | Meaning |
|---|---|
| ✅ | Verified working |
| ❌ | Verified not working, cause known (see footnote) |
| ❓ | Not verified yet. Not "probably works", not "probably doesn't" |

Two auxiliary marks also appear: ⚠️ means a known issue or an open question — see the note under that table; — means not applicable.

Some ✅ cells carry a reliability level:

| Level | Meaning | Advice |
|---|---|---|
| ✅L3 | Automated tests, running in CI | Safe to depend on |
| ✅L2 | Verified on a real machine, not in CI | Works; re-check after upgrading |
| ✅L1 | Only the normal usage path was verified | Use with care |

A ✅ without a level should be read as L1. When you see ❓, try it in your own environment before depending on it.

The table reflects the most recent verification; later releases may have changed the result, and the footnotes note the changes we know of.
If a cell does not match what you see, please open an issue on [GitHub](https://github.com/sleep2agi/agent-network/issues) with reproduction steps.

---

## 1. Feature × Runtime

The 7 runtimes:
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| Feature | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| Create node via CLI<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create node via daemon<br>through `create_node` | ✅ | ❓ | ✅ | ❓ ^1^ | ✅ | ❓ ^1^ | ❓ ^1^ |
| TUI co-presence<br>human + agent share one session | — | — | — | ✅ | — | ✅ | ✅ |
| Node-level logs<br>`.anet/nodes/<alias>/logs/` | ✅ | ❓ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| Feishu IM direct chat | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| Bad task result marked failed<br>a bad result is not recorded as success | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**Footnotes**

- ^1^ On earlier versions, creating these three co-presence runtimes through a daemon was rejected by the Hub with
  `runtime_invalid`. The Hub and daemon runtime lists have since been widened to all 7
  ([#1298](https://github.com/sleep2agi/agent-network/issues/1298)), but a co-presence node created through a daemon
  has not been re-verified end to end. Also note that these three runtimes exist so a human and an agent share one
  TUI session, while a daemon creates an unattended background process; if you need one of them, creating it on the
  target machine with `anet node create` is the safer path.
- ^2^ On earlier versions, `claude-code-cli` nodes wrote no node-level logs: in that mode Claude Code hosts the
  CommHub channel itself and no `agent-node` process is started, and node-level logs are written by `agent-node`.
  A fix (also writing logs to `.anet/nodes/<alias>/logs/`) has shipped
  ([#1345](https://github.com/sleep2agi/agent-network/issues/1345)); this cell has not been re-verified.
- ^3^ The Feishu path has only been verified on `claude-agent-sdk`; the other runtimes are "not yet verified",
  not "unsupported". See [#1259](https://github.com/sleep2agi/agent-network/issues/1259).
- ^4^ An opencode node can return raw, un-executed `<tool_call>` text as the task result, and the Hub records it as
  completed normally, so task status alone will not reveal it. Whether other runtimes are affected has not been
  verified. See [#943](https://github.com/sleep2agi/agent-network/issues/943).

---

## 2. OS × capability

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Start a node via CLI (`anet node start`) | ✅ | ✅ | ❓ |
| daemon creates a node (any runtime) | ✅ | ✅ | ❌ ^5^ |
| daemon registers / online / receives doorbell | ✅ | ✅ | ✅ ^6^ |
| External launchers / `anet hub start` / self-upgrade | ✅ | ✅ | ❓ ^7^ |
| TUI co-presence (Codex) | ✅ | ✅ | ❓ ^8^ |

A daemon on Windows is currently out of scope.

**Footnotes**

- ^5^ The daemon's check on the `anet` executable path assumes POSIX paths; a Windows path (`C:\...`) cannot pass it,
  and the result is `anet_bin_unsafe_path`.
- ^6^ Be careful with this cell: a daemon on Windows registers, shows as online, receives doorbells, and is listed in
  the Dashboard's server picker, but it cannot create nodes (see ^5^); the failure only appears in the daemon's own log.
  Do not pick a Windows daemon when creating a node.
- ^7^ On earlier versions, Windows external launchers (`.cmd` files) could not be invoked directly. A fix has been
  merged ([#1137](https://github.com/sleep2agi/agent-network/pull/1137)); this cell has not been re-verified.
- ^8^ Codex co-presence on Windows has CI coverage but an intermittent failure rate of about 8%.
  See [#1342](https://github.com/sleep2agi/agent-network/issues/1342).

---

## 3. daemon lifecycle operations

### Linux

| Operation | Result |
|---|---|
| View (list nodes) | ✅ |
| Create (`create_node`) | ✅ |
| Edit (`update_node_config`) | ✅ |
| Operate (`restart_node`) | ✅ |
| Stop (`stop_node`) | ✅ |
| Delete (`delete_node`) | ⚠️ see below |

On earlier versions, `delete_node` on a stopped child node could get stuck at `lifecycle_state=deleting`, with the
Hub never converging. A fix has been merged ([#1286](https://github.com/sleep2agi/agent-network/issues/1286));
Linux has not been re-verified on a fixed version.

### macOS

| Operation | Status |
|---|---|
| daemon online (registers / SSE connected) | ✅L2 |
| Create `create_node` | ✅L2 |
| Edit `update_node_config` | ✅L2 |
| Restart `restart_node` | ✅L2 |
| Stop `stop_node` | ✅L2 |
| Delete `delete_node` | ✅L2 |

The check here is not the `ok:true` that `create_node` returns, but the node actually coming up and registering with
the Hub; edit counted only when the node's local `config.json` actually changed; delete took the "stop, then delete" path.

### macOS × Runtime (daemon creates a node)

| runtime | daemon creates a node |
|---|---|
| `claude-agent-sdk` | ✅L2 |
| `codex-sdk` | ✅L2 |
| `codex-app-server` | ❓, see ^1^ |

### Known limit: a restarted daemon may no longer create nodes

If the `anet` path the daemon needs was supplied temporarily through environment variables
(`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS`) and the daemon is restarted without them, it still registers,
goes online and receives doorbells, and the Hub still returns `ok:true` — but no node gets created, and the
daemon log shows:

```text
[WARN] anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

"Online" and "able to create nodes" are two different things. To keep the setting across restarts, write
the path into `path.conf`; see [Let the daemon actually create nodes](/en/deploy/daemon#anet-bin-pin).

---

## Related

- [Runtime install and auth](/en/guide/runtimes)
- [Keeping the Hub alive](/en/deploy/daemon)
