# Demo: anet × Grok Build — X (Twitter) search (two tiers)

> **Pitch**: anet `grok-build-acp` nodes can search X with **zero anet code changes** in either of two modes — a basic tier that's truly out-of-the-box, and an advanced tier that depends on a small user-side setup. This demo shows both, side by side.
>
> **Author**: 通信SDK马 · **场景文档**: [`docs/scenarios/x-search-informant.md`](../../docs/scenarios/x-search-informant.md) · **能力探测**: [`docs/research/grok-x-search-capability-probe.md`](../../docs/research/grok-x-search-capability-probe.md) · **schema 直证**: [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)

## Why two tiers?

A 2026-05-30 schema-introspection check confirmed that the Grok agent stdio mode (the ACP path anet uses) **does not expose** `XSearch` / `x_keyword_search` / `x_user_search` to the LLM in any version (0.1.219 → 0.2.3 → 0.2.12 alpha). But:

- It **does** expose `web_search`, and 0.2.x added an `allowed_domains` field. The LLM auto-targets `x.com` for X-flavoured queries — that's the **basic tier**, 0 LOC + 0 user setup.
- For real-time data with faves / retweets / replies metadata + advanced syntax (`since:` / `min_faves:` / `mode=Latest`), the LLM escapes the ACP isolation via `run_terminal_command` to call a user-staged fetcher (e.g. `twitterapi.io`). That's the **advanced tier**, 0 LOC anet but with user-side setup.

## Tier 1 — Basic (out of the box)

### What you get

X URLs + post titles + short snippets + approximate dates. No faves counts, no real-time freshness, no advanced syntax. Good for "what's the conversation on X about <topic>" without setting anything up.

### Run it

```bash
# One-time
grok --version             # confirm 0.2.x alpha or newer
grok login

# Spin up an anet grok node — cwd can be anything, nothing to pre-stage
anet node create grok-x-basic --runtime grok-build-acp
anet node start grok-x-basic
```

Send a task from any anet caller:

```
commhub_send_task(
  alias="grok-x-basic",
  task="找 X / Twitter 上 @sama (Sam Altman) 最近一周关于 OpenAI 的帖子,
        每条返回 https://x.com/... URL + 大致时间 + 一段摘要,markdown 输出。"
)
```

### Expected LLM behavior

The LLM auto-uses `web_search` with `allowed_domains=["x.com","twitter.com"]`:

```
[tool_call] title="web_search" rawInput={"query":"@sama OpenAI site:x.com","allowed_domains":["x.com","twitter.com"]}
```

The reply contains a markdown list of x.com URLs. `curl -I` against them returns HTTP 200 (validated 5/5 in [R83 trace](../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)).

A polished prompt + sample reply lives in [`prompts/basic.md`](prompts/basic.md).

## Tier 2 — Advanced (user-side setup)

### What you get

Real-time X posts with **faves / retweets / replies / exact timestamp** metadata + full advanced search syntax (`since:`, `min_faves:`, `mode=Latest`, etc.). Useful for X analytics, KOL tracking, dated reports.

### Prereqs (user-side; anet is still 0 LOC)

You stage three things in a dedicated working directory, then point the grok node at that directory.

1. **An X API key**. We recommend [twitterapi.io](https://twitterapi.io) — third-party X proxy, ~$5–10/mo, no application waiting list. Put the key into a `.env.x` file in the workdir.

2. **A fetcher script**. The minimal viable one ships in this demo as [`fetcher/x-fetch.js`](fetcher/x-fetch.js) — copy it into your workdir.

3. **A hint file** so the LLM finds the fetcher quickly. The template lives at [`fetcher/X-FETCH.md`](fetcher/X-FETCH.md) — drop it into the workdir too.

```bash
mkdir -p /tmp/anet-grok-x-pro
cp demos/grok-x-search/fetcher/x-fetch.js     /tmp/anet-grok-x-pro/
cp demos/grok-x-search/fetcher/X-FETCH.md      /tmp/anet-grok-x-pro/
echo "<your twitterapi.io key>" > /tmp/anet-grok-x-pro/.env.x
```

### Run it

```bash
cd /tmp/anet-grok-x-pro
anet node create grok-x-pro --runtime grok-build-acp
anet node start grok-x-pro
```

Send a task:

```
commhub_send_task(
  alias="grok-x-pro",
  task="找过去 24 小时 X 上关于 multi-agent framework 的帖子,
        按 faves 排序前 5, 输出 markdown 含 handle / URL / faves / retweets / 摘要,
        用项目里的 X fetcher 拉真实数据。"
)
```

The phrase "用项目里的 X fetcher" steers the LLM to the `run_terminal_command` path rather than `web_search`.

### Expected LLM behavior

```
[tool_call] title="run_terminal_command" cmd="cat X-FETCH.md"
[tool_call] title="run_terminal_command" cmd="head -50 x-fetch.js"
[tool_call] title="run_terminal_command" cmd="node x-fetch.js 'multi-agent framework since:2026-05-29' | jq 'sort_by(-.faves) | .[0:5]'"
...
```

R83 trace observed 17 `run_terminal_command` calls total + 2 `web_search` fallbacks (when the fetcher didn't have enough fresh hits). Final markdown reply contained 5 real x.com URLs with faves counts matching X ground truth (3855 / 383 / 154 / 98 / 91).

A polished prompt + sample reply lives in [`prompts/advanced.md`](prompts/advanced.md).

## Side-by-side comparison

| Dimension | Tier 1 Basic | Tier 2 Advanced |
|---|---|---|
| anet LOC | **0** | **0** |
| User setup | **0** | twitterapi.io key + `x-fetch.js` + `X-FETCH.md` |
| Time to first result | ~30 s after `anet node start` | ~5 min (one-time key + file copy) |
| Data depth | URL + title + snippet | + faves / retweets / replies / timestamp |
| Freshness | hours-days lag | real-time |
| Advanced syntax | none | full |
| Best for | "what's on X about X?" | analytics, reports, KOL tracking |
| ACP path used | exposed `web_search` tool | `run_terminal_command` escape hatch |

## Why anet ships 0 LOC for both

Tier 1 piggybacks on Grok's already-exposed `web_search` tool and the LLM's policy improvement in 0.2.x (it learned to set `allowed_domains` automatically for X-flavoured prompts). Tier 2 piggybacks on Grok's universally-exposed `run_terminal_command` — the LLM can shell out, find the user's fetcher, and use it. anet's `grok-build-acp` runtime provides isolated cwd (#204 preview.7) so each grok node has a clean workspace, but it does **not** wire any X-specific MCP or model handler. The integration is "give the user the right tools, get out of the way".

## Pair with Scenario 2

See [`demos/grok-video-gen/`](../grok-video-gen/) for the hero 0-LOC video generation demo (1.3 MB sample MP4 included). Together they cover the two #205 flagship scenarios.

## References

- Scenario doc: [`docs/scenarios/x-search-informant.md`](../../docs/scenarios/x-search-informant.md)
- Capability probe (含 Erratum 2 schema-introspection direct proof): [`docs/research/grok-x-search-capability-probe.md`](../../docs/research/grok-x-search-capability-probe.md)
- Schema-introspection fact-check: [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)
- RFC-021 §13 ACP exposure verdict: [`docs/rfcs/RFC-021-acp-capability-profile-expansion.md`](../../docs/rfcs/RFC-021-acp-capability-profile-expansion.md)
- Upstream issues: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206)
