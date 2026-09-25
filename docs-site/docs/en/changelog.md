# Changelog

User-facing changes, newest first. To see which version a channel points to right now: `npm view @sleep2agi/agent-network dist-tags` (same for `agent-node` and `commhub-server`). Full release notes for every npm version are in the repository's [`docs/tests/release-v<version>.md`](https://github.com/sleep2agi/agent-network/tree/main/docs/tests); desktop notes are at [agent-network-app releases](https://github.com/sleep2agi/agent-network-app/releases).

## Node visibility: rules files, skills, project folder — preview (2026-09-23 to 09-25)

Coordinated release: `commhub-server@0.9.0-preview.56–.60`, `agent-node@2.5.0-preview.85–.88`, `agent-network@2.3.0-preview.110–.115` (`agent-node@.84` never became visible on npm and is superseded by `.85`).

- **Read-only project folder browsing** (#1999): new hub tools `list_node_files` / `read_node_file` let you walk a node's working directory level by level and view text files (≤256 KiB). Credential-like files (`.env*`, private keys, `auth.json`, …) are listed by name only; paths and symlinks cannot escape the working directory; node tokens cannot start a browse. Requires hub `.59` + agent-node `.88` (or anet `.115`) + desktop 0.2.94
- **Read-only node skills** (#1984): `list_node_skills` / `read_node_skill` list skills from where each runtime (codex / grok / opencode / Claude Code) actually loads them, and read SKILL.md
- **Claude Code sessions can have CLAUDE.md read/written remotely** (#1977): `read_node_rules_file` / `write_node_rules_file` gain an `alias` parameter that can target a session without a node row; running sessions must be restarted on anet `.111` to report the capability
- **Staged content is cleaned up** (#2001, hub `.60`): rules files, SKILL.md and file-read results are cleared 60 s after the requester fetches them, unfetched content after 24 h, and rows are deleted after 30 days; the first run after deploy clears all content older than 24 h in one pass
- **Pickups resolve by the token's bound node** (#1994, hub `.58`): when an alias has several rows, rules-file / config-update requests no longer go to a stale row and wait 60 s for nothing
- **Steadier codex-app-server startup** (#1988 / #1989 / #1991): new `ANET_QUEUE_TIMEOUT_MS` (queue deadline) and `ANET_CODEX_RESUME_TIMEOUT_MS` (startup session resume, default 120 s, one retry on timeout); a failed resume reports offline to the hub before exiting, so the hub no longer shows a dead node as idle; an unbound legacy token now only disables outbound reconciliation instead of stopping inbox compensation too
- **Daemons can still create nodes after a reboot** (#1976, anet `.110`): daemons started through `anet node start/restart` or the boot sweep also pin the anet binary, ending the "online but cannot create nodes" state

---

## Desktop 0.2.85–0.2.97 (2026-09-24 to 09-25)

Signed updates for macOS (Apple Silicon) and Windows (x64).

- **Look**: a quieter palette and hierarchy (surfaces separated by tone, text contrast ≥4.5:1); thin scrollbars that appear on hover; long code, hashes and URLs wrap inside chat bubbles
- **Redesigned node page** (0.2.87–0.2.88): header card plus section bar (Overview / Model & runtime / Rules file / Skills / Tasks / Danger zone); tasks grouped into In progress, Queued, Possibly stuck and Recently finished; centered layout on wide windows
- **Rules-file editor** (0.2.85–0.2.93): shown for Codex / OpenCode / Claude nodes; a rendered Read mode by default, full-screen view with a heading outline, double-click a passage to jump to its source in the editor; periodic refresh no longer wipes unsaved edits; an agent-node that is too old is reported with the required version instead of a 60 s wait
- **Skills and project folder**: read-only Skills section (0.2.87) and project-folder browsing (0.2.94), with a clear upgrade hint when versions are too old
- **Unread and notifications**: the macOS menu-bar unread count now clears and the panel is no longer capped at 20 conversations (0.2.92); a "New messages" group at the top of the node list (0.2.95)
- **Find and replace in rules files** (0.2.97): `Ctrl+F` / `⌘F` works in Read, Edit and full screen with jumps between matches; Edit mode can replace, changing only the draft until you save; a read now always shows content or a reason within 90 s, and stale content is no longer shown as an editable empty file
- **New Grok nodes default to ACP mode** (0.2.97): co-presence moves under Advanced and is marked experimental
- **Other**: Settings → About update checks always end in a visible result (0.2.88); in full-screen reading, macOS traffic lights and Windows caption buttons are no longer covered (0.2.96); the Grok TUI co-presence runtime is labelled Preview in the wizard

---

## Queue correctness and runtime fixes — preview (2026-09-22 to 09-23)

`agent-node@2.5.0-preview.76–.83`, `agent-network@2.3.0-preview.100–.109` (`.102` is void on npm and superseded by `.103`).

- **The codex queue no longer runs work twice or late** (#1939 / #1945): every terminal path removes the local queue row; queued rows ask the hub before dequeue, so tasks already acknowledged or finished no longer start a turn
- **grok-build-acp really uses the configured model** (#1961): the model is passed at launch and read back via `session/set_model`; a mismatch fails before any prompt, and the hub shows the model actually in effect
- **Explicit codex binary selection** (#1971): order is `codexBin` config → `ANET_CODEX_BIN` → a PATH `codex` no older than the bundled one → bundled; the startup log prints path and version. Fixes clean installs whose bundled codex was too old for newer models ("requires a newer version of Codex"). #1974 stops the false reasoning-tier warning on newer codex
- **opencode co-presence survives a remote model change** (#1950 / #1964 / #1966): restart no longer refuses on its own previous generation's `ANET-COMMHUB.md`; the old attach TUI is stopped precisely and the new session is re-attached in the same tmux pane
- **`anet node codex fork` gains five fixes** (#1954, anet `.104`): creates a missing `--workdir`, rewrites the project table header, `--model` override with a mismatch warning, pre-probes a free port, carries `AGENTS.md` along
- **grok co-presence marked Preview** (#1968): `anet setup`, `anet node create` and the docs label `grok-build-cli` as Preview and point to the stable `grok-build-acp`; the refusal for an unverified grok binary now includes a copy-paste `GROK_BINARY=… anet node start` recovery command

---

## Shared codex login detection + long-turn observability — preview (2026-09-19 to 09-20)

`agent-node@2.5.0-preview.73–.75`, `agent-network@2.3.0-preview.97–.99`.

- **Nodes sharing one codex login are named** (#1920 / #1928 / #1931): at startup a refresh-token fingerprint check warns and lists the other nodes sharing the login (warn only, never refuses to start). The check runs inside agent-node, so directly launched nodes are covered, and comparison is host-wide (`~/.anet/codex-auth-fingerprints/`). Use anet `.99` + agent-node `.75` for the complete behavior
- **Named refresh-failure causes**: `rotation-conflict` (the token was already used by another node; log in once again) and `token-endpoint-unreachable` (egress cannot reach the token endpoint) are reported separately; the message explicitly says not to copy another node's `auth.json`
- **Long-turn heartbeat** (#1919): grok nodes write an `in-flight: … elapsed=… last=…` line every 30–60 s during a turn, so "quiet" and "stuck" are distinguishable
- **Less stderr noise**: known-benign grok stderr is folded into one INFO line per turn instead of flooding WARN
- **`ANET_LOG_LEVEL`**: a new `ANET_`-prefixed log-level variable; invalid values warn once (a mistyped `LOG_LEVEL` used to fall back to info silently)

---

## Attachments, cross-WAN node start, clearing unread — preview (2026-09-14 to 09-17)

`commhub-server@0.9.0-preview.54–.55`, `agent-node@2.5.0-preview.69–.72`, `agent-network@2.3.0-preview.90–.96` (`.94` never became visible on npm and is superseded by `.95`).

- **Local file links in replies become attachments** (#1869 / #1876): any runtime can write `[name](/absolute/path)` in a reply and the desktop shows a downloadable attachment card; files that cannot be uploaded are annotated with the reason (outside the workdir/home, over 12 MB, …); `attachments` passed as a string on claude-code-cli nodes is no longer dropped
- **Cross-WAN hubs are no longer misjudged** (#1882): the hub health probe in `anet node start` defaults to 10 s for non-loopback hubs, overridable with `ANET_HUB_HEALTH_TIMEOUT_MS` (1000–60000)
- **Gzip hub responses** (#1897, hub `.54`): JSON/text responses ≥1 KB are compressed on request and `/api/status?light=1` truncates task text, making node lists and chat history much smaller on slow links
- **Mark an agent read in one call** (#1909, hub `.55`): `POST /api/messages/ack` accepts `{ "agent": "<alias>" }` to clear all unread from that agent (used by desktop 0.2.73+)
- **Finished tasks are not re-run** (#1902): serial queues check task state before dequeue; replied/closed tasks are only acked, never started
- **claude-code nodes drain the inbox** (#1901): each new-task event fetches the whole backlog, so the 6th message onward no longer waits for the next event
- **opencode co-presence reply ownership** (#1912): long turns that went through context compaction are no longer rejected as "not owned" with the answer dropped; when still rejected, the answer is attached to the error
- **The co-presence identity reaper only targets its own process tree** (#1872): unrelated processes that inherited a node marker are no longer killed as a previous generation; two common grok co-presence startup failures now include recovery commands (#1882 / #1888); `anet grok --help` lists the `model` subcommand (#1886)

---

## Desktop integration and the Codex lifecycle controller — preview (2026-09-06 to 09-10)

`commhub-server@0.9.0-preview.50–.53`, `agent-node@2.5.0-preview.67–.68`, `agent-network@2.3.0-preview.86–.89`.

- **`anet node codex` lifecycle commands** (#1856, anet `.89`): read-only `preflight` / `verify`; deterministic `start` / `restart` / `resume` with rollback on failure; `fork` a new node that inherits history; `account register|list|install` and `rollback` for logins; sequential `canary`. Plus `anet node edit --workdir`
- **Reply attachments land in the right bubble** (#1824, hub `.50`): an agent's reply attachments no longer render under the asker's bubble or overwrite the asker's own attachments
- **Authoritative per-agent unread counts** (#1838, hub `.51`): `GET /api/messages?scope=user` returns `unread_by_agent` / `unread_total`, and acks sync across devices
- **The wizard shows why node creation failed** (#1843, hub `.52`): new `GET /api/node-create-requests?request_id=` surfaces the daemon's error directly
- **OpenCode co-presence on macOS** (#1847 / #1848 / #1849): package identity check, launch isolation and process identity now support darwin (Windows still unsupported)
- **`provider/model` model names allowed** (#1853): hub and daemon both accept a single slash, so the wizard can create nodes with `opencode/…` models

---

## Co-presence and CLI reliability — preview (2026-09-03 to 09-04)

`commhub-server@0.9.0-preview.46–.49`, `agent-node@2.5.0-preview.59–.66`, `agent-network@2.3.0-preview.77–.85`.

- **Standard MCP clients get the tool list again** (#1763, hub `.46`): `tools/list` no longer throws `schema._zod`, so Claude Code MCP configs, Inspector and similar clients can list tools
- **`blocked` has a way out** (#1793, hub `.47`): a node returns to `idle` after sending a terminal reply or dispatching a task; internal hub errors now return the real error message to MCP callers (#1801)
- **grok co-presence stops timing out task after task** (#1774 / #1775 / #1776): the verified grok binary is pinned; a missing `turn_ended` is abandoned after a bounded wait; a half-typed TUI input left idle for 10 minutes yields to queued work. Stopping no longer leaves 5 placeholder files behind (#1784 / #1817)
- **No more duplicate replies from co-presence nodes** (#1770): the model's own extra messages to the task sender are rewritten into non-push progress reports (requires anet `.77` + agent-node `.62`, and a node restart)
- **CLI**: `anet node start` refuses a second session for a running node (#1804); prefers the agent-node installed beside anet (#1813); `anet node edit` supports `--runtime` / `--model`; `--force` / `--yes` no longer swallow the next argument; agents can send files via `attachments` (#1186); grok co-presence can start on Mac / Windows (with a reduced-isolation notice)
- **Richer roster data**: claude-code nodes report telemetry and model (#1787 / #1799); handover reports no longer wipe version and telemetry (#1810); codex co-presence readiness is probed by port and becomes ready in seconds (#1798)
- **Delegation false positives fixed** (#1805): "let/ask X …" patterns only count as delegation at the start of a sentence or line, so mentioning another node in prose no longer creates phantom tasks

---

## agent-network 2.3.0-preview.76 promoted to latest (2026-09-02)

`npm i -g @sleep2agi/agent-network` now installs `2.3.0-preview.76` by default. It includes all CLI improvements through 2026-09-02, notably the error-message, help and layout fixes in the 08-29 to 09-02 entries below.

---

## agent-node 2.5.0-preview.58 promoted to latest (2026-09-02)

The `latest` tag of `@sleep2agi/agent-node` points to `2.5.0-preview.58`, which supports remote node rules-file read/write. `commhub-server`'s `latest` did not move in this period (still `0.9.0-preview.30`); install `preview` for the newer hub capabilities.

---

## Remote node rules files + CLI wording overhaul — preview (2026-09-02)

Coordinated release: `commhub-server@0.9.0-preview.45`, `agent-node@2.5.0-preview.58`, `agent-network@2.3.0-preview.76`.

- **Node rules files** (#1755): the desktop can read and write a node's `CLAUDE.md` / `AGENTS.md` remotely; the hub adds `read_node_rules_file` / `write_node_rules_file` and related tools; nodes only read/write inside their own working directory and the chain has no path parameter
- **Did-you-mean and subcommand help**: mistyped commands such as `daemon` get the right suggestion; `anet goal/token/batch/opencode/network/channel/session --help` print their own help
- **Unknown node names get close matches**, with separate messages for "no nodes", "similar names exist" and "no similar names"
- **Table layout**: CJK aliases, long runtime names and multi-line task text no longer skew `node ls` / `status` / `tasks`; `anet demo` no longer prints literal color codes
- **Time and diagnostics**: hub timestamps are labelled UTC with a relative age; `anet doctor` says what each check measures, lists actual runtime CLI versions, and no longer reports zero nodes as an error

---

## Node-creation capability made visible + grok co-presence UX — preview (2026-08-30)

`commhub-server@0.9.0-preview.43–.44`, `agent-node@2.5.0-preview.53–.57`, `agent-network@2.3.0-preview.68–.75`.

- **Whether a daemon can create nodes is now obvious** (#1545): `anet daemon list` reports create capability in five distinct messages with when it was measured; the hub checks the daemon's reported capability before dispatching `create_node` and explains refusals (#1510 / #1511 / #1588)
- **`anet daemon restart <name>`** (#1601, anet `.74`): restart a daemon in one command; if it fails to come back, it says clearly that the daemon is now stopped and how to retry (#1616)
- **grok co-presence**: `anet grok attach` uses the alternate screen and restores your terminal on detach (#1514); the recovery TUI shows grok's real output when it exits (#1518); leaderless builds such as grok 1.0.5 are no longer permanently reported `blocked` (#1609)
- **Errors point the right way**: a 401 is no longer called "cannot reach hub" (#1581); `anet daemon start` warns when grok is installed but not on the daemon's PATH (#1586); grok not found distinguishes not-on-PATH / not executable / failed to start (#1582); the `anet_bin_source` fix command now actually runs (#1521)
- **`anet status` no longer shows stuck/errored nodes as working** (#1577); Feishu channels are refused on non-claude-agent-sdk nodes (#1575)
- **`anet node stop`** no longer reports failure because of a leftover socket path with no listener (#1526)

---

## grok co-presence fixes, Windows support, persistent desktop messages — preview (2026-08-29)

`commhub-server@0.9.0-preview.39–.42`, `agent-node@2.5.0-preview.44–.52`, `agent-network@2.3.0-preview.60–.67`.

- **grok co-presence TUI**: immediate notice when a slash command is blocked (#1404); a clean `/model <id>` is executed on your behalf (#1408); no more black screen after attach (#1412); switching models no longer crashes the node (#1416)
- **Windows works** (#1137 / #1489 / #1494 / #1504): `anet` can launch npm/npx and other external launchers, and the daemon can fork nodes on Windows without children crashing on a missing `HOME`. Upgrade both anet `.66` and agent-node `.51` or later
- **Desktop messages are no longer lost** (#1481 / #1485 / #1488): `send_desktop_message` persists before pushing; new `GET /api/messages?scope=user` and `POST /api/messages/ack` with unread counts and token-shaped strings masked on read
- **Nodes start on machines without a non-loopback IPv4** (#1498 / #1506): the hub accepts `host.ip = null`, and nodes retry without optional telemetry on a schema mismatch
- **The daemon is a pure program again** (#1418): free-text tasks no longer invoke an LLM; only structured lifecycle commands run. stop/start/delete doorbells are replayed after SSE reconnect (#1450)
- **Security**: node deletion cleans the real working directory and no longer leaves node credentials behind (#1478; on machines where cwd ≠ home, check `.anet/nodes/` manually for nodes deleted before upgrading)
- **CLI**: `anet node create --resume` infers `claude-code-cli` (#1420); the interactive wizard shares the named path's environment checks (#1473); `--copresence` startup failures name the failing step and log paths (#1500)

---

## Reliability sprint: stop/delete convergence + node logs + timeout guard — preview (2026-08-28 evening)

Coordinated release: `commhub-server@0.9.0-preview.36–.38`, `agent-node@2.5.0-preview.40–.43`, `agent-network@2.3.0-preview.54–.59`.

- **create_node doorbell compensation** (#1362, absorbing #1364): doorbells missed during an SSE outage are no longer lost forever — on reconnect the daemon calls the new hub tool `list_my_pending_create_requests` and replays them (`.38`/`.43` pair)

- **stop/delete convergence** (#1286 trio): daemon-side ack tracing, hub-side six-exit instrumentation for `ack_stop_request`, stuck `deleting` rows re-dispatchable with `force` (5-minute staleness criterion)
- **claude-code-cli node logs** (#1345): the stdio proxy now mirrors every log line into `.anet/nodes/<alias>/logs/` (UTC-dated files) — per-alias node logs exist for this runtime for the first time; includes a stop-race guard (a torn-down node dir is never resurrected)
- **callCommHub timeout** (#1357): 30s `AbortSignal.timeout` — a hung hub can no longer silently swallow doorbells
- **daemon capability visibility**: `runtimes_supported` widened to 7 (#1376), four-class creation-failure codes (#1377), hub `lifecycle_controllable` flag (#1374) pairing with desktop button disabling (app#197/#200 — the three TUI co-presence runtimes join the create wizard, zero-key, following the host login)
- **agent-initiated push**: `send_desktop_message` documented (guide/channels)

---

## Exact BTW task boundary — Hub preview (2026-08-28)

`commhub-server@0.9.0-preview.34` adds optional `thread_id` / `turn_id` fields to task records and returns them through REST and MCP task projections. The Hub accepts a boundary only when the consuming node reports it for an owned task without conflict. Older nodes and historical tasks remain compatible; absent boundaries stay explicitly absent and are never guessed or backfilled. The paired `agent-node@2.5.0-preview.39` and `agent-network@2.3.0-preview.53` will follow after the Hub is published, in dependency order.

---

## Durable Codex co-presence and safe teardown — preview (2026-08-26)

This paired preview release is `agent-network@2.3.0-preview.46` / `agent-node@2.5.0-preview.34` / `commhub-server@0.9.0-preview.30`. The Hub adds immutable node cursors and a monotonic terminal journal for durable recovery after a missed SSE notification, while task delivery returns the network-authorized `actual_to`. Codex co-presence keeps one bridge and a shared `CODEX_HOME` plus thread/history; `node stop` now converges the managed app-server, bridge, and TUI resources. Linux and protected Windows Codex 0.148 gates cover upgrade recovery, active-turn steering, and history preservation.

---

::: info Versioning note
This log runs reverse-chronologically. **The version scheme was reshuffled once**:
- **From 2026-05 onward**: gradual v0.6 → v0.7 → v0.8 → v0.9 → v0.10 → v0.11 releases; the `v0.X.Y` format mirrors `commhub-server`'s `0.X.Y` semver style.
- **Before 2026-04**: used `v1.0.0-preview.N` / `v2.1` style version numbers that overpromised. Deprecated.
- **Current stable**: whatever npm's `latest` tag points to (see [Versioning](/en/guide/upgrade#channels) — npm `latest` is authoritative); v0.8.1 was the first Apache 2.0 OSS release.
- **Current preview**: follow npm's `preview` dist-tag. Both `latest` and `preview` now include `grok-build-cli` and `anet grok attach` (experimental; `grok-build-acp` remains the default recommendation); see the [Grok nodes](/en/guide/grok#copresence).
- Entries for v0.9.2 and earlier (including v1.0.0-preview / v2.1 / v0.x) are linked under [Older releases](#older) at the end of this page.
:::

## Grok Co-presence TUI (`grok-build-cli`) — preview (2026-07-15) 🟡 preview

::: danger Correction — 2026-07-31
The section below records a candidate milestone. Its installation and usage commands are as written at the time; do not copy them. `grok-build-cli` / `anet grok attach` later shipped in the npm packages (experimental); for the current status and usage see the [Grok nodes](/en/guide/grok#copresence).
:::

**Version sync** (npm `@preview` tag):
- `@sleep2agi/agent-network@2.3.0-preview.23`
- `@sleep2agi/agent-node@2.5.0-preview.21`

> Note: `preview.2`–`preview.22` were incremental iterations (see git history); this entry records the **co-presence milestone**.

### 🌟 Highlights

#### Grok co-presence: attach to the real Grok TUI held by the agent-node

New `grok-build-cli` runtime + `anet grok attach <alias>`: you and CommHub network tasks **share one Grok session** — network tasks render live in the terminal, reply back to the originator, and you can watch and type alongside.

```bash
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared        # wait for: attach with anet grok attach grok-shared
anet grok attach grok-shared       # Terminal 2, real TTY, same machine/user/project dir
```

Constraints: Linux only, exact `grok 0.2.93 (f00f96316d)`, fixed text-only `[todo_write]` profile (no fs/shell/network/MCP tools), trusted Hubs only, **preview (not latest/production)**. Full usage and caveats: [Grok Co-presence TUI](/en/guide/grok).

---

## opencode-cli — the 5th Runtime (RFC-029) — preview (2026-07-09) 🟡 preview

New `opencode-cli` runtime: use the public [sst/opencode](https://github.com/sst/opencode) CLI as a **multi-vendor front-end** (unified session / auth abstraction) — anet's 5th runtime. **Preview channel only (RFC-029 in progress) — not yet in npm `latest`**: after installing latest, the `anet node create` picker shows only the 4 formal runtimes (`claude-code-cli` / `claude-agent-sdk` / `codex-sdk` / `grok-build-acp`); it lands in latest once stabilized.

### 🌟 Highlights

- **`anet node create --runtime opencode-cli`** (preview channel): the interactive `anet node create` wizard is now a **5-way picker** (opencode-cli added; npm `latest` is still 4-way).
- **Vendor preset**: after picking the runtime, choose an `anthropic` (reads `ANTHROPIC_API_KEY`) or `openai` (reads `OPENAI_API_KEY`) preset — the key is read from env, not prompted.
- **Parent-mediated model**: same as `codex-sdk` — opencode runs as a pure LLM worker; the commhub SSE / inbox / reply roundtrip is handled by the agent-node parent process (no commhub MCP server on the opencode side).
- **Version pin**: spawns the local `opencode` CLI at a fixed `opencode-ai` version pin (the first `anet node create` prompts `npm i -g opencode-ai@<pin>`); the free-model keyless path passed full e2e (2026-07-09).

Usage and comparison: [Node Runtime — Five runtimes](/en/guide/runtimes); design: [RFC-029](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-029-opencode-runtime-integration.md).

---

## v0.11-preview2 — **`/loop` works for every runtime + security batch + RFC-024 hub config-apply foundation** (2026-06-28) 🟡 preview

**Version alignment** (npm `@preview` tag, three packages in sync):
- `@sleep2agi/agent-network@2.3.0-preview.1` ← bumped (CLI: new `anet node loop` subcommand)
- `@sleep2agi/agent-node@2.5.0-preview.1` ← bumped (runtime: `/loop` works across all runtimes)
- `@sleep2agi/commhub-server@0.9.0-preview.1` ← bumped (hub: security batch + RFC-024 PR A)

`PINNED_SERVER_VERSION` updated to `0.9.0-preview.1` — `anet hub start` lazy-fetches the matching hub binary automatically.

### 🌟 Highlights

#### `/loop` now works for every runtime

Before preview2, the `/loop` self-scheduler only ran for the `claude-code-cli` runtime; agent-node-driven runtimes (`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`) **silently skipped** goal ticks. preview2 removes that runtime-bucket skip — every runtime can now drive a `/loop` goal end-to-end.

Plus: **new `anet node loop` CLI** to manage goals from outside the agent — set / list / cancel a node's running `/loop` jobs without entering an interactive session.

```bash
anet node loop my-codex "monitor PR #271" --every 5m
anet node loop researcher "scan twitter for grok updates" --every 30m
anet node loop daily-bot "post the morning summary" --every 2h
```

Full usage + trigger mechanics: [Agent Node — Loop scheduler](/en/guide/agent-node#recurring-tasks-the-loop-scheduler) (ZH + EN parity).

### 🔒 Security batch

Four cross-tenant / data-integrity gaps closed for public-hub multi-user / multi-network deployments:

- **Cross-tenant write guards** ([#287](https://github.com/sleep2agi/agent-network/issues/287), RFC-024 PR A): 4 new MCP tools (`update_node_config` / `get_config_update` / `ack_config_update` / `restart_node`) gate every write by `node.network_id == caller.effectiveNetId`, mirroring the [#275](https://github.com/sleep2agi/agent-network/issues/275) pattern. `report_status` upsert no longer lets a node row cross networks. SQL-layer trust root protected by the `upsertNodeWithSec1Guard` helper + 5 real-driver regression tests + 6 inline-mirror tests
- **`retention sweep` + incremental VACUUM** ([#282](https://github.com/sleep2agi/agent-network/issues/282)): hub sweeps old task / inbox rows on a background schedule; the `agent_telemetry` index is split so the periodic READ doesn't write-amp. Multi-tenant deployments see steadier CPU
- **Read-path stale-marker fix** ([#283](https://github.com/sleep2agi/agent-network/issues/283)): sessions stale-mark moved off the read path to a single background sweeper — `/api/status` is no longer a write-amp call
- **Password KDF strengthening** ([#285](https://github.com/sleep2agi/agent-network/issues/285)): scrypt path gets a verified-modern parameter set, backwards-compatible (existing hashes still verify; new hashes use the stronger params)

### Engineering hardening

- **`superviseChild()` shared helper** ([#284](https://github.com/sleep2agi/agent-network/issues/284)): the `connectFeishu` + `connectSSE` supervisor logic (while-loop respawn + jittered backoff + stable-uptime reset + shutdown gate + abandon-after-timeout) extracted into one helper. Two intentional `connectSSE` improvements landed alongside (±25% jitter to defend against thundering-herd reconnects after a hub restart; backoff no longer resets on a raw HTTP 200 — only on the SSE `"connected"` event — fixes a hot ~1s reconnect loop)
- **RFC-024 hub config-apply foundation** ([#287](https://github.com/sleep2agi/agent-network/issues/287)): the 4 MCP tools + schema (`nodes.config_revision` / `nodes.config_snapshot` / `node_config_updates` table) land in preview2. Dashboard 改配置真生效 is the consumer side (PR B + PR C); those merge in a follow-up preview2.x / preview3

### Not in preview2 yet

- RFC-024 PR B (agent-node config-apply runtime + W1 supervisor) — separate [PR #290](https://github.com/sleep2agi/agent-network/pull/290), depends on PR A (which IS in preview2). Queued for preview2.x / preview3
- Dashboard 改配置 end-to-end — PR C is a 1-line constant swap in `sleep2agi/agent-network-dashboard`; fires after PR B merges

### Install / Upgrade

**Clean install (new user)**:
```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.1
npm install -g @sleep2agi/agent-node@2.5.0-preview.1
npm install -g @sleep2agi/commhub-server@0.9.0-preview.1
```

**Upgrade (existing user tracking the preview channel)**:
```bash
anet upgrade --channel preview
```

Restart any running nodes so they pick up the new runtime:
```bash
anet node stop <alias>
anet node start <alias>
```

Full upgrade workflow + cross-version migration → [Upgrade Guide](/en/guide/upgrade).

---

## v0.10.15 — **Wave 2 CLI UX polish (9 items)** (2026-06-10) ✅ stable

**Version sync** (npm `latest` tag): CLI-only release — no agent-node / commhub-server change, no PINNED bump, no hub/runtime restart needed.
- `@sleep2agi/agent-network@2.2.12` ← bumped (from 2.2.11)
- `@sleep2agi/agent-node@2.4.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.5` ← unchanged (PINNED)

### 🌟 Highlights

#### Trustworthy `anet hub status` (P1.1 / #214 F7-04)

In containers (node:24-slim, alpine…) without `lsof`, the old build falsely reported "Hub not running" even when `/health` returned 200, and busybox `lsof` streamed fd numbers as PIDs, rendering 60+ junk entries. Fix (commit `d33bbfc`): `/health` is now the ground truth (no more false negatives); the PID list is sanity-filtered and folds to "top-3 + count" when >5; three clear states (healthy / port-held-but-unhealthy / not-running), each with the right hint.

#### Did-you-mean command correction (P1.2 / #214 F7-02/10/11)

Typos within Levenshtein distance ≤2 get an auto-suggestion instead of a 50-line help dump. Wired into the top-level, `anet node`, and `anet project` default branches:

```
$ anet creat
Unknown command "creat". Did you mean: anet create?
```

#### `anet node restart <alias>` (P1.3 / #173)

Symmetric with `anet project restart` / `anet batch restart` — restart a single node without typing stop + start.

#### `-V` and `anet help` aliases (P1.4 / #192)

`-V` (uppercase, cargo/git/docker convention) equals `-v` / `--version`; `anet help` (no dash) equals `--help` / `-h`.

### 🐛 Bugs Fixed

- **#214** hub status PID list corruption (container lsof streamed-fd pollution)
- **#214** hub status falsely "not running" (`/health` 200 but lsof unavailable)
- **#214** no hint on mistyped commands (F7-02/10/11)

### 📦 Install

```bash
npm i -g @sleep2agi/agent-network@latest
anet --version          # agent-network v2.2.12 ⬆
```

---

## v0.10.14 — **Reply reliability / dispatch dedup / idle timeout / `--help` safety** (2026-06-10) ✅ stable

**Version sync** (npm `latest` tag):
- `@sleep2agi/agent-node@2.4.10` ← bumped (from 2.4.9)
- `@sleep2agi/commhub-server@0.8.5` ← bumped (from 0.8.4, PINNED realigned)
- `@sleep2agi/agent-network@2.2.11` ← bumped (from 2.2.10)

### 🌟 Highlights

#### #168 Reply reliability (codex / claude / grok — all runtimes)

**Symptom**: a node wrote its output to `/tmp` on time, but the completion reply never reached the dispatcher — operators only saw "idle / no output" and had to `ls /tmp` by hand. Root cause was in the shared `agent-node` callCommHub + sendReply + processInbox chain, not runtime-specific. Fix (commit `5b61d1c`): new `reply-reliability.ts` (`CommHubError` typed class + `classifyCommHubResponse` classifier for success/retryable/appLevel + a disk-persisted idempotent `PendingReplyQueue` that survives restarts and keeps an attempts counter); `processInbox` reworked to drain-pending → inflight guard → process → persist + send + clear-on-success → ack. 20 new test cases (bun test 111 pass / 0 fail, zero schema change). Server side (#216): `send_reply` now has three-way semantics — `not_found` not stored / `offline` stored as explicit `queued` / structured error — fixing the earlier false-positive `ok:true`.

#### #212 Dispatch dedup (commhub-server guardrail)

Server-side dedup per `(from, to, content-hash)`, 5-min default window, in-memory with zero schema change (commit `1f3ae1e`). When an agent retries or a user double-fires the same prompt, only one passes within the window. Tunable via `COMMHUB_SEND_DEDUP_WINDOW_MS`.

#### idle timeout + `--help` safety

The remaining two of the four: node idle-timeout handling, and safer `--help` output.

### 📦 Install

```bash
npm i -g @sleep2agi/agent-network@latest @sleep2agi/agent-node@latest
anet --version          # agent-network v2.2.11 ⬆
agent-node --version    # agent-node v2.4.10 ⬆
```

---

## v0.10.13 — **`grok-build-acp` `session/prompt` 300s timeout hang fix (P0 hotfix)** (2026-06-08) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-node@2.4.9` ← bumped ([#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — ACP `handleServerRequest` non-integer error-code coerce fix)
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged (PINNED)

### 🌟 Highlights

#### Root cause + fix for `grok-build-acp` nodes hanging at `session/prompt timed out after 300000ms`

**Symptom**: A `grok-build-acp` runtime node accepts a second task, hangs for ≈5 min, then agent-node reports `grok ACP request 'session/prompt' timed out after 300000ms`. an ai-insight user's Grok node (grok 0.2.29 alpha) captured the exact 2026-06-07 19:53:09 log:

```text
ERROR failed to parse incoming message: invalid type: string 'ENOENT',
expected i32 at line 1 column 48.
Raw: {'jsonrpc':'2.0','id':5,
      'error':{'code':'ENOENT',
               'message':'ENOENT: no such file or directory, open ...'}}
```

**Root cause**: ACP server-request responses (e.g. a failed `read_file`) carry a JS-native string error code like `'ENOENT'`, but the Grok agent's protocol requires `code` to be an i32 integer. The old agent-node passed the string straight through → Grok agent parse failure → undefined state → hang until the client-side 300 s timeout.

**Fix** (commit [`4818776`](https://github.com/sleep2agi/agent-network/commit/4818776)): `client.ts:handleServerRequest` adds a `Number.isInteger(rawCode)` guard. Non-integer codes are coerced to `-32000` (the JSON-RPC standard reserved range); the original string is preserved on `data.originalCode` so no information is lost.

**New regression tests**: +2 cases, bun test 89/89 pass.

**Live verification** (in-house, 2026-06-07 19:50–19:55):
- Same-shape `read_file` failure retried: returns structured `code: -32000` + `data.originalCode: "ENOENT"` immediately
- The grok turn continues without hanging; the task completes normally (47 s, well under the 300 s timeout)
- ai-insight's Grok node passed UAT after installing `2.4.9-preview.0` globally

### 🐛 Bugs Fixed

- [#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — `grok-build-acp` ACP server-request responses carrying non-integer error codes (e.g. `ENOENT`) caused the Grok agent to fail to parse and hang until the 300 s timeout

### 📦 Install (fresh install)

```bash
npm i -g @sleep2agi/agent-network@latest @sleep2agi/agent-node@latest
# Verify versions
anet --version          # agent-network v2.2.10 (unchanged)
agent-node --version    # agent-node v2.4.9 ⬆
```

`anet hub start` auto-fetches `commhub-server@0.8.4` (PINNED, unchanged).

### 🔄 Upgrade (existing users)

**Narrow path** (recommended — only this package needs the hotfix):

```bash
npm i -g @sleep2agi/agent-node@2.4.9
# Restart every grok-build-acp node
cd <your-anet-workdir>
anet node stop <grok-node-alias> && anet node start <grok-node-alias>
```

**Full sweep** (also refreshes READMEs / metadata):

```bash
anet upgrade
```

⚠️ Node version note: agent-node supports Node ≥ 18; this hotfix's Docker smoke ran clean on both Node 20.20 and 24.16.

For the full troubleshooting entry see [troubleshooting → grok-build-acp node task hangs](/en/troubleshooting#grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603).

### 🙏 Credits

Bug repro + root cause + UAT: live 19:53:09 capture + a 47 s pilot on a user's Grok node; fix implementation: commit `4818776` + 2 regression tests; release ops: Method B two-phase + dual Install/Upgrade release notes sections.

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.12...v0.10.13>

---

## v0.10.12 — **Grok-build runtime scenario enablement + 0.2.8 alpha regression verify** (2026-05-30) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-node@2.4.8` ← bumped (scenario docs + 0.2.8 alpha regression baseline tag)
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged

### Highlights

- **Video-generation scenario (0 LOC)**: Send a Grok node a task carrying an image URL; the backend auto-routes to the `grok-imagine-video` model and returns mp4. Anet itself ships zero code changes — verified via ffmpeg first-frame visual check. See [research/grok-video-gen-capability-probe.md](https://github.com/sleep2agi/agent-network/blob/main/docs/research/grok-video-gen-capability-probe.md) (with Erratum) + [scenarios/video-gen-marketing.en.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/video-gen-marketing.en.md).
- **Basic X search (out-of-the-box)**: Find X URL + title + excerpt by keyword / handle — the LLM does it via `web_search` + `allowed_domains=["x.com"]`. No pre-setup required.
- **Live X advanced search (workspace setup required)**: Live streaming + per-post faves / retweets / replies metadata + `since:` / `min_faves:` operators — requires the user to pre-stage a twitterapi.io API key + fetcher script that the LLM drives via `run_terminal_command`. See [scenarios/x-search-informant.en.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/x-search-informant.en.md).
- **0.2.8 alpha regression verify**: 87 / 87 bun unit tests pass; the #201 delegation detection + #204 `.mcp.json` isolation fixes hold on Grok 0.2.8 alpha. Detail: [tests/p-grok-028-regression-verify/report.md](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/p-grok-028-regression-verify/report.md).
- **RFC-021 §12 / §13**: ACP capability dossier updated with Path D (workspace setup + terminal bypass) + XSearch ACP exposure test (XSearch's backend tool is structurally not exposed via ACP on 0.1.219 → 0.2.12 alpha; long-term resolution sits in the upstream xAI PR #1302).

### Install / Upgrade

Non-breaking; 0.2.8 alpha regression verified, safe to upgrade:

```bash
anet upgrade
```

Or single-package: `npm i -g @sleep2agi/agent-node@2.4.8`

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.11...v0.10.12>

---

## v0.10.11 — **#204 grok-build-acp per-node identity isolation + #194 commhub broadcast attribution hotfix** (2026-05-28) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.10` ← bumped (`anet hub stop` / `anet hub status` subcommands [#200](https://github.com/sleep2agi/agent-network/issues/200) + `anet hub start` stderr inherit [#199](https://github.com/sleep2agi/agent-network/issues/199) silent-hang fix + PINNED commhub-server `0.8.3` → `0.8.4`)
- `@sleep2agi/agent-node@2.4.7` ← bumped ([#204](https://github.com/sleep2agi/agent-network/issues/204) grok-build-acp per-node `.anet/nodes/<alias>/runtime-cwd/` isolation + [#201](https://github.com/sleep2agi/agent-network/issues/201) Grok delegate parser 3-layer broaden)
- `@sleep2agi/commhub-server@0.8.4` ← bumped ([#194](https://github.com/sleep2agi/agent-network/issues/194) broadcast `channel_meta_json` sender attribution hotfix — `from_session` injection no longer overrides the real LLM agent alias)
- `@sleep2agi/agent-network-dashboard@0.5.6` ← unchanged

### 🌟 Highlights

#### [#204](https://github.com/sleep2agi/agent-network/issues/204) — grok-build-acp per-node isolated cwd

**Problem**: `grok-build-acp` runtime nodes shared the `.mcp.json` discovery path, causing stale `.mcp.json` identity pollution — if a node's working directory carried an old `.mcp.json`, a newly started Grok node would be misidentified as that prior node.

**Fix**: Every node forks an isolated cwd (`.anet/nodes/<alias>/runtime-cwd/`), decoupled from the discovery path. This eliminates stale `.mcp.json` interference.

**E2E verification**: cross-node dispatch on a live Grok node — channel sender attribution correctly attributed to the sending node's alias, proving the LLM-layer attribution path is uncontaminated.

#### [#194](https://github.com/sleep2agi/agent-network/issues/194) — commhub broadcast sender attribution hotfix

**Problem**: On cross-node broadcast, the `channel_meta_json` sender field went through the `from_session` injection path, which overrode the real LLM agent name.

**Fix**: commhub-server `0.8.4` corrects the from-name injection logic to preserve the real sender alias.

### 🐛 Bugs Fixed

- [#199](https://github.com/sleep2agi/agent-network/issues/199) — `anet hub start` silent-hang fix: `spawn` `stdio` changed from `"pipe"` to `"inherit"` — commhub-server bunx fetch failures are now immediately visible.
- [#200](https://github.com/sleep2agi/agent-network/issues/200) — `anet hub stop` / `anet hub status` subcommands: users no longer need manual `lsof + kill`. Now `anet hub stop [--port <p>]` (SIGTERM → 3s grace → SIGKILL) + `anet hub status` (PID + port + `/health` version).
- [#201](https://github.com/sleep2agi/agent-network/issues/201) — Grok runtime refusing to delegate: explicit delegation parser 3-layer wrapper broaden + prompt softening covers all cases.

### 📦 Install (fresh install)

```bash
npm i -g @sleep2agi/agent-network@latest
# Verify version
anet -v  # Should show v2.2.10
```

`anet hub start` auto-fetches `commhub-server@0.8.4` (PINNED) + the first node start auto-fetches `agent-node@2.4.7`.

### 🔄 Upgrade (existing users)

```bash
anet upgrade
# Or manually
npm i -g @sleep2agi/agent-network@latest
```

`anet upgrade` syncs agent-network + agent-node + commhub-server to the latest `latest` versions.

### 🙏 Credits

Shipped by the Agent Network team — design + lead review / agent-node `#204` fix / agent-network release ops + `commhub-server` promote / testing + docs delivered end-to-end. Individual contribution detail on the [v0.10.11 GitHub release page](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.11). LLM E2E attribution was verified on a live node via cross-hub dispatch.

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.10...v0.10.11>

---

## v0.10.10 — **Xiaomi MiMo full 5-model support + envRef wizard-to-start auto-link** (2026-05-27) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.9` ← bumped (envRef Option A auto-source + `anet -v` now shows full prerelease suffix + Grok delegation parser broadened)
- `@sleep2agi/agent-node@2.4.6` ← bumped (envRef Option A implementation + Grok runtime stabilization continued)
- `@sleep2agi/commhub-server@0.8.3` ← unchanged
- `@sleep2agi/agent-network-dashboard` ← unchanged

### P0 — Xiaomi MiMo Vendor Preset complete

- Added `mimo-v2.5-tts-voicedesign` — the full official 5-model lineup is now in the picker
- `anet node create` → pick `claude-agent-sdk` runtime → "小米 MiMo" vendor → choose from 5 models: `mimo-v2.5-pro` (default) / `mimo-v2.5` / `mimo-v2-pro` / `mimo-v2-omni` / `mimo-v2.5-tts-voicedesign`
- Endpoint `https://token-plan-cn.xiaomimimo.com/anthropic` speaks the Anthropic Messages protocol
- 📌 Note: `voicedesign` is a TTS speech-design model — Anthropic Messages text requests are likely vendor-unsupported. For text dialogue, use the first 4 models.

### P0 — envRef wizard-to-start auto-link ([#193](https://github.com/sleep2agi/agent-network/issues/193))

**Pain point**: After `anet node create`, running `anet node start` in the same shell reported `FATAL env var not set` — you had to manually `export ANTHROPIC_AUTH_TOKEN_N_<id>=...` first.

**New behavior**:

- During `wizard create`, the API key is written to `.anet/nodes/<alias>/.env` (mode 0600, auto-added to `.anet/.gitignore`)
- `anet node start` sources that `.env` file at launch — no manual `export` needed
- Cross-machine deployment still supported (the wizard still prints the `export` command once so it can be copied to another box)
- Debug logs emit only `loaded N key(s) from .anet/nodes/<alias>/.env` — **the key value is never echoed**
- Backward compatible: existing `ANTHROPIC_AUTH_TOKEN_N_*` shell exports keep working; legacy plain `config.json` mode also still works

Applies to every `claude-agent-sdk` node (MiMo / MiniMax / InternLM / GLM / any Anthropic-Messages-compatible vendor).

### Bug fixes

- **[#192](https://github.com/sleep2agi/agent-network/issues/192)** `anet -v` no longer truncates the prerelease suffix — it now shows the full version (e.g. `v2.2.9`, including any `-preview.N` suffix when applicable)
- **[#189](https://github.com/sleep2agi/agent-network/issues/189) Grok runtime** `grok-build-acp` fully stabilized: the explicit-delegation parser was broadened to cover cases like "你和 X 沟通一下…" / "send_task X 一下…" (no-punctuation trailing body), so cross-node delegation routing is reliable.

### Known Issues

The internal `npx` fallback inside `agent-network` still pins `@sleep2agi/agent-node@preview` — a future preview push could expose `@latest` users to an unstable build. There's no regression in this release (preview `2.4.6-preview.2` is content-equivalent to latest `2.4.6`), but follow-up handling is queued under a future RFC (tracking issue to be opened; **distinct from the same-numbered [RFC-021 ACP capability profile expansion](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-021-acp-capability-profile-expansion.md) which targets X-search unlock**).

---

## v0.10.9 — **Dashboard image sending + CommHub attachment metadata + codex-sdk image input** (2026-05-25) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.7` ← bumped (pinned server moved to `@sleep2agi/commhub-server@0.8.3`)
- `@sleep2agi/agent-node@2.4.3` ← bumped (codex-sdk runtime consumes structured image attachments)
- `@sleep2agi/commhub-server@0.8.3` ← bumped (`meta_json` persistence + MCP/REST attachment metadata)
- `@sleep2agi/agent-network-dashboard@0.5.4` ← bumped (TaskChatPanel image upload/paste send path)

### P0 — Dashboard command flow can send images

Vincent catch: Dashboard could upload and preview images, but tasks sent to agents only carried text paths. The codex-sdk runtime never received actual image input, so screenshots, design drafts, and error images could not be dispatched from the web/mobile command surface.

**Implementation**:
- Dashboard sends structured `attachments` for uploaded/pasted images while keeping text fallback paths and preview URLs.
- Hub `send_task` and REST `/api/task` accept `meta.attachments`, persist it to `inbox.meta_json` and `tasks.meta_json`, and return parsed `meta` from `get_inbox`.
- agent-node extracts local image paths from `meta.attachments` and passes them into codex-sdk/studio image input.
- Telegram image dispatch now passes image arguments in the correct position.

### Rollout + Smoke

- Local CommHub and Dashboard were upgraded and restarted.
- 27 host codex-sdk agent-node processes were rolled to the new code.
- P0 smoke sent `/tmp/anet-image-smoke.png` to `test-node`; node logs showed `+1 image(s)` / `→ processing [codex] +1 image(s)`, with reply `图片通道OK`.

### Known Limits

- Dashboard uploads currently hand off local file paths, best suited for same-host hub/agent deployments. Cross-host object-storage delivery remains future work.
- Existing old containers need reinstall/restart to pick up this release.
- This release fixes delivery into the runtime; rich media history and mobile IM polish remain dashboard follow-up work.

See the [v0.10.9 tag](https://github.com/sleep2agi/agent-network/tree/v0.10.9).

---

## v0.10.8 — **Dashboard Servers panel UI copy fix + TopoGraph density-tier polish** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.6` *(unchanged, v0.10.7)*
- `@sleep2agi/agent-node@2.4.2` *(unchanged)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.3` ← bumped (UI copy + Playwright attrs + polish fold-in)

### Fix — [#157](https://github.com/sleep2agi/agent-network/issues/157) Dashboard Servers panel UI copy fix (Root cause #1)

Vincent caught this in real testing (with dashboard screenshot): the Servers panel was rendering `agent rollup pending hub ≥ 0.8.2-preview` / `disk metric pending hub ≥ 0.8.2-preview` for every hub, even though every production hub is already at `≥ 0.8.2`. **The copy was outdated and misleading** — for a moment Vincent thought the version dashboard data was completely broken.

**Root cause #1 (this patch)**: ServersDrawer UI carried placeholder text introduced during the 0.8.2 upgrade window. 0.8.2 has long since shipped, but the placeholder text was never removed, so it kept rendering "pending" for `≥ 0.8.2` hubs and led users to believe the hub data was missing.

**Implementation** (`app/components/ServersDrawer.tsx`):

```diff
- <div ...>agent rollup pending hub ≥ 0.8.2-preview</div>
- <div ...>disk metric pending hub ≥ 0.8.2-preview</div>
+ <div ... data-server-agents-missing="true">agent rollup not reported by hub</div>
+ <div ... data-server-disk-missing="true">disk metric not reported by hub</div>
```

The new copy accurately says "this hub didn't report it right now" instead of implying the hub version is too old. The new `data-server-agents-missing` / `data-server-disk-missing` Playwright hooks enable the next e2e round to validate hub-side telemetry coverage.

::: info Root causes #2 + #3 located, deferred
- **#2** (v0.10.9 candidate): missing dedupe when one hostname appears multiple times can double-count servers — the dashboard team's fix is queued for v0.10.9 ship.
- **#3** (v0.11.0 candidate): `status=offline` vs telemetry mismatch (telemetry still reports but SSE `last_seen` has timed out) — needs system-level status reconciliation.
:::

### Polish fold-in — TopoGraph density-tier (purely additive)

Dashboard team commit [`3f73810`](https://github.com/sleep2agi/agent-network-dashboard/commit/3f73810) (0.5.3-preview.16) — the canvas state attribute `data-topo-fleet-density-tier` ∈ `{empty, sparse, normal, dense, very-dense}` exposes a 12th observable testing surface. Tier boundaries (sparse 1-3 / normal 4-15 / dense 16-30 / very-dense 31+) line up with the dense-layout collapse gate. **Purely additive, no UX change**. Paired with the numeric counts, e2e selectors now have a complete canvas-state snapshot.

### Quality gates + lessons

- **Source-grep verify**: the lead's `grep -rh "not reported by hub"` hits + the legacy copy only survives in JSDoc comments ✅
- **Docker preview smoke**: `docker run --rm node:24-slim sh -c "npm install -g @sleep2agi/agent-network-dashboard@0.5.3-preview.15 && grep..."` ✅
- **JSX copy verified at source level**: at `app/components/ServersDrawer.tsx` — no dependency on the `.next/server` bundled output
- **v0.10.x patch density of 8 patches in one day** validates that the audit-first cadence is sustainable

### Release stats — v0.10.8

- **18 cumulative `@latest` publishes** (v0.9.0 → v0.10.8): 0 split-brain / 0 rollback / 0 retry
- **2026-05-17 v0.10.x same-day ships**: v0.10.1-8 = **8 ships in ~11 hours** (audit-first cadence)
- Vincent catch + Vincent [#158 LOCKED directive](https://github.com/sleep2agi/agent-network/issues/158) closed out in the same cycle

See the [v0.10.8 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.8).

---

## v0.10.7 — **codex-sdk batch path yolo flags parity** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.6` ← bumped (codex-sdk batch path yolo parity)
- `@sleep2agi/agent-node@2.4.2` *(unchanged)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(unchanged)*

### Fix — [#156](https://github.com/sleep2agi/agent-network/issues/156) codex-sdk batch path yolo flags parity

Vincent catch: "fast 也要开新一下默认 / codex 默认 fast 啊" (codex needs `fast` mode by default in the batch path too).

**Pre-fix vs Post-fix matrix**:

| Path | Pre-fix | Post-fix |
|---|---|---|
| `anet node create --runtime codex-sdk` | ✅ 4/4 yolo flags ([#149](https://github.com/sleep2agi/agent-network/issues/149) v0.10.3 ship) | ✅ 4/4 yolo flags (unchanged) |
| `anet create --batch --runtime codex-sdk` | ❌ **only 1/4** (`dangerouslySkipPermissions` baseline only) | ✅ 4/4 yolo flags (matches single-node) |
| `anet [...] --runtime codex-sdk --no-yolo` | (flag did not exist) | ✅ 1/4 baseline only (opt-out for CI/scripted) |

**Implementation** — clean helper extraction at `bin/cli.ts:125-131`:

```ts
function codexSdkYoloFlags(noYolo?: boolean): Record<string, string | boolean> {
  if (noYolo) return {};
  return {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    skipGitRepoCheck: true,
  };
}
```

Single source-of-truth helper: both the single-node path (`cli.ts:1146`) and the batch path (`cli.ts:6223`) call the same function — **eliminates the v0.10.6 1/4-vs-4/4 drift**. `dangerouslySkipPermissions: true` is the baseline, set at each call site, 1+3=4 yolo flags total.

### User impact

- **Batch + codex-sdk users**: previously, batch-wizard-created codex agents would block on tool-approval popups / sandbox / git checks, losing the yolo autonomous posture → now all 4 flags are set, autonomous behavior matches single-node.
- **Single-node users**: unaffected (path unchanged).
- **CI / scripted users**: the new `--no-yolo` flag provides an explicit safe-mode opt-out.
- **Non-codex-sdk runtimes** (claude / sdk): completely unaffected (helper is gated on `runtime === "codex-sdk"`).

### Quality gates + lessons

- **Source-grep verify**: `grep -n` against `bin/cli.ts` HEAD across 5 sites all PASS (helper + 2 call sites + wiring + field).
- **Docker container smoke**: Cell A `anet login` setup failed (test infra blocker, not a fix bug) → Gate 2 source-grep evidence accepted as substitute, per v0.10.6 precedent.
- **Docker smoke gets its token via direct `curl` API calls** (new): Docker smoke entry scripts must use `curl` direct API calls to `/api/auth/register` + `/api/auth/login` to obtain a token; **do not** use interactive `anet login` (it stalls in non-TTY containers — the hub login call blocks).

### Release stats — v0.10.7

- **17 cumulative `@latest` publishes** (v0.9.0 → v0.10.7): 0 split-brain / 0 rollback / 0 retry
- **2026-05-17 v0.10.x same-day ships**: v0.10.1-7 = **7 ships in ~10 hours** (audit-first cadence)
- **10 user-feedback items all closed-loop**: including v0.10.7 [#156](https://github.com/sleep2agi/agent-network/issues/156)

See the [v0.10.7 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.7).

---

## v0.10.6 — **`anet upgrade` Option B detached spawn + `anet create --batch` wizard silent-exit fix** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.5` ← bumped (CLI upgrade + wizard fixes)
- `@sleep2agi/agent-node@2.4.2` *(unchanged, v0.10.3)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(unchanged, v0.10.4)*

::: warning Chicken-and-egg upgrade note — one-time manual install required
v0.10.4's [#151 Option A](https://github.com/sleep2agi/agent-network/issues/151) only updated the verbiage (`anet upgrade` now shows "⚠️ NEEDS MANUAL UPGRADE"), but **the chicken-and-egg deadlock wasn't fixed** — your current `2.2.2 / 2.2.3 / 2.2.4` binary still falls back to the old "skipped (would replace running CLI)" behavior (that logic is frozen on the npm tarball).

```bash
npm install -g @sleep2agi/agent-network@2.2.5    # one-time manual install
anet --version                                    # expect v2.2.5
```

From the next release onward (e.g. 2.2.6+), `anet upgrade` will **auto detached-spawn** the install for you — no more manual install.
:::

### Fixes

- **[#154](https://github.com/sleep2agi/agent-network/issues/154) `anet upgrade` Option B detached spawn enabled by default** (Vincent catch): users saw `anet (self): skipped (would replace the running CLI).` + `[anet] Done.` and assumed success, but the anet binary never actually upgraded (chicken-and-egg deadlock — a Node process can't in-place replace its own binary). `bin/cli.ts:3873-3874` now does `spawn(forkScript, [], { stdio: "inherit", detached: true })` + `child.unref()` + main process `process.exit(0)`; the detached child runs `npm install` in the background. The new version takes effect 1-2 min later — no `--self` flag needed.
- **[#155](https://github.com/sleep2agi/agent-network/issues/155) `anet create --batch` wizard silent-exit fix** (Vincent catch): after the workdir-mode `select()`, `process.stdin` state changes and the readline-based `ask()` helper returns at EOF immediately → the entire wizard **silently exits** at the `Node prefix` prompt (same root cause as [#137 in v0.9.2 preview.5 anet create regression](https://github.com/sleep2agi/agent-network/issues/137), recurring in a different code path). Fix: migrate all post-select prompts to `inquirer.input()` so stdin handling stays uniform with the preceding select; the catch fallback retains the legacy `ask()` for non-TTY / no-inquirer environments.

### Quality gates + lessons

- **Docker smoke gate is never skipped** (Vincent): the v0.10.4 emergency trust path is **SUSPENDED** — the Docker smoke gate is never bypassed again.
- **All test nodes run in Docker** (Vincent): red-line — all test nodes go in Docker, must never connect to a host hub.
- **dist is an obfuscated bundle — verify against source** (new): `dist/bin/cli.js` is esbuild bundled + obfuscated (rotating string table, mangled identifiers, encoded string literals) — static grep on dist is useless. Code-path verification must grep `bin/cli.ts` source (HEAD = the preview build source).

### Release stats — v0.10.6

- **16 cumulative `@latest` publishes** (v0.9.0 → v0.10.6): 0 split-brain / 0 rollback / 0 retry
- **2026-05-17 v0.10.x same-day ships**: v0.10.1 + v0.10.2 + v0.10.3 + v0.10.4 + v0.10.5 + **v0.10.6** = **6 ships in ~9 hours** (audit-first cadence)
- **9 user-feedback items all closed-loop**: Install/Upgrade docs split + #149 / #150 / #151 / #152 / #153 / #154 / #155 + red-line SOPs

See the [v0.10.6 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.6).

---

## v0.10.5 — **`anet create --batch` wizard double-fix** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.4` ← bumped (CLI wizard fixes)
- `@sleep2agi/agent-node@2.4.2` *(unchanged, shipped in v0.10.3)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(unchanged, shipped in v0.10.4)*

### Fixes

- **[#152](https://github.com/sleep2agi/agent-network/issues/152) `anet create --batch` wizard now prompts for workdir mode** (Vincent push): the `--workdir-mode <shared|separate>` flag has shipped since [#55](https://github.com/sleep2agi/agent-network/issues/55), but the interactive wizard never prompted — users had to know the flag name to change the default `separate`. `createBatchWizardCommand` now adds an inquirer select (`separate` default / `shared` co-cwd), TTY-aware (flag set / non-TTY both fall back to `separate` with an INFO hint). agent-node / server / dashboard untouched — purely CLI wizard UX.
- **[#153](https://github.com/sleep2agi/agent-network/issues/153) codex-sdk / claude-code-cli runtime selection no longer falsely prompts for `ANTHROPIC_AUTH_TOKEN`** (Vincent push): the runtime-first wizard ([#133](https://github.com/sleep2agi/agent-network/issues/133)) called `selectVendorAndModel()` even when codex-sdk / claude-code-cli was picked (only claude-agent-sdk needs an API key). The wizard now skips the API key prompt for those runtimes and prints a one-line `codex auth login` / `claude auth login` hint instead.

See the [v0.10.5 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.5).

---

## v0.10.4 — **`anet upgrade` UX warning + Dashboard orphan-band layout** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.3` ← bumped ([#151](https://github.com/sleep2agi/agent-network/issues/151) anet upgrade UX)
- `@sleep2agi/agent-network-dashboard@0.5.2` ← bumped ([#150](https://github.com/sleep2agi/agent-network/issues/150) orphan-band layout)
- `@sleep2agi/agent-node@2.4.2` *(unchanged, shipped in v0.10.3)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*

### Fixes

- **[#151](https://github.com/sleep2agi/agent-network/issues/151) `anet upgrade` self-skip warning is now explicit** (Vincent push): the prior `anet (self) — self-skip` row didn't spell out **why** or **how**; users walked the plan and didn't realize their own version wasn't bumped. Now adds an explicit warning + guides toward the `--self` flag.
- **[#150](https://github.com/sleep2agi/agent-network/issues/150) Dashboard topology orphan nodes now collected into an "Others" cluster box** (Vincent push): previously, orphan nodes (no prefix group) were scattered across the canvas and hard to find; they now collect into an "Others" cluster box rendered alongside the other groups.

::: warning Vincent emergency trust path
v0.10.4 was shipped via Vincent's emergency trust path, skipping the test-lead Docker smoke gate (the no-testing-on-prod rule was not waived, but Vincent took the lead-scope trust path). Docker smoke is still the release-gate playbook standard checkpoint, unchanged.
:::

See the [v0.10.4 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.4).

---

## v0.10.3 — **codex-sdk default model now gpt-5.5 + yolo flags visible in config** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.2` ← bumped (cli.ts vendor preset)
- `@sleep2agi/agent-node@2.4.2` ← bumped (codex-sdk runtime + flags)
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.1` *(unchanged)*

### Fixes

- **[#149](https://github.com/sleep2agi/agent-network/issues/149) codex-sdk default model fix + yolo flags written into config** (Vincent catch):
  - cli.ts codex vendor preset default model placeholder `gpt-5.4` → real `gpt-5.5`
  - codex-sdk runtime gains `yolo: true` flags (same concept as the Claude Code preset's `dangerouslySkipPermissions` + `teammateMode`) — skips the permission-prompt for multi-agent batch runs
  - Flags are persisted in `config.json` rather than as an ephemeral runtime arg, so users can inspect / edit them

See the [v0.10.3 release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.3).

---

## v0.10.2 — **Hero A disk telemetry + Hero D topology label UX** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.1` *(unchanged — `PINNED_SERVER_VERSION` stays at `0.8.2`)*
- `@sleep2agi/agent-node@2.4.1` ← `2.4.0` (Hero A disk telemetry, additive; commit [`50d25b2`](https://github.com/sleep2agi/agent-network/commit/50d25b2))
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.1` ← `0.5.0` (Hero D topology prefix-label Option C + disk render + 100+ rounds of polish)

### Hero A — agent-node disk telemetry ([#99](https://github.com/sleep2agi/agent-network/issues/99) per-server daemon Phase 2 host metrics, final 10%)

`agent-node/src/host-telemetry.ts` adds `readDiskStats()` via `execFileSync('df', ['-k', '/'])` (+33 lines):

- **POSIX `-k`** standardizes KB output, so Linux and macOS share a single parse path
- **No shell pipe** (per the recent shell-audit safety review) — `execFileSync` direct call
- Windows / parse failure: **graceful null** (the dashboard renders `—` rather than a misleading `0`)
- `HostTelemetry` interface gains `disk_total_gb` / `disk_used_gb` / `disk_avail_gb`; `getHostTelemetry()` composes disk via `toGb()` on the same path as mem/cpu
- **Backward compat**: older servers silently drop unknown keys; agents and servers upgrade independently

Wires through [RFC-014](https://github.com/sleep2agi/agent-network/issues/99) — `GET /api/server/:host/health` now returns disk's three fields, the 24h bucketed history includes `disk_avail_min` / `disk_used_max`, and `alert_level` adds `disk < 1GB critical / < 5GB warn` triggers ([`server/src/index.ts:253-258`](https://github.com/sleep2agi/agent-network/blob/22ed1886/server/src/index.ts#L253), pinned to commit `22ed1886`; the file has since been split up and is only 16 lines on `main`, which is why this does not link to `main`).

Test lead Docker Linux smoke 3/3 PASS (disk 299.8 GB total / 216 used / 71.5 avail, alert green, backward compat verified).

### Hero D — Dashboard topology prefix-label UX, Option C (dashboard `0.5.1`)

[#147](https://github.com/sleep2agi/agent-network/issues/147) (acked 5/16) + Option C landed:

- Topology node prefix labels (the node→group edge labels' distinguishability) ship with the Option C design (dashboard team design pass)
- Disk telemetry hover-card rendering (`disk_total_gb` / `disk_used_gb` / `disk_avail_gb` wired to the [`GET /api/server/:host/health`](/en/api/rest-data#get-api-server-host-health) response)
- 100+ rounds of typography + corner-radius cascade polish

Dashboard team design pass + 4/4 verify (commit `7de97ee` + screenshot evidence, local ship `f9c83cd`).

### Closed issues

- [#99](https://github.com/sleep2agi/agent-network/issues/99) per-server daemon Phase 2 close gate met (host metrics fully wired, Hero A disk shipped)
- [#147](https://github.com/sleep2agi/agent-network/issues/147) Hero D (5/16 ack → Option C shipped)

### RFC artifacts preserved (v0.12.0 scope)

v0.10.2 is a hotfix scope (no v0.11.0-series RFC ship); three RFC artifacts are preserved as v0.12.0 candidates:

- [RFC-013 v5](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-013-rename-hot-reload.md) rename hot-reload (third-pass review complete)
- [RFC-014 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-014-daemon-phase2.md) daemon Phase 2 host metrics (Hero A final 10% shipped in v0.10.2)
- [RFC-015 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-015-token-usage-telemetry.md) [#114](https://github.com/sleep2agi/agent-network/issues/114) token-usage UI (first-pass REVISION complete)

### Upgrade

```bash
anet upgrade                                     # bumps agent-node 2.4.0 → 2.4.1 + dashboard 0.5.0 → 0.5.1
anet project restart                             # restart the project (pulls the new agent-node + dashboard)
```

### Migration / Breaking

- **No breaking changes** — the disk fields are additive (the `HostTelemetry` interface gains three fields, the server schema silently drops unknown keys for backward compat). Agent and server upgrade independently; for agents that don't emit the field, SQL stays `NULL` and the dashboard renders `—` rather than a misleading `0`.

Release flow follows the [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) two-phase publish SOP.

---

## v0.10.1 — **Hotfix: PINNED_SERVER_VERSION chain-bump after the v0.10.0 ship** (2026-05-17) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-network@2.2.1`
- `@sleep2agi/agent-node@2.4.0` *(unchanged)*
- `@sleep2agi/commhub-server@0.8.2` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.5.0` *(unchanged)*

### Fix

[`PINNED_SERVER_VERSION` in `agent-network/bin/cli.ts`](https://github.com/sleep2agi/agent-network/blob/3a387204/agent-network/bin/cli.ts#L61) (pinned to commit `3a387204`, line 61 at the time) was never bumped across the v0.9.x + v0.10.0 promotes — it stayed hardcoded at `0.8.0`. That meant `anet hub start` was actually running `bunx --bun @sleep2agi/commhub-server@0.8.0` ([the `bunx --bun @sleep2agi/commhub-server@…` call site in `cli.ts`](https://github.com/sleep2agi/agent-network/blob/3a387204/agent-network/bin/cli.ts#L2589), same commit, line 2589) — the old server, not the v0.10.0-shipped `0.8.2`. Direct impact:

- The [#99](https://github.com/sleep2agi/agent-network/issues/99) per-server daemon endpoints `GET /api/server/:host/health` + `GET /api/server/:host/agents` don't exist in 0.8.0 → **404**
- [#142](https://github.com/sleep2agi/agent-network/issues/142) server schema alignment for `process_telemetry` isn't wired in 0.8.0 → the older schema silently drops the field
- Dashboard `0.5.0` §3.F server-health ring tint **had no data source** / §3.E hover card `process_telemetry` rendered all-`null`

A v0.10.0-announced functionality regression on the **default `anet hub start` workflow** (manually launching `bunx --bun @sleep2agi/commhub-server@latest` was not affected).

Fix (commit [`4d24024`](https://github.com/sleep2agi/agent-network/commit/4d24024)):

```diff
- const PINNED_SERVER_VERSION = "0.8.0";
+ const PINNED_SERVER_VERSION = "0.8.2";
```

### Upgrade

```bash
anet upgrade                                     # bumps agent-network 2.2.0 → 2.2.1
anet project restart                             # restart the project (pulls the new commhub-server)
```

Or fresh install:

```bash
npm install -g @sleep2agi/agent-network@latest
```

### Lessons

- **release-gate playbook now covers PINNED chain-bump** — every promote-to-latest must chain-bump `PINNED_*_VERSION` (server pin / dashboard pin / agent-node pin), or the default path keeps running the previous ship. Consistent with [#80 PINNED bump SOP](https://github.com/sleep2agi/agent-network/issues/80), but the Hero 4 release-gate playbook hadn't covered it; the case is now added (see lesson memory in [methodology](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/methodology.md)).

Release flow follows the [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) two-phase publish SOP.

---

## v0.10.0 — **Direct Runtime + Observability Foundations** (2026-05-16) ✅ stable (Phase 1, 3-package promote)

**Version alignment** (npm `latest` tag, Phase 1):
- `@sleep2agi/agent-network@2.2.0`
- `@sleep2agi/agent-node@2.4.0`
- `@sleep2agi/commhub-server@0.8.2`
- `@sleep2agi/agent-network-dashboard@0.5.0` ✅ Phase 2 shipped

::: tip Theme: fix the root
v0.7 → v0.9.2 accumulated 11 releases; the 5-P0 ripple chain ([#135-#139](https://github.com/sleep2agi/agent-network/issues/135)) surfaced a runtime architecture debt. v0.10.0 fixes the root — runtime debt (codex-sdk wrapper bypass, opt-in) + observability foundations (per-server daemon endpoints + per-agent process telemetry) + release-gate playbook. This is the groundwork for v0.11.0's 24/7 multi-vendor AI Agent society live stream. See the [v0.10.0 release tracker #140](https://github.com/sleep2agi/agent-network/issues/140).
:::

### 5 features

**A. [#141](https://github.com/sleep2agi/agent-network/issues/141) codex app-server stdio direct (opt-in `ANET_CODEX_STDIO_DIRECT=1`)**
The codex runtime previously went through the `@openai/codex-sdk` npm wrapper; the wrapper's `--mcp-config` HTTP transport bug is the root-cause family for the [#102](https://github.com/sleep2agi/agent-network/issues/102) hang. v0.10.0 adds a direct `spawn('codex', ['app-server'])` + minimal stdio JSON-RPC client (~155 LOC) path that **bypasses the wrapper entirely**, sidesteps that family bug, and exposes the full 67-method v2 protocol surface (thread / turn / item / realtime). **v0.10.0 still defaults to the wrapper path** (collecting preview feedback first); set `ANET_CODEX_STDIO_DIRECT=1` to opt in. Default flip is planned for v0.11.0.

**B. [#99](https://github.com/sleep2agi/agent-network/issues/99) Per-server daemon Phase 1 scaffold (monitoring-only)**
New server-side endpoint family (commit [`e575cc6`](https://github.com/sleep2agi/agent-network/commit/e575cc6)):
- `GET /api/server/:host/health` — host CPU / mem / disk / process health
- `GET /api/server/:host/agents` — per-host agent list + telemetry history

Dashboard integration lands in Phase 2 ([#119](https://github.com/sleep2agi/agent-network/issues/119) ServersDrawer integration). The control layer (kill / restart / redeploy) is deferred to v0.11.0.

**C. [#142](https://github.com/sleep2agi/agent-network/issues/142) Per-agent process telemetry**
agent-node now embeds `process_telemetry` in every `commhub_report_status` heartbeat: `rss` / `cpu_pct` / `uptime_seconds` / `in_flight_count`. Zero sysmon dependency, zero privilege. commhub-server schema is aligned on the wire (commit [`209cac7`](https://github.com/sleep2agi/agent-network/commit/209cac7)); the dashboard hover-card rendering ships in Phase 2 ([#119](https://github.com/sleep2agi/agent-network/issues/119) sibling). Sibling to [#119](https://github.com/sleep2agi/agent-network/issues/119) host fields (host step 1 ✅ earlier; agent step 2 ships in this release).

**D. Dashboard network/node front-end surface upgrade (Hero 3 — 8/8 surfaces complete, dashboard `0.5.0`)**
- §3.A prefix-group fix (Vincent #1 catch)
- §3.B sweep retire (legacy sweep path merged into grid)
- §3.C recent-panel hide
- §3.D grid default view
- §3.E hover detail card
- §3.F server-health ring tint (wired to #99 endpoint)
- §3.G fullscreen mode
- §3.I canvas brand mark
- *(§3.H dropped per RFC Q2 review)*

Ships alongside **19+ rounds of typography + corner-radius cascade polish** (four typography families + systematic corner-radius cascade rework). Dashboard `0.5.0` is now on the npm `latest` tag, landing with this v0.10.0 Phase 2 docs sync.

**E. Lightweight pre-release-gate playbook (release-gate Phase 1+2)**
[`docs/tests/release-gate-playbook.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/release-gate-playbook.md) — maintained by the test lead. Covers hub / dashboard / login / node lifecycle / runtime smoke / vendor verify. v0.10.0 is the first release to fully exercise this playbook; future latest promotes gate on it.

### Breaking changes / Migration

- **`codex` runtime default behavior unchanged**: still goes through the `@openai/codex-sdk` wrapper; set `ANET_CODEX_STDIO_DIRECT=1` to switch to the direct stdio path. The preview-chain `ANET_CODEX_LEGACY_SDK=1` fallback flag is renamed to the more direct opt-in `ANET_CODEX_STDIO_DIRECT=1` for latest — same semantics, clearer name.
- **agent-node `commhub_report_status` payload adds `process_telemetry` sub-object**: commhub-server `0.8.2` schema is aligned; older server versions (≤ `0.8.1`) silently ignore the unknown field and won't fail.
- **`/api/server/:host/health` + `/api/server/:host/agents` are new endpoints**: rate-limit / auth behavior matches the existing `/api/servers` (admin or self-network member); no existing client is broken.

### Known follow-ups

- ~~**Phase 2 dashboard `0.5.0` promote**~~ ✅ shipped (dashboard `0.5.0` landed with this v0.10.0 Phase 2 docs sync — 8/8 Hero 3 surfaces complete + 19+ rounds of polish)
- **Close evidence for #102 / #103 hang** — Phase 1.5 in the preview chain already plans the regression replay against the new stdio path; we'll close them once the latest opt-in path passes the regression.
- **Sessions NETWORK column display bug** (Vincent catch) — deferred to a v0.10.x patch or v0.11.0.
- **#117 `anet project up` detached-tmux follow-up** (macOS bun `setRawMode` already fixed by #136, but detached-mode follow-up still pending) — to be done with the v0.11.0 control layer.

Release flow follows the [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) two-phase publish SOP: publish each tarball with `--tag preview` first, curl-verify HTTP 200, then `npm dist-tag add @<v> latest`. Phase 1 three-package (agent-network / agent-node / commhub-server) clean-semver promote is complete; dashboard Phase 2 is pending §3.D/F/G.

---

## Older releases {#older}

Entries for v0.9.2 (2026-05-16) and earlier, and the roadmap of that time, moved to the repository's [changelog archive](https://github.com/sleep2agi/agent-network/blob/main/docs/archive/changelog-pre-v0.10.en.md).

## Next steps

- [Upgrade guide](/en/guide/upgrade) — v0.7 → v0.8 behavior changes + standard steps
- [Architecture](/en/guide/architecture) — how each release accumulated into the current system
- [npm version list](https://www.npmjs.com/package/@sleep2agi/agent-network?activeTab=versions) and [desktop releases](https://github.com/sleep2agi/agent-network-app/releases)
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — v0.8 ~ v1.0 master-token deprecation roadmap
