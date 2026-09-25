# Support Matrix: which feature works on which Runtime / OS

This page answers two questions:

1. **For a given feature, does it work on each of the 7 runtimes?**
2. **On a given OS, which capabilities are available?**

## How to read the table

**There are three states, not two:**

| Mark | Meaning |
|---|---|
| ✅ | **Verified working** — measured evidence, linked in the footnotes |
| ❌ | **Verified not working** — measured evidence of failure, cause known |
| ❓ | **Not verified** — we don't know. **Not "probably works", not "probably doesn't"** |

Two cells can both say ✅ and still differ a lot in reliability, so a ✅ may carry a level:

| Level | Meaning | How to read it |
|---|---|---|
| **✅L3** | Automated suite, **runs in CI**, a regression turns it red | Depend on it |
| **✅L2** | **Verified on a real machine**, logs/report archived, **not in CI** | Works, but nothing guards the regression |
| **✅L1** | Happy path only, **never fed a bad input** | Careful — it only proves "it doesn't break when used as intended" |

A bare `✅` (no level) means nobody has annotated the strength of that cell yet — **read it as L1**. When you read ❓, verify it in your own environment before you depend on it.

Most readings here were measured on 2026-08-28; later releases may have changed the result, and the footnotes note the changes we know of.

---

## 1. Feature × Runtime

The 7 runtimes:
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| Feature | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| **Create node via CLI**<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Create node via daemon**<br>through `create_node` | ✅ | ❓ | ✅ | ❓ ^1^ | ✅ | ❓ ^1^ | ❓ ^1^ |
| **TUI co-presence**<br>human + agent share one session | — | — | — | ✅ | — | ✅ | ✅ |
| **Node-level logs**<br>`.anet/nodes/<alias>/logs/` | ✅ | ❓ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| **Feishu IM direct chat** | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| **Bad task result marked failed**<br>a bad result is not recorded as success | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**Footnotes**

- **^1^** When measured on 2026-08-28, creating these three co-presence runtimes through a daemon was rejected by the Hub with
  `{"ok":false,"error":"runtime_invalid","value":"codex-app-server"}`; the request never reached the target machine.
  The Hub and daemon runtime lists now both accept all 7 runtimes
  ([#1298](https://github.com/sleep2agi/agent-network/issues/1298), [#1301](https://github.com/sleep2agi/agent-network/pull/1301)),
  so this is no longer ❌; but a co-presence node created through a daemon has not been re-tested end to end, so it reads ❓.
  Also note: these three runtimes exist so a human and an agent share one TUI session, while a daemon creates an unattended background process.
- **^2^** When measured on 2026-08-28, `claude-code-cli` nodes wrote no node-level logs: in that mode Claude Code hosts commhub as an
  in-process channel, so **the `agent-node` process is never started**, and node-level logs are written by agent-node.
  The fix (a stdio proxy that also writes logs to `.anet/nodes/<alias>/logs/`) shipped in the 2026-08-28 preview batch
  ([#1345](https://github.com/sleep2agi/agent-network/issues/1345)); this table has not re-tested it, so it reads ❓.
- **^3^** The Feishu path has been verified **only on `claude-agent-sdk`**; the other six have not. This is not "unsupported" — it is **not yet verified**.
  → [#1259](https://github.com/sleep2agi/agent-network/issues/1259)
- **^4^** An opencode node returned **raw un-executed `<tool_call>` text** as the task result, and the hub
  recorded `failed=false` (completed normally), which a status/count dashboard cannot see. The same
  detection gap sits on the generic task path, so it **may not be opencode-only** (unverified).
  → [#943](https://github.com/sleep2agi/agent-network/issues/943)

---

## 2. OS × capability

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| **Start a node via CLI** (`anet node start`) | ✅ | ✅ | ❓ |
| **daemon creates a node** (any runtime) | ✅ | ✅ | ❌ ^5^ |
| **daemon registers / online / receives doorbell** | ✅ | ✅ | ✅ ^6^ |
| **External launchers / `anet hub start` / self-upgrade** | ✅ | ✅ | ❓ ^7^ |
| **TUI co-presence (Codex)** | ✅ | ✅ | ❓ ^8^ |

**A daemon on Windows is currently out of scope**; the ❌ in the Windows column is not scheduled.

**Footnotes**

- **^5^** When the daemon verifies the `anet` binary path it requires an absolute path starting with `/`, while a Windows absolute path
  is `C:\...`, so it always fails with `anet_bin_unsafe_path`; the permission checks after it do not hold on Windows either.
  → [#1290](https://github.com/sleep2agi/agent-network/issues/1290)
- **^6^** **Be careful with this cell.** A Windows daemon **registers, goes online and receives doorbells, but cannot create a node**.
  The Hub sees it as healthy and the Dashboard server picker offers it. If you pick it to create a node, the failure only shows in the
  daemon log — the Hub receives `ok:true` + request_id and nothing after that. Do not pick a daemon on Windows to create nodes.
- **^7^** Marked ❌ when measured on 2026-08-28: on Windows every external launcher is a `.cmd`, and a direct `spawnSync` fails with
  ENOENT/EINVAL (a separate root cause from ^5^). A fix was merged on 2026-08-29
  ([#1137](https://github.com/sleep2agi/agent-network/pull/1137)); this table has not re-tested it, so it reads ❓.
- **^8^** Windows Codex co-presence has CI coverage but an ~8% intermittent failure.
  → [#1342](https://github.com/sleep2agi/agent-network/issues/1342)

---

## 3. daemon lifecycle operations (measured on a real machine, 2026-08-28)

Result of `scripts/daemon-live-acceptance.sh --execute` on a Linux daemon:

| Operation | Result |
|---|---|
| View (list nodes) | ✅ |
| Create (`create_node`) | ✅ |
| Edit (`update_node_config`) | ✅ |
| Operate (`restart_node`) | ✅ |
| Stop (`stop_node`) | ✅ |
| **Delete (`delete_node`)** | **⚠️ see below** |

### Why delete reads ⚠️

- On `agent-node@2.5.0-preview.39` it hung 100% of the time: the daemon log stopped at `backed up child workdir`,
  and the hub row stayed at `lifecycle_state=deleting`.
- On the same machine, after moving to `agent-node@2.5.0-preview.40` and restarting the daemon, the same reproduction passed 3/3.
  Because the code and the process changed at the same time, those three passes alone could not prove a fix, so it was marked ⚠️.
- The root-cause fix for "stop, then delete" has since been merged ([#1286](https://github.com/sleep2agi/agent-network/issues/1286)); this table has not re-tested it on Linux.

### The daemon on macOS (measured 2026-08-28)

Mac mini (macOS 26.3.1) + `agent-node@2.5.0-preview.40`, run end to end:

| Operation | Status | What was checked (**not** the `ok:true` that `create_node` returns) |
|---|---|---|
| daemon online (registers / SSE connected) | **✅L2** | hub side `11:34:27 SSE ← daemon-<host> connected` |
| **Create** `create_node` | **✅L2** | four daemon log lines: `wrote child config` → `spawned pid=79490` → `post-spawn kill-0 verify OK` → `+5000ms capability check OK`; child registered and reporting on the hub |
| **Edit** `update_node_config` | **✅L2** | the check is the **node-side file**: `model` actually changed in `~/.anet/nodes/<alias>/config.json` |
| **Restart** `restart_node` | **✅L2** | `ok, apply_mode=restart_only` |
| **Stop** `stop_node` | **✅L2** | four instrumentation lines + process gone |
| **Delete** `delete_node` | **✅L2** | `delete without map entry (expected after stop)` → `backed up child workdir` → hub row `node_not_found`, original dir moved away |

The delete row took the "stop, then delete" path and passed first try on macOS + `.40`.

### macOS × Runtime (measured 2026-08-28)

| runtime | daemon creates a node | Evidence |
|---|---|---|
| `claude-agent-sdk` | **✅L2** | all six steps above |
| `codex-sdk` | **✅L2** | four spawn-verification lines + child registered on hub + full delete chain (`ack accepted action=delete`) |
| `codex-app-server` | **❓** | rejected by the Hub with `runtime_invalid` at the time; that restriction has since been lifted and not re-tested (see footnote ^1^) |

### Restarting a daemon can cost it the ability to create nodes (reproduced on Linux and macOS)

Hit once on each platform on 2026-08-28, identical log shape:

```text
← SSE create_node cr_…
[WARN] anet_bin_unsafe_path: no ANET_BIN_ABS resolved from /etc/anet-daemon/path.conf
```

After a restart with `anet daemon start` the daemon **registers, goes online, receives the doorbell,
and the Hub returns `ok:true`** — but **it cannot create a single node**, because the `ANET_BIN_ABS`
family it depends on is not persisted and is lost on restart.
**"The daemon is online" does not mean "the daemon can create nodes"** — read those rows separately.

**The persistent form is `/etc/anet-daemon/path.conf`** (survives restarts);
`ANET_DAEMON_ALLOW_ENV_BIN=1` + `ANET_BIN_ABS=<realpath>` is only for Docker/dev/manual ops and **a restart will not carry it over**.

**The two delete failure causes located at the time:**

1. **Parameter name mismatch**: `delete_node` / `stop_node` take `child_node_id`, while
   `restart_node` / `update_node_config` take `node_id`. Passing the wrong one is a hard `-32602`.
   → [#1281](https://github.com/sleep2agi/agent-network/issues/1281)
2. **Stop forgets the child**: the daemon dropped its internal record of the child on a successful stop, so a
   subsequent `delete_node` reported `child not in map` and did nothing; the Hub never converged.
   → [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

---

## 4. How to maintain this table

1. **Changing a cell requires an evidence link** (issue / test report / PR).
2. **A new runtime starts as an all-❓ column**; fill it in cell by cell, and do not copy another column because "it is similar to X".
3. The runtime list is defined in code (`OK_RUNTIMES`, see `deploy/fleet/anet-nodes-boot.sh`). If they disagree, this document is stale — fix the document.
