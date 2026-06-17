# Changelog

::: info Versioning note
This log runs reverse-chronologically. **The version scheme was reshuffled once**:
- **From 2026-05 onward**: gradual v0.6 → v0.7 → v0.8 → v0.9 → v0.10 releases; the `v0.X.Y` format mirrors `commhub-server`'s `0.X.Y` semver style.
- **Before 2026-04**: used `v1.0.0-preview.N` / `v2.1` style version numbers that overpromised. Deprecated.
- **Current stable**: follow npm `latest` and GitHub Releases; v0.8.1 was the first Apache 2.0 OSS release.
- Older entries kept for git-blame continuity — see v1.0.0-preview / v2.1 / v0.x sections below.
:::

## v0.10.13 — **`grok-build-acp` `session/prompt` 300s timeout hang fix (P0 hotfix)** (2026-06-08) ✅ stable

**Version alignment** (npm `latest` tag):
- `@sleep2agi/agent-node@2.4.9` ← bumped ([#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — ACP `handleServerRequest` non-integer error-code coerce fix)
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged (PINNED)

### 🌟 Highlights

#### Root cause + fix for `grok-build-acp` nodes hanging at `session/prompt timed out after 300000ms`

**Symptom**: A `grok-build-acp` runtime node accepts a second task, hangs for ≈5 min, then agent-node reports `grok ACP request 'session/prompt' timed out after 300000ms`. ai-insight's `A站Grok` node (grok 0.2.29 alpha) captured the exact 2026-06-07 19:53:09 log:

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
- ai-insight's `A站Grok` node passed UAT after installing `2.4.9-preview.0` globally

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

Bug repro + root cause + UAT: live 19:53:09 capture + Vincent's `A站Grok` 47 s pilot; fix implementation: commit `4818776` + 2 regression tests; release ops: Method B two-phase + dual Install/Upgrade release notes sections.

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
- P0 smoke sent `/tmp/anet-image-smoke.png` to `通信测试牛`; node logs showed `+1 image(s)` / `→ processing [codex] +1 image(s)`, with reply `图片通道OK`.

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

Wires through [RFC-014](https://github.com/sleep2agi/agent-network/issues/99) — `GET /api/server/:host/health` now returns disk's three fields, the 24h bucketed history includes `disk_avail_min` / `disk_used_max`, and `alert_level` adds `disk < 1GB critical / < 5GB warn` triggers ([`server/src/index.ts:253-258`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L253)).

Test lead Docker Linux smoke 3/3 PASS (disk 299.8 GB total / 216 used / 71.5 avail, alert green, backward compat verified).

### Hero D — Dashboard topology prefix-label UX, Option C (dashboard `0.5.1`)

[#147](https://github.com/sleep2agi/agent-network/issues/147) (acked 5/16) + Option C landed:

- Topology node prefix labels (the node→group edge labels' distinguishability) ship with the Option C design (dashboard team design pass)
- Disk telemetry hover-card rendering (`disk_total_gb` / `disk_used_gb` / `disk_avail_gb` wired to the [`GET /api/server/:host/health`](/en/api/rest#get-api-server-host-health) response)
- 100+ rounds of typography + corner-radius cascade polish

Dashboard team design pass + 4/4 verify (commit `7de97ee` + screenshot evidence, local ship `f9c83cd`).

### Closed issues

- [#99](https://github.com/sleep2agi/agent-network/issues/99) per-server daemon Phase 2 close gate met (host metrics fully wired, Hero A disk shipped)
- [#147](https://github.com/sleep2agi/agent-network/issues/147) Hero D (5/16 ack → Option C shipped)

### RFC artifacts preserved (v0.12.0 scope)

v0.10.2 is a hotfix scope (no v0.11.0-series RFC ship); three RFC artifacts are preserved as v0.12.0 candidates:

- [RFC-013 v5](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-013-rename-hot-reload.md) rename hot-reload (third-pass review complete)
- [RFC-014 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-014-daemon-phase2-host-metrics.md) daemon Phase 2 host metrics (Hero A final 10% shipped in v0.10.2)
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

[`agent-network/bin/cli.ts:61` `PINNED_SERVER_VERSION`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L61) was never bumped across the v0.9.x + v0.10.0 promotes — it stayed hardcoded at `0.8.0`. That meant `anet hub start` was actually running `bunx --bun @sleep2agi/commhub-server@0.8.0` ([cli.ts:2589](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2589)) — the old server, not the v0.10.0-shipped `0.8.2`. Direct impact:

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

## v0.9.2 — **Patch: Auth fast-fail + fan-out retry + wizard redo + #122 default-tmux reverted** (2026-05-16) ✅ stable

**Version sync** (npm `latest` tag):
- `@sleep2agi/agent-network@2.1.15`
- `@sleep2agi/agent-node@2.3.10`
- `@sleep2agi/commhub-server@0.8.1` *(unchanged)*
- `@sleep2agi/agent-network-dashboard@0.4.6` *(unchanged)*

> The release flow follows the [v0.9.0 split-brain lessons (#126)](https://github.com/sleep2agi/agent-network/issues/126) two-phase publish SOP (first `--tag preview` to upload + curl-verify the tarball returns HTTP 200, then `npm dist-tag add @<v> latest`), which avoids the `npm publish --tag latest` direct path's split-brain in the CDN async window. The version numbers themselves are clean semver (no `-preview.N` suffix — easier for `anet upgrade` comparison + npm range resolution).

### 5 P0 fix chain

**1. [#129](https://github.com/sleep2agi/agent-network/issues/129) Vendor API auth fast-fail + vendor-specific URL hint** ([`9840cf3`](https://github.com/sleep2agi/agent-network/commit/9840cf3))
Background: when an intern key expired, agent-node previously silently waited 120s then printed a generic "claude-agent-sdk 调用超时" error. Now the `isAuthError(msg)` heuristic covers the Anthropic standard (401/403, `invalid_api_key`, `authentication_error`) plus intern's A02xx family (`user_token_expired`) plus generic OpenAI-compat 401 envelopes (`unauthorized` / `expired_token`); on hit it **short-circuits the retry loop** (retrying with the same bad key just wastes the backoff window) and prints a **vendor-specific URL hint** based on `ANTHROPIC_BASE_URL` host (intern → `chat.intern-ai.org.cn`, minimax → `platform.minimaxi.com`, anthropic → `console.anthropic.com`, otherwise generic). The clear error returns in **under 5 seconds** instead of the 15 minutes pre-v0.9.1 took. Full write-up: [troubleshooting → Vendor API auth failure](/en/troubleshooting#vendor-api-auth-failure-401-invalid_api_key-expired_token-intern-a02xx-user_token_expired).

**2. [#132 Tier 1](https://github.com/sleep2agi/agent-network/issues/132) Fan-out timeout + retry-with-backoff** (same commit [`9840cf3`](https://github.com/sleep2agi/agent-network/commit/9840cf3))
The [SDK concurrency investigation Phase 3](https://github.com/sleep2agi/agent-network/blob/main/docs/research/sdk-concurrency-investigation.md): in a 30-agent papercope fan-out demo, intern API per-request latency stretched to 17-37s (10-20× the 1.57s single-agent baseline), so the old 120s timeout fired mid-stream and 25 / 30 sub-agents silently failed. Two changes:
- `CLAUDE_TIMEOUT_MS` default 120000 → **300000** (300s, leaves room for the intern queue to drain)
- New `CLAUDE_MAX_RETRIES` env var, default `2` (3 attempts total); on transient errors / timeouts, backoff `4s, 8s + 0-1s jitter` (jitter spreads herd retries across the recovering vendor queue); auth-class errors **do not** retry (handled by #129 fast-fail above)

Set `CLAUDE_MAX_RETRIES=0` to revert to the v0.9.1 no-retry behavior.

**3. [#133](https://github.com/sleep2agi/agent-network/issues/133) `anet node create` runtime-first wizard** ([`29fd290`](https://github.com/sleep2agi/agent-network/commit/29fd290))
Vincent catch: the old vendor-first selector enumerated only claude-agent-sdk vendors (intern / MiniMax / Claude / GLM / ...), leaving users who want `claude-code-cli` (Anthropic Max plan + local `claude` CLI login) or `codex-sdk` (OpenAI `codex auth login`) **implicitly stuck** — they had to know to pass `--runtime codex-sdk` to skip the vendor picker. New flow:
1. `selectRuntime()` 3-way picker: `claude-agent-sdk` / `claude-code-cli` / `codex-sdk`
2. `claude-agent-sdk` → continues into `selectVendorAndModel()` (existing flow)
3. `claude-code-cli` → prints `claude auth login` hint, skips vendor
4. `codex-sdk` → prints `codex auth login` hint, skips vendor

Backward-compatible: explicit `--runtime <X>` still skips the picker; demo / batch / scripted callers that already inject credentials via `--env` are unaffected.

**4. [#136](https://github.com/sleep2agi/agent-network/issues/136) Revert v0.9.0 #122 default-detached-tmux** ([`a3a3fd4`](https://github.com/sleep2agi/agent-network/commit/a3a3fd4))
Background: detached tmux + bun claude-code-cli calling `setRawMode` triggers `errno 5 (EIO)` on macOS — the detached child's stdio is not a real PTY. Reverts the brief v0.9.0 four-condition wrap matrix:
- `anet node start <alias>` → **foreground by default** (fixes the macOS bug)
- `anet node start <alias> --tmux` → `tmux new -As <alias>` in **attached** mode (keeps the PTY chain intact, no setRawMode bug)

Removes the `--foreground` / `--no-tmux` / `--attach` flags (foreground is the default; `--tmux` already attaches). `anet project up`'s internal `startNodeTmuxSession` path **still uses detached** (which can re-trigger setRawMode on macOS bun — follow-up tracking).

**5. Wizard silent-exit fix chain [#135](https://github.com/sleep2agi/agent-network/issues/135) / [#138](https://github.com/sleep2agi/agent-network/issues/138) / [#139](https://github.com/sleep2agi/agent-network/issues/139)**
- **#135** Node v24 top-level-await warning ([`fa08eb4`](https://github.com/sleep2agi/agent-network/commit/fa08eb4) v3): wrap dispatch in an `async main()` to fix the root cause
- **#138** `@inquirer/prompts` + `readline` ask() stdin mismatch ([`b8c5885`](https://github.com/sleep2agi/agent-network/commit/b8c5885) preview.5 + [`596cfe9`](https://github.com/sleep2agi/agent-network/commit/596cfe9) preview.6): the wizard silently exiting after `select()` is fixed + `launchAgent` now `await`s its child before the parent exits
- **#139** dispatch — add `await` to 5 async commands ([`15cf6de`](https://github.com/sleep2agi/agent-network/commit/15cf6de) preview.7)

Pairs with #133's runtime-first wizard to keep the interactive wizard stable on Node v24.

### 6 SOP updates

- **Two-phase publish SOP** continues (v0.9.0 split-brain lessons #126) — avoid the `npm --tag latest` direct path
- **macOS PTY edge case** enters the release smoke checklist (detached tmux + setRawMode)
- **Fan-out / high-concurrency timeout tuning is documented**: [troubleshooting Vendor API timeout section](/en/troubleshooting#vendor-api-timeout-high-concurrency-fan-out-132-retry-with-backoff) + [agent-node.md env table](/en/guide/agent-node#environment-variables)
- **Runtime-first wizard split: `anet create` vs `--batch`** — the batch wizard is still vendor-first (it uses `selectVendorAndModel()` but does not go through `selectRuntime()`), and the docs now disambiguate explicitly
- **`CLAUDE_MAX_RETRIES=0` opt-out** — keeps a path back to v0.9.1 no-retry behavior for debugging / legacy scripts
- **Vendor-specific remediation-hint routing** is now a design principle — every newly verified vendor must ship a remediation URL hint

### Breaking changes / Migration

- ⚠ **`anet node start` default behavior swung again** (v0.9.0 → v0.9.1 brief detached → v0.9.2 reverted to foreground): the `--foreground` / `--no-tmux` flags scripts/CI added in v0.9.1 are **removed in v0.9.2** (foreground is the default, no flag needed); for tmux, opt in with `--tmux` (attached mode)
- ⚠ **`anet node create` interactive flow changed** (vendor-first → runtime-first): scripted `--runtime <X>` still skips the picker, so **no backward-compat issue**; the interactive UX improves (all 3 runtimes are first-class)
- ⚠ **`CLAUDE_TIMEOUT_MS` default 120 → 300**: scripts that already explicitly override to a shorter timeout are unaffected; the default is more tolerant of fan-out scenarios
- ✅ **New `CLAUDE_MAX_RETRIES` env var**: default `2` (3 attempts total). Set `0` to revert to v0.9.1's no-retry behavior

---

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
- **`anet node start` auto-wraps into detached tmux** (issue [#122](https://github.com/sleep2agi/agent-network/issues/122), ⚠ **reverted in v0.9.2**, see [#136](https://github.com/sleep2agi/agent-network/issues/136)) — v0.9.0 briefly introduced a 4-condition wrap matrix (TTY + `$TMUX` not set + tmux installed + no same-name session) with `--foreground` / `--no-tmux` / `--attach` flags and a two-layer recursion guard. **v0.9.2 reverts**: macOS bun triggered `setRawMode errno 5` under detached tmux (the detached child's stdio isn't a real PTY), so the new design is foreground-by-default + `--tmux` opt-in **attached** mode (keeps the PTY chain intact). `anet node stop` still kills the tmux session before SIGTERM.
- **`anet upgrade` overhaul — 4 packages, dual-channel, dry-run, self** (issue [#88](https://github.com/sleep2agi/agent-network/issues/88)) — covers `anet self` / `agent-node` / `commhub-server` / `dashboard`. Channel auto-detected (prerelease tag → preview, else latest); `--channel` overrides. `--dry-run` prints the plan only. `--self` is an opt-in detached spawn (default prints the manual command to avoid replacing the running CLI mid-upgrade). Plan rows carry action badges: `upgrade` / `up-to-date` / `lazy via npx skip` / `self skip` / `lookup failed`. The `commhub-server` row always shows `PINNED_SERVER_VERSION = 0.8.0` as a reminder that `anet hub start` runs the pinned version regardless of what's globally installed.
- **`anet.sh` install / upgrade scripts sync** (issue [#123](https://github.com/sleep2agi/agent-network/issues/123)) — the anet.sh one-shot scripts now match npm's dual-channel layout, with the Node 22.13 engine check baked in.

### New features — Runtime default-behavior transparency

- **`claude-agent-sdk` default = Claude Code preset** (issue [#101](https://github.com/sleep2agi/agent-network/issues/101) Option B) — root-cause fix: with no `tools` field in `config.json`, agent-node was passing the SDK `options.tools = undefined`, giving the agent zero built-in tools and producing hallucinated "network restricted" responses. Now agent-node falls back to the SDK `{ type: 'preset', preset: 'claude_code' }` sentinel — every agent gets WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / NotebookEdit by default. `--tools "all"` routes to the same preset (replaces the old hardcoded 8-tool list as the single source of truth).
- **Behavior-disclosure banner** ([#101](https://github.com/sleep2agi/agent-network/issues/101), per Vincent) — `anet node create` prints a banner with the built-in tools + MCP tools + `dangerouslySkipPermissions=true` warning + restrict-tools / disable-auto-skip / inspect-current-set hints. `anet info <alias>` displays `tools:` + `flags:` lines for ad-hoc audits.
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

- ⚠ **`anet node start` default changed (v0.9.0 only, reverted in v0.9.2)** — v0.9.0 briefly auto-wrapped into a detached tmux session (v0.8 ran foreground), but v0.9.2 via [#136](https://github.com/sleep2agi/agent-network/issues/136) **reverts to foreground default** (macOS bun setRawMode bug). Scripts/CI on v0.9.1 still need `--foreground` / `--no-tmux`; v0.9.2+ is foreground by default with no flag needed. For tmux, opt in with `--tmux` (attached mode).
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

- **`anet channel add telegram` one-shot bind** — attaches a Telegram bot token + allow-user to an existing node, auto-generates the `channels/telegram` config (see cases/telegram-squad for details).

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
