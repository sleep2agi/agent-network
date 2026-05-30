# X Search informant — anet × Grok Build X-search scenario

> **Goal**: Add **X (Twitter) search informant capability** to anet `grok-build-acp` runtime nodes — one of two scenarios for [#205](https://github.com/sleep2agi/agent-network/issues/205) (tracked in [#206](https://github.com/sleep2agi/agent-network/issues/206)).
> **Important correction (2026-05-30)**: This is a **two-tier** capability, not a single "setup required" path — schema-introspection confirmed the clean split.

## Two tiers, one line

- **Basic — out of the box ✅**: Find X URLs / post titles / snippets / approximate dates. **0 LOC anet, 0 user-side setup**. The LLM auto-uses ACP-exposed `web_search` with `allowed_domains=["x.com"]`.
- **Advanced — user-side setup required ⚠**: Real-time X firehose, post metadata (faves / retweets / replies), advanced query syntax (`since:` / `min_faves:` / `mode=Latest`). **0 LOC anet, user-side setup needed**: a twitterapi.io API key + a fetcher script. The LLM invokes it through `run_terminal_command`.

**Common to both**: anet itself stays **0 LOC**. The only difference is whether the user has pre-staged a twitterapi.io fetcher in the grok node's cwd.

## Basic tier — out of the box (try this first)

### Start a grok node

```bash
# 1. One-time global setup: log in to grok (browser OAuth)
grok login

# 2. Start a grok-build-acp node (any cwd, no pre-staging needed)
anet node create grok-search --runtime grok-build-acp
anet node start grok-search
```

### Send a basic X search task

```
commhub_send_task(
  alias="grok-search",
  task="Find recent X / Twitter posts by @sama (Sam Altman) about OpenAI from the past week.
        Return each post's https://x.com/... URL + approximate time + a short summary."
)
```

LLM behavior (observed on 0.2.x alpha):

1. `web_search` rawInput auto-fires: `{query: "@sama OpenAI site:x.com", allowed_domains: ["x.com", "twitter.com"]}`
2. Returns X URLs + meta descriptions; LLM stitches into a markdown reply
3. Returns ~5 x.com links; `curl -I` against them returns 5/5 HTTP 200

**Use this when**: you just want to know "who's saying what on X / which posts to open", and don't need faves counts, reply counts, or sub-minute freshness.

**Don't use this for**: ranking by faves, real-time tracking of just-posted tweets, Twitter Advanced Search syntax (`since:2026-05-29` / `min_faves:1000`). Those need the **advanced tier**.

## Advanced tier — real-time + metadata (user-side setup)

### Prereqs (anet = 0 LOC, user prepares 2 things in cwd)

1. **X API key** — pick one:
   - [twitterapi.io](https://twitterapi.io/) (third-party X data proxy, easier to obtain, low monthly cost)
   - Official [X Developer Platform](https://developer.x.com/) (official API, requires X account approval, longer process)
2. **Fetcher script** in the grok node's cwd that supports `node fetch-script.js --query "..."` and emits JSON

Minimal template (place in grok node cwd as `x-fetch.js`):

```js
// x-fetch.js — minimal twitterapi.io X fetcher (advanced tier)
import fs from "node:fs";

const API_KEY = process.env.TWITTER_API_IO_KEY || fs.readFileSync(".env.x").toString().trim();
const query = process.argv.slice(2).join(" ") || "AI";

const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`;
const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
const data = await res.json();

const top = (data.tweets || data.data || []).slice(0, 10).map(t => ({
  handle: t.author?.userName || t.user?.screen_name,
  text: t.text || t.full_text,
  url: `https://x.com/${t.author?.userName || t.user?.screen_name}/status/${t.id}`,
  faves: t.likeCount || t.favorite_count,
  retweets: t.retweetCount,
  replies: t.replyCount,
  created_at: t.createdAt || t.created_at
}));
console.log(JSON.stringify(top, null, 2));
```

3. (Optional but boosts LLM discovery) drop an `X-FETCH.md` hint in cwd:

```markdown
# X data fetcher

To pull X / Twitter posts with faves/retweets metadata, run:
  node x-fetch.js "<query>"

Args support advanced search syntax: `since:2026-05-29`, `min_faves:100`, etc.
```

### Start the node (cwd pointing at the prepped folder)

```bash
cd /path/to/your/x-fetcher-workdir   # contains x-fetch.js + .env.x + X-FETCH.md
anet node create grok-x-pro --runtime grok-build-acp
anet node start grok-x-pro
```

### Send an advanced X search task

```
commhub_send_task(
  alias="grok-x-pro",
  task="Find X posts from the past 24 hours about 'multi-agent framework'.
        Rank by faves, top 5, output markdown with handle / URL / faves / retweets / summary."
)
```

LLM behavior (observed in commhub session `56173df0`, R83 X-search re-audit):

1. `run_terminal_command cat X-FETCH.md` (read hint)
2. `run_terminal_command head -50 x-fetch.js` (verify interface)
3. `run_terminal_command node x-fetch.js "multi-agent framework since:2026-05-29"` (run fetch)
4. ... 17 total `run_terminal_command` calls (incl. `jq` filters) + 2 `web_search` fallbacks
5. LLM natural-language summary reply with 5 real x.com URLs + faves counts

**Content verification (R83)**: `curl -I` returns HTTP 200 for 5/5 URLs (Sam Altman / OpenAI / Anthropic / FransBakker9812 / minchoi); faves counts (3855 / 383 / 154 / 98 / 91) match X ground truth.

## Two-tier comparison

| Dimension | Basic (`web_search`) | Advanced (`run_terminal_command` + twitterapi.io) |
|---|---|---|
| anet LOC | **0** | **0** |
| User-side setup | **0** | twitterapi.io key + `x-fetch.js` + (optional) `X-FETCH.md` |
| Data depth | URL + title + snippet | + faves / retweets / replies / exact timestamp |
| Freshness | hours-to-days lag (web index) | real-time (live API) |
| Advanced syntax | none (LLM fuzzy match) | full (`since:` / `min_faves:` / `mode=Latest`) |
| LLM trigger | ACP-exposed `web_search` tool | `run_terminal_command` invoking user-staged fetcher under ACP isolation |
| Recommended for | Curious browsing | X analytics / reports / KOL engagement tracking |

## Difference vs Scenario 2 (video gen)

| Dimension | Scenario 2 image-to-video | Scenario 1 X-search (basic) | Scenario 1 X-search (advanced) |
|---|---|---|---|
| anet LOC change | **0** ✓ | **0** ✓ | **0** ✓ |
| User-side setup | 0 (URL goes directly into the prompt) | **0** | required (API key + fetcher) |
| Trigger mechanism | Grok backend auto-routes prompt URL to grok-imagine-video | LLM auto-uses ACP-exposed web_search + allowed_domains | LLM runs `run_terminal_command` under ACP isolation against user-staged fetcher |
| Verdict | 🟢 0 LOC integration | 🟢 0 LOC integration | 🟡 0 LOC anet, user-side setup required |

## Prompt tips

- **Basic tier**: just say "find X posts by @user / keyword, give me the URLs" — LLM will pick `web_search` with `allowed_domains=["x.com"]` automatically.
- **Advanced tier**: say "use the project's X fetcher to pull the latest data ranked by faves" — mentioning "fetcher" steers LLM to the `run_terminal_command` path.
- **Specify a time window** (7d / 24h) — the fetcher will apply a time filter.
- **Ask for a markdown report at the end** — the LLM's natural-language summary will embed URLs + metadata cleanly.
- **Don't say "use your X search capability"** — Grok's native XSearch tool is not exposed in the ACP channel (see source below). The LLM will fail to find a tool and fall back to vague web_search output.

## Why does Grok have native X search, but the ACP channel can't reach it?

Grok's **consumer product** (grok.com Web / Grok app) has native real-time X search — that's an xAI-direct feature for consumer users.

Grok's **CLI agent stdio mode (the ACP path anet uses)** does not expose it: the `available_commands_update._meta.tools` list contains no `XSearch` / `x_keyword_search` / `x_user_search`. Confirmed identical across 0.1.219 → 0.2.3 → 0.2.12 alpha.

Why? Likely intentional sandboxing + third-party agent integration layering — ACP is a protocol for "arbitrary client drivers", while the Grok consumer product is xAI's own deep integration. Full schema-introspection proof: [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../tests/p-grok-028-xsearch-acp-probe/report.md).

But 0.2.x added the `web_search.allowed_domains` field — the LLM now auto-uses generic web search constrained to `x.com` and gets X URLs / titles / snippets. That's the source of the basic tier ✅.

## Limitations + follow-up

| ID | Type | Description |
|---|---|---|
| **P1** | docs | Onboarding guide for users preparing a fetcher + X API key (orthogonal to anet, user-side concern) |
| P2 | feature | anet-bundled X informant template (e.g. `anet template install x-fetcher`) — reduce advanced-tier setup friction |
| P2 | feature | commhub `send_reply` MCP schema extension to return fetched X URL list as structured data |
| P3 | docs | Document grok `run_terminal_command` escape hatch behavior (cross-scenario general) |

## Probe sources + references

- [Grok X-search capability probe (ZH)](../research/grok-x-search-capability-probe.md) — includes ⚠ Erratum + schema-introspection direct proof
- [Grok X-search capability probe (EN)](../research/grok-x-search-capability-probe.en.md)
- [Grok 0.2.x ACP XSearch exposure fact-check report](../tests/p-grok-028-xsearch-acp-probe/report.md) — 2026-05-30 schema-introspection across three versions
- [Scenario 2 video-gen-marketing.en.md](./video-gen-marketing.en.md) — sister scenario (image-to-video, 0 LOC)
- [Demo: anet × Grok X search (two tiers)](../../demos/grok-x-search/README.md) — runnable demo
- [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206) · [#204](https://github.com/sleep2agi/agent-network/issues/204) preview.7 isolated cwd prerequisite
- Vincent's ai-insight repo (real-world advanced-tier setup, not in anet repo): `/home/vansin/ai-insight/auto_update_news.js`

---

**Dispatch**: 通信龙 commhub `9e39963c` (#205 Scenario 1 docs amend) + R83 X-search re-audit + 2026-05-30 schema-introspection followup
**Author-Agent**: 通信SDK马
