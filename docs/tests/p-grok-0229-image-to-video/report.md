# grok-build 0.2.29 — image_to_video live re-test (#205 follow-up)

**Date:** 2026-06-06 北京时间 ~10:49
**Driver:** 通信龙 (real grok CLI in tmux, send-keys/capture-pane)
**Trigger:** Vincent reported "grok build 版本升级了". Upgraded `0.2.12` → `0.2.29` (alpha channel), re-verified the video demo flow.

## TL;DR
The video demo capability is **real and reliable on `0.2.29`** — the earlier "alpha flaky" finding (2026-05-30, `0.2.12`) was partly a **category error**: there is no text-to-video tool; the demo's actual flow is **image-conditioned `image_to_video`**, which fires cleanly.

## Test 1 — strict text-to-video (no source image), ffmpeg forbidden
Prompt: "TRUE generative video … ONLY built-in video gen … Do NOT use ffmpeg … 5-second clip of ocean waves … from scratch."
Result: grok loaded the `imagine` skill, searched its tools, and **correctly declined**:
> "There is no built-in pure text-to-video / video_gen model available to me as a tool. … *Video starts from an image — there is no text-to-video tool.* … image_to_video requires a source image."
**This is the right answer, not a failure** — the requested capability genuinely does not exist.

## Test 2 — real demo flow: image → image_to_video (ffmpeg forbidden)
Prompt: "Use your built-in image_to_video (imagine skill) to animate this into a ~5s video with real generative motion … Source image: <unsplash waves URL> … no ffmpeg … tell me the mp4 path."
Result: **fired cleanly on first try, ~1m5s turn.** Output:
`~/.grok/sessions/%2Ftmp%2Fgrok-live-test/019e9ad4-…/videos/1.mp4`

### Artifact verification (ffprobe, trust-but-verify)
- 12 MB on disk
- Streams: `h264` video (704×1280, 6.04s) + **`aac` audio** + **`mjpeg` cover** — the authentic backend-model fingerprint (a bare ffmpeg pan/zoom would be video-only, no audio)
- Real generative motion (the prompt explicitly forbade pan/zoom; the model used the diffusion video tool)

## Conclusion / demo impact
1. `imagine` skill in `0.2.29` exposes `image_gen` / `image_edit` / `image_to_video` / `reference_to_video`.
2. The video demo (`demos/grok-video-gen/`) flow = `image_to_video`, **works reliably on `0.2.29`** (first-try fire, real output).
3. Demo README updated: correct tool name (`image_to_video`, not `video_gen`/`grok-imagine-video`), state it is image-conditioned (no text-to-video), and replace "alpha flaky" with "verified reliable on `0.2.29`; pin to `0.2.29`+".
4. Lesson reinforced: capability claims pinned to one CLI version + one test angle age fast; re-verify live on the current version. (same pattern as the X-search probe: schema introspection proves a tool is *declared*, never that invoking it does anything)
