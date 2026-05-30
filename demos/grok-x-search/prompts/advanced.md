# Advanced-tier prompt template

> Use after the [advanced-tier prereqs](../README.md#tier-2--advanced-user-side-setup) are staged: `x-fetch.js` + `.env.x` + `X-FETCH.md` in the grok node's cwd.

## Template

```
用项目里的 X fetcher (x-fetch.js) 拉数据, 不要用通用 web search:
  · 主题: <关键词 / boolean>
  · 时间窗: <since:YYYY-MM-DD / 过去 24 小时>
  · 互动量门槛: <min_faves:N / min_retweets:N>
  · 排序: <按 faves 倒序 / 按 retweets 倒序 / 按时间倒序>
  · 数量: 前 <N> 条

输出 markdown 表格: handle | URL | faves | retweets | replies | 摘要

最后给一段趋势分析(120 字以内, 含至少 3 个数据点)。
```

## Concrete example

```
用项目里的 X fetcher (x-fetch.js) 拉数据, 不要用通用 web search:
  · 主题: (multi-agent OR "multi agent") framework
  · 时间窗: since:2026-05-23
  · 互动量门槛: min_faves:50
  · 排序: 按 faves 倒序
  · 数量: 前 5 条

输出 markdown 表格: handle | URL | faves | retweets | replies | 摘要

最后给一段趋势分析(120 字以内, 含至少 3 个数据点)。
```

## Why this prompt shape

- **"用项目里的 X fetcher (x-fetch.js)"**: anchors the LLM on the user-staged script. Without this, the LLM has a 50/50 chance of trying `web_search` first (which is fine but won't give faves/retweets).
- **"不要用通用 web search"**: explicit negative steering. Otherwise the LLM might use both and confuse itself comparing snippets.
- **互动量门槛 + 排序**: forces the LLM to use the X advanced search syntax that twitterapi.io understands. The result is richer than what web_search can give.
- **"markdown 表格"**: structured output. Easier for downstream agents or humans to consume.
- **"趋势分析 + 至少 3 个数据点"**: a guard against generic summaries; the LLM has to cite specific numbers from the fetched data.

## Expected behavior (verified in [R83 trace](../../../docs/tests/p-grok-028-xsearch-acp-probe/report.md))

```
[tool_call] run_terminal_command  cat X-FETCH.md
[tool_call] run_terminal_command  head -50 x-fetch.js
[tool_call] run_terminal_command  node x-fetch.js "(multi-agent OR 'multi agent') framework since:2026-05-23 min_faves:50" --top --max 5
[tool_call] run_terminal_command  jq 'sort_by(-.faves) | .[0:5]' (optional refinement)
...
```

R83 observed 17 `run_terminal_command` calls (most were `head`/`cat`/`jq` refinements) + 2 `web_search` fallbacks (when the fetcher returned fewer than the requested 5 hits). The final reply was a markdown table with verifiable faves counts (3855 / 383 / 154 / 98 / 91).

## Common refinements

- **Time precision**: `since:2026-05-29` (date), `since:2026-05-29_12:00:00_PST` (datetime). twitterapi.io honors both.
- **Account-only**: prefix with `from:sama` — filters to one author.
- **Mentions**: `@OpenAI` matches posts that mention the account.
- **Language**: `lang:en` / `lang:zh` — limits to a language.
- **Excluding**: `-replies` to exclude replies, `-retweets` to exclude retweets.

The X advanced search reference is at https://help.twitter.com/en/using-twitter/twitter-advanced-search — almost everything documented there works through twitterapi.io.

## What if the user has no API key?

Fall back to the [basic tier prompt](./basic.md). The basic tier covers ~70 % of "what's on X about X" use cases without setup. If the user needs faves / retweets / freshness for analytics, the ~5 min twitterapi.io signup is the cost.
