# X Search informant — anet × Grok Build X-search scenario

> **Goal**: Add **X (Twitter) search informant capability** to anet `grok-build-acp` runtime nodes — one of two scenarios for [#205](https://github.com/sleep2agi/agent-network/issues/205) (tracked in [#206](https://github.com/sleep2agi/agent-network/issues/206)).
> **2026-05-30 second correction (Vincent 7031)**: The earlier "two-tier" split was over-engineered. A follow-up E2E probe showed Grok's native `web_search + allowed_domains` covers the basic ask end-to-end (5/5 curl-verified real x.com URLs). What used to be the "advanced tier" needs platform-side metadata (faves / retweets) that **X itself restricts to logged-in users and the X Premium API** — that's a platform limit, not a Grok or anet capability gap. We deliberately do **not** ship a third-party X API integration as the default demo path.

## One line — pure native, zero user setup

**0 anet LOC + 0 user-side cwd setup**: spin up a `grok-build-acp` node, send "find X posts by @user about <topic>", Grok auto-uses its built-in `web_search` with `allowed_domains=["x.com"]` to find X URLs, plus `web_fetch` for content/summaries. Markdown list of ~5 entries, curl-verified 5/5 HTTP 200.

Evidence: [`docs/tests/p-grok-native-xsearch-e2e/report.md`](../tests/p-grok-native-xsearch-e2e/report.md) — basic prompt returned 5 real x.com/sama AGI URLs.

## Out of the box (the user-facing path)

### Start a grok node

```bash
# 1. One-time global setup: log in to grok (browser OAuth)
grok login

# 2. Start a grok-build-acp node (any cwd, no pre-staging needed)
anet node create grok-x --runtime grok-build-acp
anet node start grok-x
```

### Send an X-search task

```
commhub_send_task(
  alias="grok-x",
  task="Find recent X / Twitter posts by @sama about AGI.
        For each: https://x.com/... URL + a short summary + approximate date.
        Markdown list, around 5 items."
)
```

### LLM behavior (E2E evidence 2026-05-30, session `019e7719`)

15 `web_search` calls (all with `allowed_domains=["x.com"]` or `["x.com","twitter.com"]`) + 2 `web_fetch` calls (direct x.com page fetches) + 4 `read_file` (the LLM peeks at the user's `.claude/skills/`, harmless) + 1 `list_dir`.

**Verbatim reply excerpt**:

```
- 2026-05-20ish https://x.com/sama/status/2057218997503086888
  OpenAI's three current excitements (AGI for science / AGI for the company /
  personal AGI for everyone)...
- 2025-10-29 https://x.com/sama/status/1983584366547829073
  OpenAI internal target — by Sept 2026 an "automated AI research intern"
  running on hundreds of thousands of GPUs...
- ~2025-07-17 https://x.com/sama/status/1945901039104004467
  Watching ChatGPT Agent operate a computer like a human — a real
  "feel the AGI" moment...
... (5 entries)
```

**curl verify**: 5/5 HTTP 200, all real x.com URLs. Full [`basic-reply.md`](../tests/p-grok-native-xsearch-e2e/basic-reply.md) + [`basic-urls.txt`](../tests/p-grok-native-xsearch-e2e/basic-urls.txt).

## Honest capability boundary (X platform policy, not a Grok limitation)

| Capability | Grok native? | Why limited? |
|---|---|---|
| Find X URLs by keyword / handle / hashtag | ✅ | `web_search + allowed_domains=["x.com"]` |
| Pull post content for summarization | ✅ | `web_fetch` |
| Time-windowed search (`past 7d` / `since:date`) | ✅ | LLM rewrites into the web_search query |
| Multilingual (CN / EN / JP / ...) | ✅ | Grok's LLM is multilingual |
| **Real-time freshness (< 1h)** | ❌ | Web index lag, X anti-scrape |
| **Exact faves / retweets / replies counts** | ❌ | X reserves engagement metadata for logged-in users + the Premium API |
| **Ranking by faves / retweets** | ❌ | Same |
| **X Advanced Search syntax (`min_faves:` / `mode=Latest`)** | ❌ | Requires logged-in session or X API |
| **Pulling thread / reply trees** | ❌ | Same |

**Important: items marked ❌ are not Grok's failures — they are X's platform-wide gating of engagement data behind logged-in / paid access**. In the advanced E2E probe, the LLM was transparent: "I cannot complete the precise-data portion of this request ... I will not fabricate any specific post's handle/URL/faves/retweets numbers ... if you have your own X API access or Premium advanced search, tell me and I can use the existing tools as helpers". See [`advanced-reply.md`](../tests/p-grok-native-xsearch-e2e/advanced-reply.md).

**That is the desired behavior** — transparent, no fabrication, offers an alternative path.

## If you genuinely need faves data

**This is out of scope for anet's default demo**. If you really need faves / retweets metadata, integrate it yourself:

1. The [X Developer Platform](https://developer.x.com/) (official, requires approval) or
2. A third-party X data proxy like [twitterapi.io](https://twitterapi.io/).

Integration pattern (R83 evidence):
- Drop a fetcher script in the grok node's cwd (write your own — we don't ship a template because every team's API choice / quota model / output schema differs).
- Drop a small hint file (something like `X-FETCH.md` with one paragraph) so the LLM finds and uses it via `list_dir` + `read_file`.
- The LLM will invoke your fetcher via `run_terminal_command` and reason over the structured X data.

See R83's full trace at [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../tests/p-grok-028-xsearch-acp-probe/report.md) for the LLM's `run_terminal_command` walkthrough.

**Why we don't ship a twitterapi.io template**: bundling one as the default demo path would frame "X commercial API integration" as "Grok integration" — that's a category mistake (Vincent 7031 pushback). X-gated data is for users to choose their own provider; anet ships no opinion.

## Prompt tips

- Just say "find X posts by @<user> / <keyword> / #<topic>, give me URLs" — the LLM picks `web_search + allowed_domains=["x.com"]` automatically.
- **Explicitly demand `https://x.com/<handle>/status/<id>` URL format** so the reply is curl-verifiable. Without the demand, sometimes the LLM returns "posts about X" without linkable status URLs.
- Specify a time window (7d / 24h) — the LLM forwards it as part of the web_search query (`since:2026-05-23`).
- Ask for a markdown list / table — anet relays the reply as raw text; markdown renders cleanly in dashboards / IM.
- **For metadata-sensitive prompts, include "don't fabricate" guard** — Grok 0.2.x will honestly say "I can't get accurate faves data" rather than fake numbers.
- **Don't say "use your XSearch tool"** — XSearch isn't exposed via ACP; saying so wastes a few `grep` turns and produces vague fallback output. Just say "find X posts by ..." directly.

## Why Grok has native X search but the ACP channel doesn't

Grok's **consumer product** (grok.com Web / Grok app) has native real-time X search — an xAI-direct feature for consumer users.

Grok's **CLI agent stdio mode (the ACP path anet uses)** does not expose it: the `available_commands_update._meta.tools` list contains no `XSearch` / `x_keyword_search` / `x_user_search`. Confirmed identical across 0.1.219 → 0.2.3 → 0.2.12 alpha.

Likely intentional sandboxing + third-party agent integration layering — ACP is a protocol for "arbitrary client drivers", while Grok's consumer product is xAI's own deep integration. Full schema-introspection proof: [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../tests/p-grok-028-xsearch-acp-probe/report.md).

But 0.2.x added the `web_search.allowed_domains` field — the LLM now constrains generic web search to `x.com` and gets X URLs / titles / snippets. That's enough for the out-of-the-box ask.

## Limitations + follow-up

| ID | Type | Description |
|---|---|---|
| P3 | docs | Document the grok `run_terminal_command` escape hatch behavior (cross-scenario general — for users who truly need to integrate an external X API) |
| P3 | feature | anet-bundled X informant template (e.g. `anet template install x-fetcher`) — **not proactive**, only build when a real user need ramps |

## Probe sources + references

- [Grok X-search capability probe (ZH)](../research/grok-x-search-capability-probe.md) — includes Erratum 1/2/3 (three rounds of correction)
- [Grok X-search capability probe (EN)](../research/grok-x-search-capability-probe.en.md)
- [Grok 0.2.x ACP XSearch schema-introspection report](../tests/p-grok-028-xsearch-acp-probe/report.md) — three-version comparison of `available_commands_update._meta.tools`
- [Grok 0.2.12 alpha pure-native X-search E2E report](../tests/p-grok-native-xsearch-e2e/report.md) — the main evidence backing this scenario
- [Scenario 2 video-gen-marketing.en.md](./video-gen-marketing.en.md) — sister scenario (image-to-video, 0 LOC)
- [Demo: anet × Grok X search](../../demos/grok-x-search/README.md) — runnable demo (pure native, twitterapi.io template removed)
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd prerequisite

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend) + R83 X-search re-audit + 2026-05-30 schema-introspection + 2026-05-30 Vincent 7031 native-only correction
**Author-Agent**: 通信SDK马
