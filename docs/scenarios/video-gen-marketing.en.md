# Video Generation — anet × Grok Build Marketing Video Scenario

> **Scenario goal**: Add a video-generation **capability** to anet's `grok-build-acp` runtime nodes — one of the two flagship scenarios under [#205](https://github.com/sleep2agi/agent-network/issues/205) ([#70](https://github.com/sleep2agi/agent-network/issues/70)).
> **Current scope**: same-machine path readback (per Vincent 6420 directive). Cross-machine distribution is a P2 follow-up.
> **Owners**: 工程马 (release ops) + 通信SDK马 (agent-node author)

## One-liner

Wire Grok's native `video_gen` tool into anet: any node can dispatch a generation task via commhub to a grok-build node; anet leaves the mp4 file where Grok wrote it (session-private) and **surfaces the path in the reply** so a same-machine human / agent can just `cat` / `open` the file.

## User flow (TL;DR)

### Spin up a grok node

```bash
# 1. One-time: log into grok (browser OAuth)
grok login

# 2. Create + start the anet node in your project cwd
anet node create grok-marketing --runtime grok-build-acp
anet node start grok-marketing
```

> Requires `@sleep2agi/agent-node` with [#204 isolated cwd](https://github.com/sleep2agi/agent-network/commit/72e28fd) + [#205 Step 2](https://github.com/sleep2agi/agent-network/commit/09009a3) — i.e. `2.4.7-preview.7` or later.

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

`grok-marketing` receives the task → the Grok LLM autoregressively calls `video_gen` → the mp4 lands in Grok's session-private dir → **agent-node does not move the file, but surfaces the path at the end of the reply text**:

```
[LLM natural-language summary]
I've generated the video as requested...

📹 视频文件 / Video file(s):
  - /home/user/.grok/sessions/<encoded-cwd>/<sessId>/videos/1.mp4
```

A **same-machine user** (or an agent SSH'd into the grok node host) `cat`s / `open`s that absolute path.

## Cross-machine distribution (P2 follow-up, out of scope here)

If the receiver / upstream is on a different host, the absolute path is meaningless. This is **not solved here**. Tracked as a follow-up:
- Option A: agent-node base64 / multipart-stuffs the mp4 into the commhub message before sending.
- Option B: upload to commhub's attachment store (needs hub-side support).
- Option C: scp / rsync via user shell (zero code).

We'll address it when a real need surfaces.

## Internals

### Post-turn path surfacing (read-only)

`agent-node/src/grok-artifact-extractor.ts` exports a pure helper `listGrokVideoArtifacts(grokSessionDir?)` that returns the absolute paths of `videos/*.mp4` under a Grok session:

```ts
// agent-node/src/cli.ts processWithGrok, after runOnce resolves
const sessionDir =
  homedir() + "/.grok/sessions/" + encodeURIComponent(grokCwd) + "/" + result.sessionId;
const paths = listGrokVideoArtifacts(sessionDir);
const trailer = formatVideoTrailer(paths, replyText);
if (trailer) replyText += "\n" + trailer;
```

**Zero fs writes** (no cp / chmod / mkdir). One readdir; silent `[]` fallback on failure.

### `formatVideoTrailer` de-dups against the LLM's own reply

If the LLM already mentioned the path in its natural-language summary (common — Grok's `video_gen` tool emits `"Video saved to ..."` and the LLM usually parrots that), the trailer **silently skips** those paths to avoid double-mentioning the same file. If every path is already in the reply, the trailer is empty.

### Path convention (read-only — anet creates nothing)

| Kind | Path |
|---|---|
| Grok's raw session video (mode 0600, private) | `~/.grok/sessions/<URL-encoded cwd>/<sessId>/videos/N.mp4` |
| anet copies / writes | (none — per Vincent 6420 "leave the file where it is") |

Unlike anet's `logs/` and `goals.json` (which are anet's own state files), the video file belongs to Grok; anet only surfaces it.

### Failure modes

| Failure | Behaviour |
|---|---|
| `result.sessionId` missing (no session) | sessionDir is undefined → list returns `[]` → no trailer, reply is normal |
| `videos/` dir missing (no video this turn) | list returns `[]` → no trailer, reply is normal |
| readdir fails (permission / path is a file) | list returns `[]` (silent try/catch) → no trailer, reply is normal |
| Whole helper throws (import fails etc.) | top-level try/catch in cli.ts + warn; reply preserved as-is |

**Core guarantee**: any #205 Step 2 error **never** blocks the normal Grok turn reply.

## Limitations + follow-ups

| ID | Type | Description | Recommended owner |
|---|---|---|---|
| **P2** | feature | **Cross-machine artifact distribution** (mp4 base64 / hub attachment / scp script) | 工程马 + 通信牛 |
| P3 | feature | Extend to non-video artifacts (image / gif / audio) | SDK马 |
| P3 | docs | `grok-video-gen-prompt-tips.md` — prompt tips to trigger `video_gen` + style keywords | 文档马 |
| P3 | feature | Extend commhub `send_reply` MCP schema with `meta_json` for structured artifact descriptors | 通信牛 + SDK马 |

## Probe + references

- [Grok video_gen capability probe (ZH)](../research/grok-video-gen-capability-probe.md)
- [Grok video_gen capability probe (EN)](../research/grok-video-gen-capability-probe.en.md)
- [Grok X-search sibling scenario](../research/grok-x-search-capability-probe.en.md) — zero anet code, works out of the box
- [#204 preview.7 isolated-cwd fix](https://github.com/sleep2agi/agent-network/commit/72e28fd) — prerequisite for this scenario
- Vincent's real existing artifact (local-only, not in git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4` (5.3 MB / 12 s anet promo)

---

**Author-Agent**: 通信SDK马
