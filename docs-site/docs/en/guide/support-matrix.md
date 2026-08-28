# Support Matrix: which feature works on which Runtime / OS

This page answers two questions:

1. **For a given feature, does it work on each of the 7 runtimes?**
2. **On a given OS, which capabilities are available?**

## 🔴 Read this first, or you will misread the table

**There are three states, not two:**

| Mark | Meaning |
|---|---|
| ✅ | **Verified working** — measured evidence, linked in the footnotes |
| ❌ | **Verified not working** — measured evidence of failure, cause known |
| ❓ | **Not verified** — we don't know. **Not "probably works", not "probably doesn't"** |

### 🔴 A bare `✅` is a symbol that gets misread — it needs a strength

Two cells can both say ✅ and differ by two orders of magnitude in reliability.
So every ✅ carries a level:

| Level | Meaning | How to read it |
|---|---|---|
| **✅L3** | Automated suite, **runs in CI**, a regression turns it red | Depend on it |
| **✅L2** | **Verified on a real machine**, logs/report archived, **not in CI** | Works, but nothing guards the regression |
| **✅L1** | Happy path only, **never fed a bad input** | Careful — it only proves "it doesn't break when used as intended" |

A bare `✅` (no level) means nobody has annotated the strength of that cell yet — **read it as L1**.

🔴 **`❓` is the most important cell in this table.** A table with only ✅/❌ reads as "everything was
checked", when the reality is usually "some of it was checked". **Marking the unchecked cells ❓ is far
more useful than guessing** — someone who reads ❓ knows to verify it themselves; someone who reads a
guessed ✅ does not.

**Maintenance rule**: changing a cell from ❓ to ✅/❌ **requires an evidence link** (issue / test report /
PR). A state change without evidence launders a guess into a fact.

## Priority (set by Vincent, 2026-08-28)

**`codex` and `grok` families come first.** They are marked the same way in the table, but they are
scheduled first.

---

## 1. Feature × Runtime

The authoritative runtime list is the code (`OK_RUNTIMES`, see `deploy/fleet/anet-nodes-boot.sh`):
`claude-agent-sdk` · `claude-code-cli` · `codex-sdk` · `codex-app-server` · `grok-build-acp` · `grok-build-cli` · `opencode-cli`

| Feature | claude-agent-sdk | claude-code-cli | codex-sdk | codex-app-server | grok-build-acp | grok-build-cli | opencode-cli |
|---|---|---|---|---|---|---|---|
| **Create node via CLI**<br>`anet node create --runtime X` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Create node via daemon**<br>through `create_node` | ✅ | ❓ | ✅ | ❌ ^1^ | ✅ | ❌ ^1^ | ❌ ^1^ |
| **TUI co-presence**<br>human + agent share one session | — | — | — | ✅ | — | ✅ | ✅ |
| **Node-level logs**<br>`.anet/nodes/<alias>/logs/` | ✅ | ❌ ^2^ | ✅ | ❓ | ❓ | ❓ | ❓ |
| **Feishu IM direct chat** | ✅ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ | ❓ ^3^ |
| **Bad task result marked failed**<br>a bad result is not recorded as success | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ ^4^ |

**Footnotes (each one measured, not read from docs)**

- **^1^** None of the three TUI co-presence runtimes can be created by a daemon. Three separate gates
  block them; one of them, `VALID_RUNTIMES` in `create-node-daemon.ts`, is a **hard-coded constant** that
  no operator config can work around. Verified by grepping the **published artifact**
  (`@sleep2agi/agent-node@2.5.0-preview.34`), not just the source.
  → [#1298](https://github.com/sleep2agi/agent-network/issues/1298)
- **^2^** Under `claude-code-cli`, Claude Code itself hosts commhub as an in-process channel, so the
  **`agent-node` process is never started** — and node-level logs are written by `agent-node`. Its session
  records live in `~/.claude/projects/<slug>/*.jsonl`, but that is the **model-session layer with zero task
  send/receive events**; it is not a substitute.
  → [#1345](https://github.com/sleep2agi/agent-network/issues/1345)
- **^3^** The Feishu path has been verified **only on `claude-agent-sdk`**; the other six have not.
  🔴 This is not "unsupported" — it is **unknown**. The denominator does not exist yet.
  → [#1259](https://github.com/sleep2agi/agent-network/issues/1259)
- **^4^** An opencode node returned **raw un-executed `<tool_call>` text** as the task result, and the hub
  recorded `failed=false` (completed normally). **Any status/count dashboard is blind to it.** The same
  detection gap sits on `processTask`'s generic path, so it **may not be opencode-only** (unverified).
  → [#943](https://github.com/sleep2agi/agent-network/issues/943)

---

## 2. OS × capability

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| **Start a node via CLI** (`anet node start`) | ✅ | ✅ | ❓ |
| **daemon creates a node** (any runtime) | ✅ | ✅ | ❌ ^5^ |
| **daemon registers / online / receives doorbell** | ✅ | ✅ | ✅ ^6^ |
| **External launchers / `anet hub start` / self-upgrade** | ✅ | ✅ | ❌ ^7^ |
| **TUI co-presence (Codex)** | ✅ | ✅ | ❓ ^8^ |

**Footnotes**

- **^5^** `loadAndVerifyAnetBin` in `create-node-daemon.ts` requires `pin.abs.startsWith("/")`, while a
  Windows absolute path is `C:\...` and **never** starts with `/` ⇒ guaranteed `anet_bin_unsafe_path`.
  `process.platform` appears **0** times in that file — there is no platform branch at all.
  🔴 **And it is not just that one line**: the next three checks are either false-positive-prone on Windows
  (`realpathSync` vs junctions/short paths) or **vacuous** (`st.uid !== 0` — uid is constantly 0 on Windows;
  `st.mode & 0o022` does not reflect ACLs).
  → [#1290](https://github.com/sleep2agi/agent-network/issues/1290)
- **^6^** 🔴 **This cell is a trap, not good news.** A Windows daemon **registers, goes online and receives
  doorbells, but can never create a node.** The hub sees it as healthy and the Dashboard server picker
  offers it. A user who picks it gets a **silent failure in the daemon log** — the hub receives
  `ok:true` + request_id and nothing after that.
  **"We don't support platform X" is a decision; "an unsupported platform looks usable in the UI" is a defect.**
- **^7^** On Windows every external launcher is a `.cmd`, and `spawnSync` fails with ENOENT/EINVAL
  (8 call sites, `shell:true` appears 0 times). **Different root cause from ^5^**: one is a POSIX assumption
  in a path predicate, the other is the Windows process model. **Both must be fixed before Windows has a daemon.**
  → [#1137](https://github.com/sleep2agi/agent-network/issues/1137)
- **^8^** Windows Codex co-presence has CI coverage but an ~8% intermittent failure with a stable signature.
  → [#1342](https://github.com/sleep2agi/agent-network/issues/1342)

**Vincent decided on 2026-08-28: Windows is out of scope for now.** The ❌ rows above are therefore not
scheduled — but the "looks usable" defect in ^6^ **does not go away with that decision**; it needs its own
fix (report platform in daemon capability / filter in the UI / make the failure visible).

---

## 3. daemon lifecycle operations (measured on a real machine, 2026-08-28)

Result of `scripts/daemon-live-acceptance.sh --execute` on `daemon-relay` (Linux) + production hub:

| Operation | Result |
|---|---|
| View (list nodes) | ✅ |
| Create (`create_node`) | ✅ |
| Edit (`update_node_config`) | ✅ |
| Operate (`restart_node`) | ✅ |
| Stop (`stop_node`) | ✅ |
| **Delete (`delete_node`)** | **⚠️ see below** |

### Why delete is neither a plain ✅ nor a plain ❌

**2026-08-28 morning** (`agent-node@2.5.0-preview.39`): reproduced 100% of the time — the daemon
log stopped at `backed up child workdir` every single run, nothing after, and the hub row stayed
at `lifecycle_state=deleting` forever.

**2026-08-28 midday** (`agent-node@2.5.0-preview.40`, same machine): the same reproduction ran
three times, **3/3 succeeded**, the full seven-line timeline completed, and every hub row disappeared.

🔴 **That is not "fixed", because two variables moved at once:**

| Variable | Change |
|---|---|
| Code | `.39` → `.40` (instrumentation + `timeout`/`maxBuffer` on the `execSync`) |
| Process | the daemon was **restarted**, and the restart supplied `ANET_BIN_ABS` / `ANET_DAEMON_ALLOW_ENV_BIN` |

And this is a **self-clearing symptom** — measuring after a restart is structurally biased toward green.
**"Doesn't reproduce after a restart" and "the code change was correct" look identical in these three readings.**

So this cell reads **⚠️ "three non-reproductions on `.40`, root cause not located"** — not ✅, not ❌.
→ [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

### The daemon on macOS (measured 2026-08-28)

| | Status | Evidence |
|---|---|---|
| daemon **online** (registers / SSE connected) | **✅L2** | Mac Mini upgraded to `agent-node@2.5.0-preview.40` and restarted; hub side shows `11:34:27 SSE ← daemon-macmini connected` |
| the daemon's **five lifecycle operations** | **❓** | **not run on macOS today** |

🔴 **"the daemon is online" and "the daemon can do work" are two different things** — these rows stay separate.
We were caught by exactly this on Linux the same day: the daemon registered, went online, received the
doorbell, and `create_node` failed every time, reporting only in the daemon's own log.
**Do not read the ✅ on the first row as covering the second.**

**Two independent causes, both located:**

1. **Parameter name divergence**: `delete_node` / `stop_node` take `child_node_id`, while
   `restart_node` / `update_node_config` take `node_id`. Passing the wrong one is a hard `-32602`.
   → [#1281](https://github.com/sleep2agi/agent-network/issues/1281)
2. **Stop forgets the child**: the daemon deletes the `childrenMap` entry **on a successful stop**, so a
   subsequent `delete_node` reports `child not in map` and no-ops — **the hub never converges**.
   🔴 The log line `(likely daemon-restarted)` is misleading; the daemon had not restarted.
   → [#1286](https://github.com/sleep2agi/agent-network/issues/1286)

---

## 4. How to maintain this table

1. **Changing a cell requires an evidence link.** A ✅ without evidence is indistinguishable from a guess.
2. **Prefer turning ❓ into ✅/❌ over turning ❌ into ✅.** Knowing what does not work prevents more pain
   than adding one more thing that does.
3. **A new runtime starts as an all-❓ column**; fill it in cell by cell.
   🔴 Do not copy another column because "it is similar to X" — at least three cells in this table differ
   for exactly that reason.
4. The runtime list is defined by `OK_RUNTIMES` in code, **not by this document**. If they disagree, this
   document is stale — fix the document.
