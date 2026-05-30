# Basic-tier prompt template

> Copy-paste-able. Drop in any of:
> - dashboard "send task" form
> - a `commhub_send_task` MCP call from any agent
> - the `anet send` CLI

## Template

```
请用 X (Twitter) 上的搜索能力找:
  · 主题: <你要的关键词 / @某人>
  · 时间窗: <过去 24 小时 / 7 天 / 30 天>
  · 输出: markdown 列表, 每条含 https://x.com/... URL + 一段摘要 + 大致时间

最后给一个一句话趋势总结。
```

## Concrete example

```
请用 X (Twitter) 上的搜索能力找:
  · 主题: @sama (Sam Altman) 谈 AGI
  · 时间窗: 过去 14 天
  · 输出: markdown 列表, 每条含 https://x.com/... URL + 一段摘要 + 大致时间

最后给一个一句话趋势总结。
```

## Why this prompt shape

- "**用 X 上的搜索能力**" rather than "用你的 XSearch 工具" — the former lets the LLM pick `web_search` with `allowed_domains=["x.com"]`; the latter sends it hunting for an `XSearch` tool that isn't there (see [schema-introspection report](../../../docs/tests/p-grok-028-xsearch-acp-probe/report.md)) and then producing a vague fallback.
- "**`https://x.com/...` URL**" — explicitly demanding the URL keeps the LLM honest. The reply ends up curl-verifiable.
- "**markdown 列表**" — anet relays the reply as raw text. Markdown renders nicely in dashboard / IM integrations.
- "**一句话趋势总结**" — gives the LLM something to do after the URL list, so it doesn't pad with hedges.

## Expected behavior

The LLM auto-fires `web_search` with `rawInput.allowed_domains=["x.com","twitter.com"]`. Returns a 3-7 item markdown list with x.com URLs. `curl -I` against each returns HTTP 200.

## What you can change

- Multiple keywords / boolean composition: `"OpenAI" OR "Anthropic"` — the LLM forwards this verbatim into the web_search query.
- Account filters: `from:@sama` or `@OpenAI` — the LLM rewrites those into the web_search query reasonably.
- Time windows up to ~30 days are fine; longer windows risk hitting the web index limit (results get sparser).
- Number of results (3 / 5 / 10) — just say "前 5 条" / "10 条".

## What you can't (need advanced tier for)

- Ranking by faves / retweets
- Sub-hour freshness
- `since:` / `until:` X advanced syntax with strict date math
- Filtering by `min_faves:` / `min_retweets:`
- Pulling `replies` count or thread relationships
