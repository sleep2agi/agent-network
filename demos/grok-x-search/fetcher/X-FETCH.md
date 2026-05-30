# X data fetcher (LLM hint)

> This file is intentionally placed at the root of an anet grok-build-acp node's working directory. The LLM, on startup or on receiving an X-related task, will read this file and learn how to invoke the fetcher.

To pull X / Twitter posts with **faves / retweets / replies metadata**, run the local fetcher script:

```bash
node x-fetch.js "<query>"
```

The fetcher hits twitterapi.io's `advanced_search` endpoint and returns a JSON array sorted by faves (descending).

## Query syntax

The `<query>` argument is forwarded verbatim to twitterapi.io's advanced search, so the X advanced search syntax all works:

- `since:2026-05-29` — only posts after that date
- `min_faves:100` — only posts with ≥ 100 faves
- `min_retweets:50` — only posts with ≥ 50 retweets
- `from:sama` — only posts by `@sama`
- `lang:en` — only English posts
- `(OpenAI OR Anthropic) (model OR release)` — boolean composition

## Flags

| Flag | Effect |
|---|---|
| `--top` | use `queryType=Top` (X ranks by engagement) |
| `--latest` | use `queryType=Latest` (X ranks by recency) — default |
| `--max N` | cap output to top-N items (default 10, max 50) |

## Examples

```bash
# Top 5 high-engagement posts about multi-agent frameworks in the past 7 days
node x-fetch.js "(multi-agent OR multi agent) framework since:2026-05-23 min_faves:50" --top --max 5

# Latest 10 posts from @sama mentioning OpenAI
node x-fetch.js "from:sama OpenAI" --max 10

# English posts about Anthropic with > 100 faves
node x-fetch.js "Anthropic lang:en min_faves:100" --top
```

## Output shape

```jsonc
[
  {
    "handle": "sama",
    "text": "AI should massively improve...",
    "url": "https://x.com/sama/status/2059677202917331431",
    "faves": 3855,
    "retweets": 412,
    "replies": 178,
    "created_at": "Wed May 27 16:44:46 +0000 2026"
  },
  ...
]
```

Pipe through `jq` for further filtering — for example, `jq 'sort_by(-.faves) | .[0:5]'`.

## Setup

API key lives in `.env.x` in the same directory (a single line: just the key). The script also accepts `TWITTER_API_IO_KEY` in the environment. Sign up at https://twitterapi.io to get a key.
