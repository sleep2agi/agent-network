# Demo: anet × Grok Build — X (Twitter) search (pure native)

> **Pitch**: anet `grok-build-acp` nodes can search X with **zero anet code changes** and **zero user-side setup** — no API key, no fetcher script, no extra MCP. The Grok agent uses its built-in `web_search` (with `allowed_domains=["x.com"]`) plus `web_fetch` to find posts and pull URLs / titles / approximate dates.
>
> **Author**: 通信SDK马 · **场景文档**: [`docs/scenarios/x-search-informant.md`](../../docs/scenarios/x-search-informant.md) · **能力探测**: [`docs/research/grok-x-search-capability-probe.md`](../../docs/research/grok-x-search-capability-probe.md) · **E2E probe**: [`docs/tests/p-grok-native-xsearch-e2e/report.md`](../../docs/tests/p-grok-native-xsearch-e2e/report.md)

## What you get out of the box

Real X URLs + post summaries + approximate dates for any keyword / handle / topic — using only Grok's native capabilities. The LLM returned 5 real, valid `x.com/sama/status/…` URLs for "find @sama's recent AGI posts" (see the [E2E probe report](../../docs/tests/p-grok-native-xsearch-e2e/report.md)); the URLs open in any browser. **Note (2026-06-06):** a bare `curl -I` (HEAD) against these now returns `HTTP 403` — X tightened anti-scraping on non-browser requests since the probe. That's an X-platform change, unrelated to anet/grok. This demo's reproducibility is about **the LLM finding correct, real URLs**, not about anonymous `curl` reachability.

## Run it

### 1. One-time setup (if you don't already have Grok CLI)

```bash
# Install Grok Build CLI
grok --version       # confirm 0.2.x alpha or newer
grok login           # browser OAuth, stores token in ~/.grok/auth.json
```

### 2. Spin up an anet grok node

```bash
anet node create grok-x --runtime grok-build-acp
anet node start grok-x
```

> Use a local / dev commhub for the demo. **Don't connect to a production hub** (red line).

### 3. Send an X-search task

From any anet caller (claude / codex / grok / the dashboard / a script):

```
commhub_send_task(
  alias="grok-x",
  task="找一下 X (Twitter) 上 @sama 最近关于 AGI 的几条帖子,
        给我每条的 https://x.com/... 链接 + 中文摘要 + 大致时间,
        markdown 列表 5 条左右。"
)
```

Or in English:

```
commhub_send_task(
  alias="grok-x",
  task="Find recent X / Twitter posts by @sama about AGI.
        For each: https://x.com/... URL + summary + approximate date.
        Markdown list, around 5 items."
)
```

That's it. The LLM uses Grok's built-in `web_search` and `web_fetch`, picks up `allowed_domains=["x.com"]` automatically, returns a clean markdown list with real, browser-openable URLs.

A polished prompt template + sample reply lives in [`prompts/basic.md`](prompts/basic.md).

### 4. Sample real output (verbatim from the E2E probe)

```
**以下是 @sama（Sam Altman）最近关于 AGI 的几条代表性帖子**(按时间从新到旧排序):

- **2026年5月约20日** https://x.com/sama/status/2057218997503086888
  列出 OpenAI 当前最兴奋的三件事(AGI 加速科研 / AGI 加速公司发展 /
  个人 AGI 帮助每个人实现目标)...

- **2026年4月27日左右** https://x.com/sama/status/2048426122854228141
  反讽语气引用"后 AGI 时代没人工作", 然后说因为 GPT-5.5 Codex 太强,
  他正在改用多相睡眠...

- **2025年10月29日** https://x.com/sama/status/1983584366547829073
  公开 OpenAI 内部目标 — 2026 年 9 月要实现能在数十万 GPU 上运行的
  "自动化 AI 研究实习生", 2028 年 3 月要实现"真正的自动化 AI 研究员"...

- **2025年7月17日左右** https://x.com/sama/status/1945901039104004467
  看着 ChatGPT Agent 像人一样使用电脑完成复杂任务, 对他来说是真正的
  "feel the AGI"时刻...

- **2025年5月** https://x.com/sama/status/1926061979031969909
  认为大家不应该再纠结 AGI 具体哪一年到来, 而应该开始讨论"第一艘
  自我复制的宇宙飞船(von Neumann probe)什么时候能发射升空"...
```

All five are real, valid `x.com/sama/status/…` URLs that open in any browser — see [`basic-urls.txt`](../../docs/tests/p-grok-native-xsearch-e2e/basic-urls.txt) for the verbatim list. (A bare `curl -I` now returns `HTTP 403` due to X anti-scraping, as noted up top — the URLs are still real.)

## What grok native gives you

| Capability | Grok native can do? |
|---|---|
| Find X URLs by keyword | ✅ via `web_search` + `allowed_domains=["x.com"]` |
| Find posts by handle (e.g. `@sama`) | ✅ same |
| Find posts by hashtag (e.g. `#AI`) | ✅ same, plus generic web index |
| Approximate post date | ✅ extracted from search results / page content |
| Post title / summary | ✅ via `web_fetch` against the URL |
| Multilingual results / Chinese keywords | ✅ |
| Multi-URL markdown report | ✅ Grok composes a clean markdown list |

## What grok native genuinely cannot do (be honest)

| Capability | Grok native | Why? |
|---|---|---|
| Real-time freshness (sub-hour) | ❌ | Web index lag |
| Exact faves / retweets / replies counts | ❌ | X reserves this for logged-in users + the X Premium API |
| Rank by faves / retweets | ❌ | requires the counts above |
| X Advanced Search syntax (`min_faves:`, `mode=Latest`) | ❌ | requires logged-in X session or X API |
| Pulling thread / reply trees | ❌ | requires logged-in X session |

This is a **platform-level limitation, not a Grok or anet limitation**. X (the company) walls off engagement metadata for non-logged-in scrapers and routes paid access through `developer.x.com` (official) or third-party proxies like twitterapi.io.

**The LLM, when faced with a prompt that asks for those metrics, will refuse honestly rather than fabricate** — see [`advanced-reply.md`](../../docs/tests/p-grok-native-xsearch-e2e/advanced-reply.md) for a verbatim example where it explained which capability it lacked and offered to help write a script that would call X API directly.

That's the right answer: anet does not bundle a third-party X API client just to fake real-time faves data.

## If you really need engagement metadata

This is **out of scope for anet's default X-search demo**, but if you have a project that genuinely needs faves / retweets ranking:

1. Get an X API key — either from the official [X Developer Platform](https://developer.x.com/) or from a third-party proxy like [twitterapi.io](https://twitterapi.io/).
2. Drop a small fetcher script in your grok node's cwd along with a hint file explaining how to invoke it. The Grok LLM will discover it (via `list_dir` / `read_file`) and call it through `run_terminal_command` when needed.
3. We deliberately don't ship a template for this — every team's API choice / quota model / output schema is different, and shipping a sample twitterapi.io fetcher would imply that's the default integration path (it isn't).

The R83 trace ([docs/tests/p-grok-028-xsearch-acp-probe/report.md](../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)) documents the LLM behavior pattern for the workspace-staged-fetcher escape hatch, if you want to replicate it for your own setup.

## Why this demo doesn't ship a fetcher

A previous version of this demo bundled a `twitterapi.io` fetcher as the "advanced tier" path. Vincent pushed back: **demo X search 必须用 grok build 自带能力**. He was right. The schema-introspection that surfaced "XSearch isn't exposed" had two distinct failure modes:

1. ❌ Naive: "schema doesn't have XSearch → must integrate external" — what the previous version did.
2. ✅ Correct: "schema doesn't have XSearch → run a real prompt and see what Grok actually does with `web_search` + reasoning".

The E2E probe ([`docs/tests/p-grok-native-xsearch-e2e/report.md`](../../docs/tests/p-grok-native-xsearch-e2e/report.md)) proved Vincent right: the LLM uses native tools to satisfy the basic-tier ask completely, returning real, browser-openable URLs.

This is the third "schema-not-artifact" lesson banked in the agent-action verification discipline — see RFC-021 §14.

## Pair with Scenario 2

See [`demos/grok-video-gen/`](../grok-video-gen/) for the hero 0-LOC image-to-video demo (1.3 MB sample MP4 included). Together they cover the two #205 flagship scenarios.

## References

- Scenario doc: [`docs/scenarios/x-search-informant.md`](../../docs/scenarios/x-search-informant.md)
- Capability probe (含 Erratum 3 native-tier 修正): [`docs/research/grok-x-search-capability-probe.md`](../../docs/research/grok-x-search-capability-probe.md)
- E2E native probe (本 demo 的实证): [`docs/tests/p-grok-native-xsearch-e2e/report.md`](../../docs/tests/p-grok-native-xsearch-e2e/report.md)
- Schema-introspection (互补层): [`docs/tests/p-grok-028-xsearch-acp-probe/report.md`](../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)
- RFC-021 §14 lesson banked: [`docs/rfcs/RFC-021-acp-capability-profile-expansion.md`](../../docs/rfcs/RFC-021-acp-capability-profile-expansion.md)
- Upstream issues: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#206](https://github.com/sleep2agi/agent-network/issues/206)
