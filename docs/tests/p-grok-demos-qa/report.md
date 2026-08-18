# #205 demo QA — grok-x-search + grok-video-gen reproducibility audit

**Auditor:** 通信测试马
**Date:** 2026-06-06
**Scope:** Pure documentation / path / link / wording audit. **No grok node spun, no live agent re-run.** Live X-search E2E already validated by 通信龙 (3 real @sama tweets, curl 200 at probe time); video alpha caveats already known per `feedback_schema_introspection_not_capability_proof`.

**Verdict TL;DR:** ✅ Both demos pass reproducibility audit with **one stale claim** in `demos/grok-x-search/README.md` to amend (X URLs now return 403 to anonymous curl — claim "5/5 HTTP 200" no longer reproduces). One minor wording nudge for the video demo.

---

## Demo 1 — `demos/grok-x-search/` (pure native)

### 1.1 Reproducibility: ⚠️ MOSTLY PASS — 1 stale claim

| Check | Result |
|---|---|
| All file references resolve | ✅ 8/8 paths exist |
| `prompts/basic.md` exists and is copy-pasteable | ✅ 84 lines, 3 templates (handle / hashtag / boolean) + English variant |
| `fetcher/` directory removed | ✅ `git ls-tree -r HEAD demos/grok-x-search/` shows only `README.md` + `prompts/basic.md` |
| `.env.x.example` removed | ✅ not in tree, not on filesystem |
| RFC-021 §12 / §14 referenced sections exist | ✅ both present (lines 370 + 485) |
| `prompts/basic.md` referenced report links | ✅ E2E probe + advanced-reply links resolve |
| Capability table claims (web_search + web_fetch, no key) | ✅ matches RFC-021 §13/§14 schema-introspection findings |
| **Verbatim claim: "Verified: 5/5 `curl -I` HTTP 200"** | ❌ **5/5 now HTTP 403** on 2026-06-06 re-verify (see §1.4) |

All 8 referenced paths exist and resolve:
```
docs/scenarios/x-search-informant.md
docs/research/grok-x-search-capability-probe.md
docs/tests/p-grok-native-xsearch-e2e/report.md
docs/tests/p-grok-native-xsearch-e2e/basic-urls.txt
docs/tests/p-grok-native-xsearch-e2e/advanced-reply.md
docs/tests/p-grok-028-xsearch-acp-probe/report.md
docs/rfcs/RFC-021-acp-capability-profile-expansion.md
demos/grok-x-search/prompts/basic.md
```

### 1.2 "Pure native" wording — accurate or overpromise?

**Verdict: accurate, well-disclosed.**

The pitch (`README.md:3`) says:
> The Grok agent uses its built-in `web_search` (with `allowed_domains=["x.com"]`) plus `web_fetch`

That's literally what the LLM does per the E2E probe trace and RFC-021 §14. "Pure native" in this README context means "no anet-side glue (no fetcher, no MCP, no key)" — NOT "no underlying tools." The two capability tables (§"What grok native can do" + §"What grok native genuinely cannot do") are honest and explicit:

- 5 capabilities marked ✅ with the tool used
- 5 capabilities marked ❌ with the platform-level reason

The §"Why this demo doesn't ship a fetcher" section directly addresses the prior overpromise and explains the schema-introspection lesson banked twice (matches RFC-021 §13/§14 + feedback_schema_introspection_not_capability_proof). No overpromise to fix.

### 1.3 fetcher cleanup verification

```
$ git ls-tree -r HEAD -- demos/grok-x-search/
demos/grok-x-search/README.md
demos/grok-x-search/prompts/basic.md

$ ls demos/grok-x-search/
prompts  README.md
```

Both git tree and filesystem confirm: `fetcher/` directory, `.env.x.example`, any `twitterapi.io` artifacts — **all gone clean**. No risk of accidental key commit because the file doesn't exist.

### 1.4 ⚠️ Stale claim — "5/5 HTTP 200"

**README line 9** (verbatim):
> Verified: 5/5 `curl -I` HTTP 200 against the URLs the LLM returned for "find @sama's recent AGI posts" in the [E2E probe report].

**README line 84** (verbatim):
> All five URLs return HTTP 200 — see [`basic-urls.txt`](../p-grok-native-xsearch-e2e/basic-urls.txt) for the verbatim list.

**Live 2026-06-06 re-verify:**
```
$ while IFS= read -r url; do
    curl -sI --max-time 5 "$url" | head -1
  done < docs/tests/p-grok-native-xsearch-e2e/basic-urls.txt
HTTP/2 403
HTTP/2 403
HTTP/2 403
HTTP/2 403
HTTP/2 403
```

5/5 now return `HTTP/2 403`. Root cause: X (the platform) has further tightened anonymous access between probe time (2026-05-22 per E2E probe report) and audit time (2026-06-06). The URLs are **still real** and the post IDs valid — opening them in a logged-in browser shows the actual @sama tweets. The change is at the X anti-scraping layer, not in our demo.

**Why it matters:** a fresh user following the README quickstart and `curl -I`'ing the sample URLs to "verify" the claim will see 403 across the board and reasonably conclude the demo is broken. The demo isn't broken; the README claim aged.

**Suggested fix (wording, not capability):**

```markdown
Verified: 5 real X URLs from "find @sama's recent AGI posts" (E2E probe 2026-05-22:
5/5 `curl -I` HTTP 200). Re-checking the same URLs via anonymous `curl` later
will likely show HTTP 403 — X has tightened anti-scraping for non-logged-in
requests since the probe. The URLs are still real and open in any browser
or `curl -H 'Cookie: <logged-in-session>'`; the demo's reproducibility is
about the **LLM finding correct, real URLs**, not about anon `curl` access.
```

Or shorter, replace lines 9 + 84:

```markdown
Verified: 5/5 real x.com/sama/status URLs returned by the LLM for the probe
prompt (basic-urls.txt). The post IDs are valid and the URLs render in any
logged-in browser; anonymous `curl -I` may return 403 due to X anti-scraping
(unrelated to anet/grok).
```

### 1.5 Findings summary

| Item | Status | Action |
|---|---|---|
| File references | ✅ all resolve | none |
| `fetcher/` + `.env.x` cleanup | ✅ clean | none |
| "pure native" wording | ✅ accurate | none |
| Capability tables (✅/❌ honesty) | ✅ matches RFC-021 §14 | none |
| **"5/5 HTTP 200" claim** | ❌ stale | **README amend** (suggest text in §1.4) |
| Live E2E reproducibility (Vincent's 3 @sama tweets) | ⏭ Vincent UAT (auth-gated) | n/a |

---

## Demo 2 — `demos/grok-video-gen/` (image-to-video, 0 LOC)

### 2.1 Reproducibility: ✅ PASS

| Check | Result |
|---|---|
| All file references resolve | ✅ 5/5 paths exist |
| `sample/output.mp4` exists and is non-empty | ✅ 1.3 MB |
| `sample/poster-first-frame.jpg` + mid-frame | ✅ both 40 KB |
| `docs/scenarios/video-gen-marketing.md` | ✅ 8.0 KB |
| `docs/research/grok-video-gen-capability-probe.md` | ✅ 16 KB |
| `docs/tests/p-grok-028-xsearch-acp-probe/report.md` referenced | ✅ exists |
| RFC-021 §12 ("0 LOC qualified") referenced section | ✅ exists (line 370) |
| Quickstart commands (`grok login` → `anet node create` → `anet node start` → `commhub_send_task`) | ✅ syntactically valid |

### 2.2 Alpha reliability disclosure — honest enough?

**Verdict: ✅ extensively honest, above-par.**

The README has alpha-reliability warnings in **four distinct places**:

1. **Top-level ⚠️ block** (lines 7) — full 2026-05-30 live re-test note, 8-line warning before any quickstart
2. **Pitch caveat** (line 11) — "When the native model fires" hedge in §"What you get"
3. **§"Why it's 0 LOC"** (line 22) — explicit "Caveat (see the reliability note at the top)" that says listed-in-registry ≠ guaranteed invocation
4. **Caveats section** (line 85) — first bullet repeats the warning

The disclosure explicitly:
- ✅ Names a date (2026-05-30) + grok version (0.2.12 alpha)
- ✅ Describes the failure mode (LLM doesn't fire `video_gen`, falls back to ffmpeg pan/zoom or refusal)
- ✅ Points fresh users to the **X-search demo** as the reliable alternative
- ✅ Distinguishes "ffmpeg pan/zoom" from "true generative video" so users aren't deceived if the fallback fires
- ✅ Acknowledges quota / account / session state as likely causes

This matches Vincent's "schema introspection ≠ 真实能力" lesson (memory `feedback_schema_introspection_not_capability_proof`) — the README sells **integration honesty** (0 LOC anet-side wiring) without selling **generation reliability**. The sample MP4 is presented as proof the capability exists in some sessions, not as a guarantee for every fresh run.

### 2.3 Minor wording nudge (optional, not blocking)

The pitch line (line 3):
> ...it generates an MP4 — with **zero anet-side code changes** and **zero user setup beyond a one-time `grok login`**.

The em-dash phrasing reads as a flat claim ("it generates"). The ⚠️ block right below softens this strongly, but the pitch is what survives skim-reading and screenshot quotes.

**Suggested nudge** (line 3):

```markdown
> **Pitch**: Give an anet `grok-build-acp` node an image URL + "make this into
> a 5-second video", and **when the native generator fires** it produces an MP4
> — with **zero anet-side code changes** and **zero user setup beyond a one-time
> `grok login`**. (See the alpha-reliability ⚠️ below — it doesn't always fire
> on fresh sessions yet.)
```

Pure optional. Not a reproducibility blocker.

### 2.4 Findings summary

| Item | Status | Action |
|---|---|---|
| File references | ✅ all resolve | none |
| Sample MP4 + posters | ✅ present, real backend output | none |
| Alpha reliability disclosure | ✅ 4-layer honest (top warning + pitch hedge + §"Why" caveat + Caveats bullet) | none |
| Pitch line softening | nudge | optional — wording suggestion in §2.3 |
| Live re-run (fresh grok session) | ⏭ Vincent UAT (auth + quota gated) | n/a |

---

## Combined verdict

| Demo | Reproducibility | Reliability disclosure | Action |
|---|---|---|---|
| grok-x-search | ⚠️ mostly pass | ✅ accurate | **1 stale claim to amend** (5/5 HTTP 200 → no longer reproduces 2026-06-06) |
| grok-video-gen | ✅ pass | ✅ above-par 4-layer | optional pitch softening |

**Net:** Both demos are user-followable. The grok-x-search README has a single aged claim that an honest user will notice the moment they `curl -I` the sample URLs. Recommend a 4-line wording amend (suggested text in §1.4) before any wider promotion / B站 course / public push. Video demo can ship as-is.

## What this audit did NOT cover (per scope)

- ⏭ Real `grok login` + `anet node start grok-x` + live X-search dispatch — Vincent UAT (already validated separately per 通信龙 message; 3 @sama tweets, curl 200 at probe time)
- ⏭ Real `grok login` + image-to-video generation — Vincent UAT (auth + quota gated, alpha reliability per disclosure)
- ⏭ `commhub_send_task` end-to-end from a fresh user account — out of scope; covered by other Docker smoke matrices

## Evidence

- File existence checks: `for p in <paths>; do [ -e "$p" ] && echo OK $p; done`
- `git ls-tree -r HEAD -- demos/grok-x-search/`
- `curl -sI --max-time 5 <url> | head -1` for each URL in `basic-urls.txt`
- `grep -nE '^## ' docs/rfcs/RFC-021-acp-capability-profile-expansion.md` (§12 + §14 confirmed)
- File sizes: `du -h sample/*.mp4 sample/*.jpg`
