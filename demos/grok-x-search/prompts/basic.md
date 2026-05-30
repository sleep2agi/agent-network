# X-search prompt template (grok native, no setup)

> Copy-paste-able. Drop in any of:
> - the dashboard "send task" form
> - a `commhub_send_task` MCP call from any agent
> - the `anet send` CLI

## Template

```
找一下 X (Twitter) 上 <主题 / @某人 / #话题> 最近的几条帖子。
每条:
  · 完整 https://x.com/<handle>/status/<id> URL
  · 一段中文摘要
  · 大致时间

markdown 列表输出, <N> 条左右。
```

## Concrete examples

### By handle

```
找一下 X (Twitter) 上 @sama 最近关于 AGI 的几条帖子,
给我每条的 https://x.com/... 链接 + 中文摘要 + 大致时间,
markdown 列表 5 条左右。
```

→ Verified output: 5 real x.com/sama URLs, 5/5 HTTP 200, content matches actual Sam Altman posts. See [E2E probe report](../../../docs/tests/p-grok-native-xsearch-e2e/report.md).

### By hashtag

```
找一下 X (Twitter) 上 #AI 话题最近的几条高曝光讨论,
给每条的 URL + 中文摘要 + 大致时间,
markdown 列表 5 条左右。

如果搜索结果里 faves / retweets 数不可信, 直接说"没有精确互动数据",
不要编造数字。
```

### By topic (boolean)

```
找一下 X (Twitter) 上同时提到 "OpenAI" 和 "AGI" 的最近帖子,
按时间倒序前 5 条, 给每条 URL + 摘要 + 时间, markdown 列表。
```

### English variant

```
Find recent X / Twitter posts by @<handle> about <topic>.
For each: https://x.com/... URL + a short summary + approximate date.
Markdown list, around 5 items.
```

## Why this prompt shape

- **"找 ... X (Twitter) 上 ..."** — natural Chinese phrasing. The LLM auto-picks `web_search` with `allowed_domains=["x.com","twitter.com"]`. Do **not** say "用你的 XSearch 工具" — that tool isn't exposed in the ACP channel; the LLM will hunt for it, fail, and dump a vague fallback.

- **Always demand `https://x.com/<handle>/status/<id>` URL format** — keeps the LLM honest. The reply ends up curl-verifiable. Without explicit URL request, the LLM sometimes returns "post about X" without the linkable status URL.

- **"markdown 列表 N 条"** — anet relays the reply as raw text. Markdown renders nicely in dashboards / IM integrations.

- **For metadata-sensitive prompts, include "不要编造"** — the LLM, on Grok 0.2.x alpha, will honestly say "I can't get accurate faves counts" rather than fabricate numbers. See [advanced-reply.md](../../../docs/tests/p-grok-native-xsearch-e2e/advanced-reply.md) for a verbatim example of the LLM declining to fake data.

## What works well in this mode

- Recent posts by a specific handle (`@sama`, `@OpenAI`, `@AndrewYNg`...)
- Topic / boolean keyword search (`OpenAI AND AGI`, `(multi-agent OR agentic) framework`)
- Time-windowed search ("过去 7 天", "this week", "since:2026-05-23" — LLM forwards to web_search)
- Multilingual queries (Chinese / English / 日本語 / etc.)
- Producing markdown reports with curl-verifiable URLs

## What won't work in this mode (X platform limitation, not Grok)

- Real-time freshness (sub-hour) — web index lag
- Ranking by faves / retweets — X reserves engagement data
- Pulling reply / thread metadata
- X Advanced Search syntax that needs logged-in session (`min_faves:`, `mode=Latest`)

→ The LLM will tell you honestly when those limits hit. See README §"What grok native genuinely cannot do".
