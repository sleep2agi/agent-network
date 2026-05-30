# Sample output provenance

These three files (`output.mp4`, `poster-first-frame.jpg`, `poster-mid-frame.jpg`) are the verbatim artifacts from the **R75 image-to-video probe** on 2026-05-28, conducted on `grok-build` 0.2.8 alpha.

## Generation context

- **Probe directory**: `/tmp/p205-img2vid-v2/`
- **Grok session ID**: `019e6eb5-e22d-7a92-bc46-9e1ab4973ae1`
- **Session path on disk**: `~/.grok/sessions/%2Ftmp%2Fp205-img2vid-v2/019e6eb5-e22d-7a92-bc46-9e1ab4973ae1/videos/1.mp4`
- **Prompt** (paraphrased): give the LLM a public image URL and ask for a short, slightly cinematic video. The Grok backend's `video_gen` tool fired with `{image_url, prompt}` rawInput and produced this clip in `~/.grok/sessions/.../videos/1.mp4`.

## File specs

| File | Spec |
|---|---|
| `output.mp4` | 5.04 s · 1280×720 · 24 fps · 1.27 MB · H.264 |
| `poster-first-frame.jpg` | ~40 KB · single frame at t=0 |
| `poster-mid-frame.jpg` | ~40 KB · single frame at t=2 s |

The poster JPEGs were extracted afterward with `ffmpeg -ss <t> -frames:v 1 -q:v 4`. The MP4 itself is the byte-identical output Grok's backend wrote — no post-processing.

## Why ship the artifact in-repo

This is a demo, not a benchmark. Committing the MP4 (~1.3 MB) lets readers of `demos/grok-video-gen/README.md` see the result without re-running a probe (which would burn an xAI video-generation tick on their account). If the file grows unwieldy across more demos, we can switch to Git LFS or a CDN later.
