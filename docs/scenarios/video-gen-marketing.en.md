# Video Generation — anet × Grok Build Marketing Video Scenario

> **Scenario goal**: Add a video-generation **capability** to anet's `grok-build-acp` runtime nodes — one of the two flagship scenarios under [#205](https://github.com/sleep2agi/agent-network/issues/205) ([#70](https://github.com/sleep2agi/agent-network/issues/70)).
> **Status**: Step 2 artifact pipeline implementation shipped.
> **Owners**: 工程马 (release ops) + 通信SDK马 (agent-node author)

## One-liner

Wire Grok's native `video_gen` tool (which writes session-private mp4 files locally) into anet so that any node can dispatch a generation task via commhub to a grok-build node. The video file is **automatically extracted to the per-node artifacts directory**, and the receiver / upstream can pick up the path directly.

## User flow (TL;DR)

### Spin up a grok node

```bash
# 1. One-time: log into grok (browser OAuth)
grok login

# 2. Create + start the anet node in your project cwd
anet node create grok-marketing --runtime grok-build-acp
anet node start grok-marketing
```

> Requires `@sleep2agi/agent-node` >= `2.4.7-preview.7` (which includes #204 isolated cwd + #205 Step 2 artifact extractor).

### Dispatch a generation task

From any anet node (claude / codex / grok / human):

```
commhub_send_task(
  alias="grok-marketing",
  task="Generate a 12-second product promo video for the Agent Network
        project — dark tech aesthetic, multi-agent collaboration vibe,
        Chinese overlay '多 Agent，一行命令'"
)
```

`grok-marketing` receives the task → the Grok LLM autoregressively calls `video_gen` → the file lands in Grok's session-private dir → **agent-node copies it to `<cwd>/.anet/nodes/grok-marketing/artifacts/<timestamp>-1.mp4` (mode 0644)** → the reply text gets a trailer:

```
[LLM natural-language summary]
I've generated the video as requested...

📹 视频已生成 / Video artifact(s):
  - /home/user/project/.anet/nodes/grok-marketing/artifacts/2026-05-28T15-30-00Z-1.mp4  (5.30 MB)
```

The receiver / upstream opens that absolute path.

## Internals

### Post-turn scan (not fs.watch)

The pure helper `extractGrokArtifacts()` in `agent-node/src/grok-artifact-extractor.ts` is called **once after `runOnce` resolves** inside `processWithGrok`:

```ts
// agent-node/src/cli.ts processWithGrok, after runOnce completes
const extracted = extractGrokArtifacts({
  nodeKey: NODE_ID || ALIAS,
  userCwd: process.cwd(),
  grokSessionDir: `~/.grok/sessions/${encodeURIComponent(grokCwd)}/${grokSessionId}`,
});
replyText += formatArtifactTrailer(extracted.artifacts);
```

Why post-turn vs. fs.watch:
- **Race-free**: Grok turn completed ⇒ mp4 fully fsync'd, no partial-write.
- **Atomic**: one shot over `videos/`, no incremental dedup logic.
- **Deterministic**: fires in lockstep with the LLM reply — never misses, never duplicates.

### Path conventions

| Kind | Path |
|---|---|
| Grok's raw session video (mode 0600, private) | `~/.grok/sessions/<URL-encoded cwd>/<sessId>/videos/N.mp4` |
| anet artifact copy (mode 0644, user-readable) | `<cwd>/.anet/nodes/<NODE_ID>/artifacts/<isoTs>-<originalName>.mp4` |

Same convention as anet's existing `logs/` / `goals.json`: **cwd-relative + per-NODE_ID**, with natural cross-project isolation.

### Idempotent + deduplicated

- Same turn re-run (frozen timestamp): deterministic dst filename + `existsSync` short-circuit → **zero duplicate copies**.
- Cross-turn (caller-maintained set): Step 2 exposes `skipSrc?: ReadonlySet<string>`; **the current cli.ts integration does not maintain a cross-turn set** (each turn re-scans, but Grok writes a fresh `N.mp4` per call so the deterministic dst auto-dedups). **P3 follow-up**: persist already-extracted src paths in per-node state to reduce repeat `readdir` cost.

### Failure modes

| Failure | Behaviour |
|---|---|
| `grokSessionDir` unknown (no session yet) | `extractGrokArtifacts` returns `{ artifacts: [], ready: false, error: "no grokSessionDir" }`; reply returns normally without trailer |
| `videos/` dir missing (this turn produced no video) | `ready: true, artifacts: []`; reply returns normally without trailer |
| Target dir mkdir fails (permission / disk) | `ready: false, error: "mkdir artifacts dir failed: ..."`; cli.ts `warn()` but does NOT block the reply |
| Single-file statSync / copyFileSync fails (broken symlink / race) | Skip that entry and continue the loop — **other successful artifacts are not blocked** |
| Whole extractor throws (import failure etc.) | Top-level try/catch in cli.ts + warn; reply preserved as-is (no trailer) |

**Core guarantee**: any #205 Step 2 error **never** blocks the Grok turn's normal reply. Grok finished the task and produced text — the artifact extract is **best-effort augmentation**.

## Limitations + follow-ups

| ID | Type | Description | Owner |
|---|---|---|---|
| P2 | feature | base64 / upload-URL the video into the commhub message, auto-cross-machine | 工程马 + 通信牛 (hub-side attachment store) |
| P2 | retention | `<cwd>/.anet/nodes/<NODE_ID>/artifacts/` retains N days, auto-cleans to prevent disk fill | 工程马 |
| P3 | feature | Extend to non-video artifacts (image / gif / audio); the `kind` field is already typed for extension | SDK马 |
| P3 | docs | `grok-video-gen-prompt-tips.md` — how users phrase prompts to trigger video_gen + style keywords | 文档马 |
| P3 | feature | Extend commhub `send_reply` MCP schema with a `meta_json` param so the machine-readable artifact descriptor goes structured | 通信牛 + SDK马 |
| P3 | perf | Per-node persistent `extracted_src` set, reduce repeat `readdir` cost | SDK马 |

## Probe + references

- [Grok video_gen capability probe (ZH)](../research/grok-video-gen-capability-probe.md)
- [Grok video_gen capability probe (EN)](../research/grok-video-gen-capability-probe.en.md)
- [Grok X-search sibling scenario](../research/grok-x-search-capability-probe.en.md) — needs no anet-side capability code; works out of the box
- [#204 preview.7 isolated-cwd fix](https://github.com/sleep2agi/agent-network/commit/72e28fd) — prerequisite for this scenario (without cwd isolation, Grok reads a stale `.mcp.json`)
- Vincent's real existing artifact (local-only, not in git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4` (5.3 MB / 12 s anet promo)

---

**Author-Agent**: 通信SDK马
