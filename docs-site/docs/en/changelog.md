# Changelog

::: info Versioning note
This log runs reverse-chronologically. **The version scheme was reshuffled once**:
- **From 2026-05 onward**: gradual v0.6 → v0.7 → v0.8.x releases, aligned with `commhub-server` semver.
- **Before 2026-04**: used `v1.0.0-preview.N` / `v2.1` style version numbers that overpromised. Deprecated.
- **Current stable**: v0.8.3 (2026-05-14, shipped via npm `latest` tag; v0.8.1 was the first Apache 2.0 OSS release).
- Older entries kept for git-blame continuity — see v1.0.0-preview / v2.1 / v0.x sections below.
:::

## v0.9.1 — **Patch: #130 intern tool-calling hotfix promoted** (2026-05-15) ✅ stable

**Version sync** (npm `latest` tag):
- `@sleep2agi/agent-network@2.1.14` (version-only bump, no source changes; lets `anet upgrade` show a v0.9.1 line that aligns with agent-node 2.3.9 + dashboard)
- `@sleep2agi/agent-node@2.3.9` (promotes the [#130](https://github.com/sleep2agi/agent-network/issues/130) hotfix to latest)
- `@sleep2agi/commhub-server@0.8.1` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.4.6` *(unchanged)*

### Fixes

- **[#130](https://github.com/sleep2agi/agent-network/issues/130) intern-s2-preview tool calling now works** ([commit `4cd0024`](https://github.com/sleep2agi/agent-network/commit/4cd0024) + two-phase publish promote) — in v0.9.0 the intern-s2-preview endpoint, on the Anthropic protocol with `tool_choice: "auto"`, defaulted to verbose Thinking Process text and did not emit `tool_use` content blocks. Forcing `tool_choice` was rejected with `-20077`. Hotfix: when `ANTHROPIC_BASE_URL` matches `intern-ai.org.cn` / `chat.intern-ai`, a short system-prompt bias is prepended that nudges the model to emit `tool_use` directly. Direct-curl A/B verified: `stop_reason: max_tokens → tool_use`, `output_tokens: 1024 → 122`. See [Vendor Adapters](/en/concepts/vendor-adapters) for the full mechanism, the 5 side effects, and the opt-out path.

### Known gaps (non-blocking)

- The vendor adapter relies on a URL regex to detect the vendor — self-hosted lmdeploy / proxied intern endpoints / aggregator routes will not trigger the bias and need a manual `--prompt`. See [Vendor Adapters — Side effects](/en/concepts/vendor-adapters#side-effects-must-read).
- The `--no-vendor-bias` flag is not yet implemented (P1 polish gap, planned alongside a `bias_active` info-display follow-up).

### Release process

Per the v0.9.0 split-brain lessons ([issue #126](https://github.com/sleep2agi/agent-network/issues/126)), uses the two-phase publish path:

```
1. version bump → preview.N+1
2. npm publish --tag preview      → tarball uploaded
3. curl tarball URL                → HTTP 200 confirmed
4. npm dist-tag add @<pkg>@<v> latest
5. npm view dist-tags.latest       → verifies "<v>"
```

This avoids the direct `npm publish --tag latest` path that splits during the CDN async window, where the `latest` tag points at a version whose tarball is not yet served everywhere.

---

## v0.9.0 — **Recovery & Observability** (2026-05-15) ✅ stable

- `@sleep2agi/agent-network@2.1.13`
- `@sleep2agi/agent-node@2.3.8`
- `@sleep2agi/commhub-server@0.8.1`
- `@sleep2agi/agent-network-dashboard@0.4.6`

### 🎯 Theme: Recovery & Observability

The full **zero-keystroke recovery loop** for 22-node reboots + transparent default toolset behavior + server-level aggregate observability.

### New features — Recovery chain

- **`anet project up / restart / down`** (issue [#117](https://github.com/sleep2agi/agent-network/issues/117)) — cwd-wide node orchestration; scans `.anet/nodes/` and starts / restarts / stops every node. Shared options: `--stagger <seconds>` (default 3) / `--only a,b,c` / `--exclude x,y`. `down` caps the hub-offline notify at a 2-second race so a crashed-hub teardown for 22 nodes doesn't deadlock.
- **`anet node create --resume <id>` / `--resume-latest`** (issue [#115](https://github.com/sleep2agi/agent-network/issues/115)) — bind an existing Claude session at node-create time; TTY mode launches an interactive picker listing `~/.claude/projects/<cwd>/*.jsonl` (age / size / 60-char first-line preview). `anet session ls` and the picker share the same `listClaudeSessions()` helper.
- **Zero-keystroke recovery** ([#115](https://github.com/sleep2agi/agent-network/issues/115)) — `anet node start` injects `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999` into the `claude` spawn env, skipping Claude Code's default 70-minute session-age threshold for the "Resume from summary / full / Don't ask again" interactive prompt. Per-spawn, does not pollute `~/.claude/settings.json`, respects an explicit user override. Resume restores the full session as-is (no per-invocation flag forces a compact summary; restart-recovery is safer without surprise compaction).
- **`anet node start` auto-wraps into detached tmux** (issue [#122](https://github.com/sleep2agi/agent-network/issues/122)) — wraps only when all four conditions hold (TTY + `$TMUX` not set + tmux installed + no same-name session). New flags: `--foreground` / `--no-tmux` (aliases) force foreground; `--attach` starts detached then immediately `tmux attach` after a 200ms grace period. **Two layers of recursion guard**: `$TMUX` env detection + inner cmd carrying explicit `--foreground`, protecting `anet project up` + 7 internal demo call-sites. `anet node stop` now `tmux kill-session`s before SIGTERM.
- **`anet upgrade` overhaul — 4 packages, dual-channel, dry-run, self** (issue [#88](https://github.com/sleep2agi/agent-network/issues/88)) — covers `anet self` / `agent-node` / `commhub-server` / `dashboard`. Channel auto-detected (prerelease tag → preview, else latest); `--channel` overrides. `--dry-run` prints the plan only. `--self` is an opt-in detached spawn (default prints the manual command to avoid replacing the running CLI mid-upgrade). Plan rows carry action badges: `upgrade` / `up-to-date` / `lazy via npx skip` / `self skip` / `lookup failed`. The `commhub-server` row always shows `PINNED_SERVER_VERSION = 0.8.0` as a reminder that `anet hub start` runs the pinned version regardless of what's globally installed.
- **`anet.sh` install / upgrade scripts sync** (issue [#123](https://github.com/sleep2agi/agent-network/issues/123)) — the anet.sh one-shot scripts now match npm's dual-channel layout, with the Node 22.13 engine check baked in.

### New features — Runtime default-behavior transparency

- **`claude-agent-sdk` default = Claude Code preset** (issue [#101](https://github.com/sleep2agi/agent-network/issues/101) Option B) — root-cause fix: with no `tools` field in `config.json`, agent-node was passing the SDK `options.tools = undefined`, giving the agent zero built-in tools and producing hallucinated "network restricted" responses. Now agent-node falls back to the SDK `{ type: 'preset', preset: 'claude_code' }` sentinel — every agent gets WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / NotebookEdit by default. `--tools "all"` routes to the same preset (replaces the old hardcoded 8-tool list as the single source of truth).
- **Behavior-disclosure banner** ([#101](https://github.com/sleep2agi/agent-network/issues/101), per Vincent 4927) — `anet node create` prints a banner with the built-in tools + MCP tools + `dangerouslySkipPermissions=true` warning + restrict-tools / disable-auto-skip / inspect-current-set hints. `anet info <alias>` displays `tools:` + `flags:` lines for ad-hoc audits.
- **`anet ls -v` / `--verbose`** (companion to [#101](https://github.com/sleep2agi/agent-network/issues/101)) — prints a second line per node with `tools=...  permGate=on/off`.

### New features — Security hardening

- **Vendor token envRef mode** (issue [#125](https://github.com/sleep2agi/agent-network/issues/125), v0.9.0 P0 gate #2) — the `config.json` env map now accepts a tagged union: `string` (legacy, still works, with a one-shot deprecation banner) or `{ "_envRef": "VAR_NAME" }` (recommended — the secret stays in process.env and never touches disk). agent-node refuses to start (FATAL with remediation hint) if a referenced env var is unset — no more silent broken startup.
- **`anet node create` auto-rewrites secrets** — `saveCreatedNode` runs `rewritePlainSecretsToEnvRef()` before the first write. The detection heuristic — key suffix `/_TOKEN|_KEY|_SECRET|AUTH$/` or value prefix `/sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer/` — flips matching values to envRef, drops the original into the current `process.env` (so the immediate spawn works), and prints `export NAME='value'` lines for the user to persist in `~/.bashrc`.
- **`anet node migrate-token-to-envref <alias>`** — new command for migrating existing nodes in place. Writes `config.json.bak-<ts>`, rewrites + prints export lines; idempotent (non-secret and already-migrated values are left alone).
- **`anet doctor` enumerates plain-secret nodes** — passive scan + migrate suggestion (no `--fix`; per-node opt-in).

### New features — Observability

- **`GET /api/servers` REST endpoint** (issue [#119](https://github.com/sleep2agi/agent-network/issues/119), server commit 11a3018) — aggregates agents by `hostname` + `ip` and returns live host telemetry, used by the dashboard's "Servers" sidebar. Returns a **bare JSON array** (not the `{ok, ...}` wrapper). Marks 10-min-stale sessions offline before aggregating; network-scoped via `addNetworkScope`. Fields: `hostname` / `ip` / `agent_count` / `cpu_load_1min` / `cpu_cores` / `mem_avail_gb` / `mem_used_gb` / `last_seen`.
- **agent-node host telemetry** ([#119](https://github.com/sleep2agi/agent-network/issues/119) step 1, commit 5364931) — each `report_status` call now carries `host` fields. On Linux: `/proc/loadavg` + `/proc/meminfo` `MemAvailable` first. On macOS/Windows: falls back to `os.loadavg()` / `os.totalmem()` / `os.freemem()`. Windows `[0,0,0]` is actively coerced to `null`. A 10-second cache prevents burst reports.
- **Dashboard ServersDrawer** ([#119](https://github.com/sleep2agi/agent-network/issues/119) step 3) — UI sidebar shows aggregated agent counts per physical machine alongside live CPU / RAM bars.
- **Dashboard topology redo + 38 rounds of polish** (issues [#112](https://github.com/sleep2agi/agent-network/issues/112) + [#116](https://github.com/sleep2agi/agent-network/issues/116)) — grid + ring dual views; mount fade-in; hover ring focus; click ripple; label scaling; arrow tiers; offline dim; group-box hover; minimap; cwd tooltip; and 9+ further rounds of interaction polish.

### Documentation

- **GitHub README front-page overhaul** (issue [#118](https://github.com/sleep2agi/agent-network/issues/118), commit `2dd646d`) — Hero / Quick start / Demo / CTA promoted to the top; anet vs LangGraph/AutoGen/CrewAI 5×4 comparison table; trust signals (4 new badges + Star History chart); mermaid architecture diagram + node onboarding flow; ZH + EN parity.
- **docs-site catch-up sweep** (issue [#124](https://github.com/sleep2agi/agent-network/issues/124)) — bulk-syncs every new feature shipped today to anet.sh: `cli.md` / `upgrade.md` / `security.md` / `rest.md` / `CHANGELOG.md`, all ZH + EN.

### Breaking changes / Migration

- ⚠ **`anet node start` default changed** — from v0.9 preview onward it auto-wraps into a detached tmux session (v0.8 ran foreground). For scripts/CI, pass `--foreground` or `--no-tmux` explicitly.
- ⚠ **`claude-agent-sdk` node default toolset changed** — from empty to the full Claude Code preset (Bash / WebFetch / Write / …). Existing nodes with an explicit `tools` allowlist keep their old behavior; for new nodes, decide whether you need to narrow with `--tools Read,Glob,Grep`.
- ⚠ **Vendor secrets no longer persist plain in `config.json`** — newly created nodes go through envRef automatically; for existing plain-secret nodes run `anet node migrate-token-to-envref <alias>` for a one-shot migration. The plain-string path stays compatible for now (with a deprecation banner).
- ✅ **Preview version-number rule** ([per Vincent](https://github.com/sleep2agi/agent-network/issues/126)) — bump the `-preview.N+1` suffix within a preview chain; **do not bump the patch and reset preview.0** (avoids "backwards-looking" version numbers).

### Smoke validation (before promote)

```
1. plain fallback           — old config with "sk-..." still starts + shows the deprecation banner
2. envRef happy path        — { _envRef: "TEST_TOKEN" } + export TEST_TOKEN=fake → node receives the correct token
3. envRef missing var FATAL — case #2 without the export → startup FATAL + remediation hint
4. anet doctor scan         — mix of plain + envRef nodes → only plain ones surface under the warning
5. migrate idempotent       — plain → migrate → second run is a no-op + `.bak-<ts>` exists + export lines printed
6. anet node create auto    — `--env ANTHROPIC_AUTH_TOKEN=sk-fake` → config.json contains envRef, not literal sk-fake
```

See [issue #125](https://github.com/sleep2agi/agent-network/issues/125#issuecomment-4457630036) for full repro steps.

---

## 2026-05-14 — **v0.8.3 stable release** batch primitive + multi-demo + P0/UX fixes ✅ stable

**Version sync** (npm `latest` tag):
- `@sleep2agi/agent-network@2.1.9`
- `@sleep2agi/agent-node@2.3.1`
- `@sleep2agi/commhub-server@0.8.0` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.4.5`

> Note: agent-network 2.1.8 was skipped (an earlier stale build occupied the version); the stable release is 2.1.9.

### New features

- **`anet create --batch` batch agent primitive** (issue [#55](https://github.com/sleep2agi/agent-network/issues/55)) — spin up N identity-bearing agents in one line, `--prefix` auto-numbering, per-node working dir + config + tmux session; `anet batch <verb>` for lifecycle management (list/stop/cleanup/start/restart).
- **`anet demo sci-team`** (issue [#51](https://github.com/sleep2agi/agent-network/issues/51)) — research-squad demo: 1 leader + N-1 workers with active fan-out collaboration.
- **`anet demo pr-review`** (issue [#41](https://github.com/sleep2agi/agent-network/issues/41)) — 4-agent PR review room demo.
- **`anet login` first-time login guidance** (issue [#58](https://github.com/sleep2agi/agent-network/issues/58)) — on auth failure, points to register / default account / hub admin reset-user.
- **claude-agent-sdk model dropdown verified vendor presets** (issue [#48](https://github.com/sleep2agi/agent-network/issues/48)) — MiniMax + Intern (书生).
- **SDK upgrades** — codex-sdk / claude-agent-sdk / inquirer dependency bumps.

### Fixes

- **batch node identity injection** (issue [#93](https://github.com/sleep2agi/agent-network/issues/93), P0) — batch-created nodes previously didn't know their own alias; now per-node identity prefix is injected.
- **`anet hub dashboard` npx cache self-heal** (issue [#89](https://github.com/sleep2agi/agent-network/issues/89), P0) — auto-cleans stale staging dirs before spawn.
- **`anet hub dashboard` release channel matching** (issue [#61](https://github.com/sleep2agi/agent-network/issues/61)) — dashboard version now dynamically matches the anet channel.
- **`anet init` token prompt UX + session count** (issue [#56](https://github.com/sleep2agi/agent-network/issues/56)).
- **shell removed from process spawn** (issue [#36](https://github.com/sleep2agi/agent-network/issues/36)) — eliminates command injection surface.
- **claude-agent-sdk env injection + timeout guard** (issue [#98](https://github.com/sleep2agi/agent-network/issues/98), partial fix) — config.json env block now injected on the `--config` startup path; claude calls get a wall-clock timeout guard so hangs surface as visible timeout errors.
- **PINNED commhub-server → 0.8.0 stable**.

### Package change details

- **agent-network** 2.1.7 → 2.1.9 (13 preview iterations accumulated)
- **agent-node** 2.3.0 → 2.3.1 — claude-agent-sdk / codex-sdk dependency bumps + #98 fixes
- **commhub-server** 0.8.0 *(unchanged)*
- **agent-network-dashboard** 0.4.2 → 0.4.5 — tri-ring layout / alias avatars / fullscreen zoom / prefix grouping / Intern avatars / label-overlap fix / trial badge removal

---

## 2026-05-12 — **v0.8.2 stable release** telegram channel + claude-code-cli session resume ✅ stable

**Version sync** (npm `latest` tag):
- `@sleep2agi/agent-network@2.1.7`
- `@sleep2agi/commhub-server@0.8.0` *(unchanged)*
- `@sleep2agi/agent-node@2.3.0` *(unchanged)*

**Related**: issue [#13](https://github.com/sleep2agi/agent-network/issues/13) (closed) · issue [#14](https://github.com/sleep2agi/agent-network/issues/14) · commit [143b2a1](https://github.com/sleep2agi/agent-network/commit/143b2a1) (`release: 2.1.7 stable`) · commit [f1e3d9c](https://github.com/sleep2agi/agent-network/commit/f1e3d9c) (`fix(cli): bind claude code sessions on first start`)

### New features

- **`anet channel add telegram` one-shot bind** — attaches a Telegram bot token + allow-user to an existing node, auto-generates the `channels/telegram` config (see [cases/telegram-squad](/en/cases/telegram-squad) for details).

### Fixes

- `claude-code-cli` runtime now pre-generates a Claude session UUID when creating a node.
- First start binds a fixed session with `claude --session-id <uuid>`; once `~/.claude/projects/<cwd>/<uuid>.jsonl` exists on the local machine, subsequent starts switch to `claude --resume <uuid>` to continue the same conversation — `anet node start` no longer accidentally opens a new chat.
- `anet node start --new-session` generates and saves a fresh session UUID.

---

## 2026-05-11 — **v0.8.1 patch** Dashboard SSE-online global fix ✅ stable

**Version sync** (npm `latest` tag, git tag `v0.8.1`):
- `@sleep2agi/commhub-server@0.8.0` *(unchanged)*
- `@sleep2agi/agent-network@2.1.5`
- `@sleep2agi/agent-network-dashboard@0.4.2`
- `@sleep2agi/agent-node@2.3.0` *(unchanged)*

### Fixes

- Dashboard `/nodes`, `/admin`, and `/api/hub/session` all showed every agent as offline because the SSE key in server v0.7+ became `network_id:alias`. The 0.4.1 fix missed these three; 0.4.2 adds alias-fallback to all global SSE lookups.
- CLI bumps `PINNED_DASHBOARD_VERSION` to 0.4.2 so `anet hub dashboard` pulls the patched version.

---

## 2026-05-11 — **v0.8.0 stable release** 🎉 RFC-001 phase 2 landed ✅ stable

**Version sync** (git tag `v0.8.0`):
- `@sleep2agi/commhub-server@0.8.0`
- `@sleep2agi/agent-network@2.1.4`
- `@sleep2agi/agent-network-dashboard@0.4.1`
- `@sleep2agi/agent-node@2.3.0` *(unchanged)*

### Auth changes

- `COMMHUB_AUTH_TOKEN` is now soft-deprecated: v0.8 keeps only `/api/*` read-side compat and logs a warning; v1.0 removes it entirely.
- First `anet hub start` bootstraps a default admin account (**`admin / anethub`** quick-start default) and writes a local recovery admin `utok_` to `~/.anet/server/admin-utok.json` (`chmod 600`). **Public deployments must immediately `anet passwd` to a strong password.**
- Subsequent `anet hub start` is idempotent: if `admin-utok.json` exists it skips bootstrap and no longer prompts.
- Dashboard moved to browser-cookie passthrough (thin proxy mode — the full 0-token model lands later in v0.8.x).
- tmux and admin endpoints now require an admin `utok_`.

### Password management

- `anet passwd` prompts for old / new / confirm by default; `--old` / `--new` still supported.
- Successful change rotates the current device's `utok_`; other devices lose their `utok_` automatically. Agent `ntok_` are unaffected.
- New: `anet hub admin reset-user --username <u>` — hub-host-only recovery for non-admin users, emits a `password_reset_by_admin` audit event.
- User-chosen passwords require ≥ 8 chars + are checked against the top-1000 weak-password dictionary. The first-run bootstrap admin password is exempt (≥ 4 is accepted) since it must be rotated immediately anyway.

### Doctor enhancements

- `anet doctor --fix` now **actively probes every node's `ntok_`** against the hub. On 401/403 it auto-reissues a fresh `ntok_` from the current `utok_` and **patches the file in place** — `session_id` / `channels` / `runtime` / `role` are all preserved. This covers the "hub DB wiped / token revoked" failure mode.

### CLI / UX

- `anet hub start` is silent auto-generate by default and no longer interrupts startup with prompts.
- `anet login` prints ✅ and a next-step hint; double-colon prompt bug fixed.
- CLI error output switched from the flat `[anet]` prefix to ✅ / ❌ visual markers.

### Dashboard 0.4.1

- Fixed Command Mesh's `sse:undefined`: SSE key in server v0.7+ became `network_id:alias`; dashboard now queries with the double-layer key, with alias-only fallback for older hubs.
- Light / Mint theme solid-button polish (regressions since 0.3.4).

---

## 2026-05-10 — **v2.1 stable release**

**Version sync** (git tag `v2.1.0`):
- `@sleep2agi/agent-network@2.1.0`
- `@sleep2agi/commhub-server@0.6.0`
- `@sleep2agi/agent-node@2.3.0`
- `@sleep2agi/agent-network-dashboard@0.3.0`

::: tip Install
```bash
npm install -g @sleep2agi/agent-network
```
No more `@preview` tag needed — `latest` is now the stable line.
:::

### What's new

**`anet doctor --fix` auto-migrates legacy V2 nodes**
Frontline pain point: `claude-code-cli` runtime hit many V2-era node configs (with `alias`/`resume`/no token / dev IP for hub) that throw `utok_ but SSE needs ntok_` against the V3 hub. `doctor` now:
- Detects 6 classes of legacy config issues (renamed fields, runtime rename, stale hub, missing token, unprefixed token, missing node_id)
- One-shot `--fix` migration; **preserves the session field so chat history is not lost**, re-issues `ntok_`

**`anet demo` subcommand family**
- `anet demo ls` — list demos
- `anet demo debate` — 6-agent, 9-step debate
- `anet demo socialmedia` — 4-agent social media content factory (Xiaohongshu / Twitter / WeChat / LinkedIn)
- Defaults to a standalone `demo-<suffix>` network, auto-cleaned afterwards — **never pollutes `default`**

**Hub telemetry fixes**
- `POST /api/task` now double-writes the inbox + tasks tables (previously only the inbox, which left the Dashboard Tasks page empty and `send_reply` unable to find tasks)
- Dispatching a task immediately UPDATEs `sessions.task` + `updated_at` so the Dashboard Overview reflects "task in flight" in real time

**Dashboard theming**
- 4 themes: Cyber (default dark) / Light / Mint / Sunset, switcher bottom-right, persisted in localStorage
- Fixed the `useSSE` reconnect loop (the hub used to receive 1500+ admin SSE reconnects that DoSed mcp)
- `COMMHUB_URL` fallback restored to `127.0.0.1:9200` (was a leftover dev IP)

**CLI**
- `--runtime http-api` no longer falls into the Claude CLI branch
- `agent-node` HTTP runtime now also reads `ANTHROPIC_AUTH_TOKEN` (previously only `ANTHROPIC_API_KEY`)
- Demo subcommands no longer trigger 6 "select provider" interactive prompts when calling `createCommand`

**One-shot deploy scripts**
- `hub-only.sh` rewritten: 4G swap + sudoers NOPASSWD + enable-linger + systemd autostart + `AUTOSTART=1`
- `agent-only.sh` updated to match

### Upgrade path

```bash
# 1. Upgrade the CLI
npm install -g @sleep2agi/agent-network    # or: npm update -g

# 2. Restart the hub (so the new commhub-server takes effect)
# tmux: tmux kill-session -t hub; tmux new -d -s hub 'anet hub start'
# systemd-user: systemctl --user restart anet-hub

# 3. In every legacy project directory, run doctor --fix
cd <project-dir>
anet doctor --fix

# 4. Restart agents
kill <claude-pid> && anet resume <node-name>
```

See the [Upgrade Guide](/en/guide/upgrade) for details.

---

## 2026-05-03 - `anet demo` subcommands and bug fixes

**Version sync**: anet@2.0.3-preview.4 / agent-node@2.2.0-preview.1 / dashboard@0.2.1-preview.1 / commhub-server@0.5.3-preview.0

### New Features

- **`anet demo ls`** - list available demos
- **`anet demo debate`** - one-command 6-agent debate demo
  - `--topic "..."` debate topic
  - `--key sk-cp-xxx` MiniMax API key, defaulting to `$MINIMAX_KEY`
  - `--quick` shortened 4-step run
  - `--keep` keep temporary agents and network after the run
  - `--out path.md` transcript output path
- **`anet demo monitor`** - kept as the old `anet demo --live` alias

### Fixes

- **anet CLI**: `--runtime http-api` now starts through `agent-node` instead of falling into the Claude CLI branch.
- **agent-node**: HTTP runtime reads `ANTHROPIC_AUTH_TOKEN` for MiniMax-compatible configs.
- **dashboard**: fixed repeated SSE reconnects caused by inline `onEvent` callbacks.
- **hub-only.sh**: rewritten with swap setup, sudoers NOPASSWD, linger, and optional systemd user autostart.

---

## 2026-04-30 - Parent Task Lineage + Auto-Chain Reply

**commhub-server@0.5.3-preview.0**

- Added `parent_task_id` to tasks and `chainReplyToParent()` to keep multi-agent chains connected.
- `send_task` accepts `parent_task_id` and can infer it from the caller's recent open task.
- `send_reply` / `report_completion` forward results up the parent chain automatically.
- `agent-node` injects `CURRENT_TASK_ID` and prompts the LLM to pass `parent_task_id`.

---

## 2026-04-26 - Hub Server Logs Page + V2 Lineage Foundation

**commhub-server@0.5.2-preview.0 / dashboard@0.2.1-preview.0 / anet@2.0.3-preview.1**

- Dashboard `/server-logs` page for live hub stdout.
- REST `GET /api/server-logs` for admin users.
- Hub banner and `/health` show the published version.

---

## 2026-04-15 - V3 Stable: Multi-Network + User System + Trial License

**Agent Network V3 - Multi-Network + Commercial Ready** (`commhub-server` 0.5.x, `anet` 2.0.x)

- Multi-network isolation for nodes, tasks, and sessions.
- Username/password accounts, JWT, and the `utok_` + `ntok_` token system.
- 14-day trial licensing and Pro activation.
- 39 CLI commands, 17 MCP tools, and 17 REST endpoint families.
- 3 runtimes: `claude-agent-sdk`, `codex-sdk`, and `http-api`.
- Audit logs, rate limiting, and PostgreSQL support through the `DbAdapter`.

---

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

**New features**:
- **PostgreSQL support**: Enable via `DATABASE_URL=postgres://...` (SQLite remains the default)
- **DbAdapter interface**: Unified database abstraction layer (SQLiteAdapter + PgAdapter)
- **SQL auto-translator**: `sqliteToPostgres()` handles datetime->NOW, ?N->$N, AUTOINCREMENT->SERIAL
- **34 CLI commands**: Added passwd, token (create/ls/revoke), network (info/rename/delete), demo, config, license, activate, hub start
- **17 REST endpoints**: Added PUT /api/networks/:id, DELETE /api/networks/:id, POST /api/auth/password, token CRUD
- **One-click demo**: `bash examples/demo-one-click.sh` -- 60-second automated demo
- **createAdapter() factory**: Environment-driven database selection

**Architecture improvements**:
- All 85+ `db.query()` calls migrated to adapter methods (`db.get()`, `db.all()`, `db.run()`)
- All 7 manual `BEGIN/COMMIT/ROLLBACK` transactions converted to `db.transaction()`
- Zero raw database access -- all code goes through the `DbAdapter` interface
- SQL translator handles 161 SQL fragments across 4 source files

**Testing**:
- 200 Docker E2E tests (137 core + 25 auth + 22 network + 16 config)
- 19 adapter-specific E2E tests
- 10 SQL translator unit tests

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 -- Multi-Network + Commercial Ready

**New features**:
- **Multi-network support**: Create isolated networks, each with independent nodes/tasks/sessions
- **User system**: Username + password registration/login, API token authentication
- **Trial licensing**: 14-day free trial, license key activation for Pro
- **39 CLI commands**: quickstart, login, register, passwd, token, network (create/ls/use/info/rename/delete), status, tasks, doctor, info, logs, demo, config, license, activate, hub start...
- **17 MCP tools**: send_task, send_reply, retry_task, cancel_task, reassign_task, list_tasks, get_task...
- **17 REST endpoints**: /api/auth/*, /api/networks/*, /api/tasks, /api/nodes, /api/stats, /api/audit-log, /api/license...
- **2 AI runtimes**: codex-sdk (OpenAI Codex / GPT-5), claude-agent-sdk (Claude / MiniMax / OpenAI-compatible)
- **Audit logging**: All user operations + task state changes recorded
- **Rate limiting**: Registration 30/min, login 10/min per IP

**Security**:
- MCP/SSE/WebSocket authentication
- Server-side enforced network_id (token-bound, client cannot override)
- SQL injection fix (all parameterized queries)
- Network ownership checks (cross-user access returns 403)
- Password hashing (SHA-256)
- Localhost rate limit exemption (dev/testing)

**Database (13 tables)**:
sessions, inbox, tasks, nodes, completions, task_events, users, networks, api_tokens, audit_log, licenses, network_members, network_invites

**Testing (200 regression tests)**:
- Core E2E: 137 tests (node lifecycle, message lifecycle, auth, authorization, SSE, concurrency)
- Auth suite: 25 tests (registration, login, token, profile, password, audit, rate limiting)
- Network suite: 22 tests (CRUD, isolation, ownership, rename, delete, cross-user)
- Config priority: 16 tests (CLI > env > project > global)
- Real AI: Codex (GPT-5) + MiniMax (Anthropic API) verified
- 10-agent idiom chain (mixed codex + minimax)

**npm packages**:
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent runtime)
- @sleep2agi/commhub-server (Communication hub)

---

## v0.x (2026-03 ~ 2026-04-09) -- Pre-V3

### Core Feature Development

- **CommHub Server**: MCP + SSE-based communication hub
- **agent-node**: Dual-engine runtime (Claude + Codex)
- **anet CLI**: create / start / resume / channel and other basic commands
- **Dashboard**: Initial version
- **Message types**: task / reply / message / ack type differentiation
- **Channel plugins**: Claude Code CommHub integration

### Early Milestones

| Version | Date | Content |
|------|------|------|
| v0.1 | Early 2026-03 | Basic CommHub + SSE |
| v0.3 | Mid 2026-03 | agent-node dual engine |
| v0.5 | Late 2026-03 | anet CLI + Channel |
| v0.7 | Early 2026-04 | Dashboard + message types |
| v0.9 | 2026-04-09 | Multi-model support (MiniMax, InternLM) |

---

## Roadmap

### v0.9 — Security hardening
- Argon2id password hashing (currently SHA-256)
- `utok_` / `ntok_` TTL + revoke-all
- Install-script checksum verification
- Dashboard full 0-token model finishing touches

### v1.0 — Cleanup + public networks
- Remove `COMMHUB_AUTH_TOKEN` compat path entirely
- Token scope (full / agent / readonly) full implementation
- Public / invite-hybrid networks (member application + owner approval flow)
- Per-role button visibility in Dashboard

### Later
- ~~Continued PostgreSQL adapter improvements~~ — adapter interface kept as extension point, but **v0.8+ product direction is SQLite only** (see [docs/v3-postgresql-design.md banner](https://github.com/sleep2agi/agent-network/blob/main/docs/v3-postgresql-design.md))
- SSO integration
- Webhook callbacks
- Cron-style task scheduling

## Next steps

- [Upgrade guide](/en/guide/upgrade) — v0.7 → v0.8 behavior changes + standard steps
- [Architecture](/en/guide/architecture) — how each release accumulated into the current system
- [GitHub Releases](https://github.com/sleep2agi/agent-network/releases) — per-tag release notes
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — v0.8 ~ v1.0 master-token deprecation roadmap
