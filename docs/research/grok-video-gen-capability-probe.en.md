# Grok Build CLI — Video Generation Capability Probe

> **Source task**: #205 scenario 2 — make Grok CLI's video generation a first-class capability for `grok-build-acp` runtime nodes.
> **Related issues**: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#70](https://github.com/sleep2agi/agent-network/issues/70) · [#204](https://github.com/sleep2agi/agent-network/issues/204)
> **Subject**: Grok Build CLI `0.1.220 (ae5f4af53)`, default `grok-build` model
> **Method**: Static surface scan + parsed real tool-calls in Vincent's existing session logs (`~/.grok/sessions/.../updates.jsonl`) + filesystem inspection of a real artifact (`videos/1.mp4`, 5.3MB). **No new LLM calls** (avoid burning xAI quota + red-line: no host-side test nodes).
> **Author**: 通信SDK马
> **Date**: 2026-05-28

## TL;DR

**Grok CLI natively supports video generation** via an LLM-autoregressive **`video_gen` tool**. **The input is dead-simple** (`{prompt: <text>}`); **the output is a local file** (`~/.grok/sessions/<sessId>/videos/N.mp4`). Vincent's existing session has already generated a 12 s / 5.3 MB anet promo video. anet integration only needs to **extract the artifact path from the LLM reply and copy/export the file** to a user-reachable location — otherwise the mp4 sits in a session-private 0600 directory inaccessible across machines.

## Findings

### 1. CLI surface — no `grok video` subcommand

```bash
$ grok video --help
error: unrecognized subcommand 'video'

  tip: a similar subcommand exists: 'v'    # ← v is `version`, misleading
```

→ **No user-facing CLI**. Video generation **only triggers inside the agent runtime when the LLM decides to**.

### 2. Tool discovery — Vincent's session already has real calls

From `~/.grok/sessions/%2Fhome%2Fvansin/*/updates.jsonl`:

```
2 video_gen tool_calls  →  2 .mp4 files saved locally
```

The Grok agent's natural-language reply confirms:
```
Video generated and saved to
/home/vansin/.grok/sessions/<sessId>/videos/1.mp4.
```

Real artifact verified on disk: **`-rw------- 1 vansin vansin 5.3M May 26 10:08 .../videos/1.mp4`** (~5.3 MB for a 12 s clip, reasonable for ~1080p-ish output).

### 3. `video_gen` request / response schema

#### Trigger (`tool_call`)

```jsonc
{
  "sessionUpdate": "tool_call",
  "title": "video_gen",
  "rawInput": {
    "prompt": "<text prompt, several hundred to ~1000 chars>"
  }
}
```

→ **Only `prompt` is sent**. There is no visible `duration` / `aspect_ratio` / `quality` / `model` parameter. Vincent's two calls both used `prompt` only; both produced ~12-second clips, suggesting backend defaults.

#### Completion (`tool_call_update` status="completed")

```jsonc
{
  "sessionUpdate": "tool_call_update",
  "status": "completed",
  "content": [{
    "type": "content",
    "content": {
      "type": "text",
      "text": "Video generated and saved to /home/vansin/.grok/sessions/<sessId>/videos/1.mp4."
    }
  }],
  "rawOutput": {
    "type": "Text",
    "text": "Video generated and saved to /home/vansin/.grok/sessions/<sessId>/videos/1.mp4."
  }
}
```

→ **Output `type` is `"Text"`** (not `Image` / `Video` / `Artifact`). **The video path lives in plain text**, so anet must regex-parse the reply to find the file location.

#### Prompt sample (real, from Vincent)

```
"Modern tech promotional video for \"Agent Network\" (anet.sh), a multi-agent
orchestration platform. Dark elegant background with neon blue and purple
accents. Show a central hub node spawning dozens of glowing AI agent nodes
that connect and collaborate in a network. CLI command 'npm install -g
@sleep2agi/agent-network' elegantly appears. Scenes of multiple specialized
agents (researcher, coder, analyst, writer) working together in parallel
on complex tasks. Smooth camera movement, professional cinematic lighting,
clean minimalist design. Text appears: '多 Agent，一行命令' and 'Agent
Network'. High-end production..."
```

→ Prompts support **mixed Chinese/English**, **cinematic style descriptors** seem to take effect, **short text overlays** appear supported (needs end-to-end LLM verification).

### 4. Output file path — session-private

Where the file lands:
```
~/.grok/sessions/<URL-encoded cwd>/<session_uuid>/videos/<index>.mp4
```

- `<URL-encoded cwd>`: e.g. `%2Fhome%2Fvansin` = `/home/vansin` (% encoded)
- `<session_uuid>`: Grok session id (`019e6205-...`), held by agent-node as `grokSessionId`
- `<index>`: increments per video (1.mp4, 2.mp4, ...)

→ **Path is session-private** with mode 0600 (Vincent's actual artifact). anet must **export the file to a user-reachable location** when relaying (see section 4.2 below).

### 5. Auth / Quota

- **Auth**: Reuses Grok CLI login state (`grok login`). No separate xAI API key required.
- **Quota**: No rate-limit errors observed. **Conservative assumption**: the Grok subscription has a monthly or per-video allowance; rate-limit hits would surface as `tool_call_update.status: "error"`. P3 follow-up: capture the true rate-limit error format.
- **Generation time**: Vincent's sessions didn't record latency. **Conservative estimate**: 10–60 s (similar order to OpenAI Sora-2 / Runway Gen-3). anet's existing `GROK_ACP_TIMEOUT_MS` default of 300 s is plenty.

## Impact on anet integration

### Difficulty — **small** (one artifact-extraction helper)

Grok's LLM already calls `video_gen` autoregressively, but anet currently **relays the Grok natural-language reply back to commhub** (after `sanitizeGrokCommhubLeak`). Problem: the user sees `"Video saved to .../1.mp4"` text but **cannot access that path** (session-private, possibly on a different machine).

anet's `processWithGrok` needs to:
1. **Parse the reply text** with a regex like `/Video generated and saved to (.+\.mp4)/`
2. **Copy / upload the mp4** to a user-reachable place. Options:
   - A: copy to `<anet-cwd>/.anet/nodes/<alias>/artifacts/<timestamp>-<n>.mp4` (per-node artifacts dir)
   - B: upload to commhub's built-in attachment store (if the hub supports this)
   - C: return a `file://` path, let commhub-server / dashboard re-route
3. **Rewrite the reply** to swap the session-private path for the new location URL/path

### User workflow — plain-language prompt

```
admin → commhub_send_task(alias="grok-video", task="Generate a 12-second
        promo video for the Agent Network project — dark tech aesthetic,
        showcase multi-agent collaboration")
```

The Grok LLM calls `video_gen` autoregressively, anet relays + exports the artifact.

### Hook position in existing anet code

`agent-node/src/cli.ts processWithGrok`:
```ts
return sanitizeGrokCommhubLeak(result.replyText.trim() || "（无回复）");
```

→ **Add the artifact-extraction hook** right after `sanitizeGrokCommhubLeak`:
- Scan `result.replyText` (or all tool_call_update content in `result.state`) for `videos/*.mp4` references
- Copy / export artifacts
- Rewrite the reply path

This is the core LOC for **Step 2 (artifact pipeline design)** — estimated **~30–50 LOC**.

### Limitations

1. **Input not tunable**: no visible `duration` / `aspect_ratio` / `quality` / `seed` flag. To get a 9:16 vertical for TikTok, options are (a) instruct the LLM in the prompt to "make this a 9:16 vertical video" and hope the Grok backend reads it (not guaranteed), or (b) wait for xAI to publish `video_gen` as a public MCP server with a real schema.
2. **No structured download**: parsing the LLM's natural-language reply is the only way to get the path. If Grok upgrades and changes the wording ("Saved to X." → "Generated: X"), anet's regex must follow.
3. **No frame streaming**: the tool is atomic — it returns a path only after generation completes. anet's `report_status("working", ...)` can still tick during generation, but the body is opaque.
4. **Local file, not visible across machines**: if the node host and the message receiver are not on the same machine, the path is meaningless. anet **must** export artifacts (option A/B/C above) for cross-machine usability.

## Recommendations (Step 2 design input)

### 2.1 Artifact pipeline design (P1, Step 2 — joint 工程马 + SDK马)

**Recommended option A** (per-node artifacts dir):
```
<anet-cwd>/.anet/nodes/<alias>/artifacts/2026-05-28T15-30-00Z-1.mp4
```
- File owner = anet user (not the session-private 0600 file)
- User / upstream reach it via the anet node dir
- Cross-machine still needs manual `scp` / `rsync`, but **strictly better** than session-private

P2 follow-up: base64-encode or upload-URL the mp4 into the commhub message so the receiver gets the content directly.

### 2.2 Artifact file size / count monitoring

- 5.3 MB / 12 s ≈ 26 MB / minute of video
- Multiple Grok nodes generating frequently will eat disk
- Step 2 should add a P2 retention policy: `.anet/nodes/<alias>/artifacts/` retains N days; old files auto-cleaned

### 2.3 Prompt-writing guide (P3 docs)

Write a `docs/research/grok-video-gen-prompt-tips.md` or `docs-site/docs/guide/video-gen-prompts.md`:
- How users phrase prompts to trigger `video_gen` (keywords: "generate video", "video")
- Style keywords (cinematic / minimalist / neon / 3D motion graphics ...)
- Mixed Chinese/English OK
- 12 s is the default duration; no way to explicitly extend it (as far as observed)

### 2.4 Quota-error fallback (P2)

If `tool_call_update.status === "error"` and the text contains `"quota"` / `"rate limit"`, anet should:
- WARN to the agent log
- Relay the LLM's natural-language reply as-is (it likely already includes the error)
- Do not retry automatically

## Surface Map (ASCII)

```
┌──────────────────────────────────────────────────────────┐
│  admin user → commhub_send_task(alias=grok-X, task=...)  │
│                                  │                       │
│                                  ↓                       │
│  agent-node (grok-build-acp runtime, #204 preview.7)     │
│                                  │                       │
│                                  ├─ ACP session/new      │
│                                  ↓                       │
│  Grok CLI subprocess (cwd = isolated)                    │
│                                  │                       │
│                                  ├─ LLM decides to       │
│                                  │   generate video      │
│                                  ↓                       │
│  video_gen tool (backend at xAI)                         │
│                                  │                       │
│   {prompt: "<text>"} ────────────│                       │
│                                  │                       │
│                                  ↓                       │
│   After ~10-60 s, Grok writes the file:                  │
│   ~/.grok/sessions/.../videos/N.mp4 (mode 0600)          │
│                                  │                       │
│                                  ↓                       │
│  LLM reply: "Video saved to .../N.mp4"                   │
│                                  │                       │
│  ⚠ Step 2 hook point:                                    │
│   processWithGrok: extract path + export artifact        │
│   (recommended to .anet/nodes/<alias>/artifacts/)        │
│                                  │                       │
│                                  ↓                       │
│  commhub_send_reply back to admin (with artifact path)   │
└──────────────────────────────────────────────────────────┘
```

## References

- ACP fixture: [`docs/tests/fixtures/grok-build/acp-stdio.jsonl`](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl)
- Sibling report: [`grok-x-search-capability-probe.en.md`](./grok-x-search-capability-probe.en.md)
- Upstream issues: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#70](https://github.com/sleep2agi/agent-network/issues/70)
- Vincent's real video artifact (local reference, not in git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4`
- #204 preview.7 fix (Grok cwd isolation, prerequisite for this probe): [`72e28fd`](https://github.com/sleep2agi/agent-network/commit/72e28fd)

---

**Author-Agent**: 通信SDK马
