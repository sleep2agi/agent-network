#!/usr/bin/env node
// x-fetch.js — minimal twitterapi.io X (Twitter) fetcher for the
// "advanced tier" of the grok-x-search demo.
//
// Drop this into the working directory you'll point an anet grok-build-acp
// node at, along with X-FETCH.md (LLM-facing hint) and .env.x (API key).
// The LLM, once it sees X-FETCH.md, will call:
//
//   node x-fetch.js "<query>"            # default: queryType=Latest
//   node x-fetch.js "<query>" --top      # use queryType=Top
//   node x-fetch.js "<query>" --max 20   # cap top-N
//
// Output: pretty-printed JSON array of normalized post objects sorted by
// faves (descending). The LLM will pipe this into jq / etc. as needed.
//
// References:
//   - twitterapi.io advanced search:
//     https://docs.twitterapi.io/api-reference/endpoint/advanced_search
//   - sister demo (basic tier): ../README.md
//   - scenario doc: docs/scenarios/x-search-informant.md

import fs from "node:fs";
import path from "node:path";

function loadApiKey() {
  if (process.env.TWITTER_API_IO_KEY) return process.env.TWITTER_API_IO_KEY.trim();
  for (const file of [".env.x", ".env.twitterapi", path.join(process.env.HOME ?? "", ".twitterapi-io")]) {
    if (file && fs.existsSync(file)) {
      const txt = fs.readFileSync(file, "utf8").trim();
      const match = txt.match(/^(?:TWITTER_API_IO_KEY=)?(.+?)$/m);
      if (match && match[1]) return match[1].trim();
    }
  }
  throw new Error("No twitterapi.io API key found. Set TWITTER_API_IO_KEY env or put it in .env.x in cwd.");
}

function parseArgs(argv) {
  const args = { query: "", queryType: "Latest", max: 10 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") args.queryType = "Top";
    else if (a === "--latest") args.queryType = "Latest";
    else if (a === "--max") { args.max = Math.max(1, Math.min(50, Number(argv[++i] || 10))); }
    else if (a.startsWith("--")) {
      // Unknown flag, skip.
    } else {
      rest.push(a);
    }
  }
  args.query = rest.join(" ").trim() || "AI";
  return args;
}

function normalize(t) {
  const handle = t.author?.userName || t.user?.screen_name || "";
  const id = t.id || t.id_str || "";
  return {
    handle,
    text: t.text || t.full_text || "",
    url: handle && id ? `https://x.com/${handle}/status/${id}` : null,
    faves: t.likeCount ?? t.favorite_count ?? 0,
    retweets: t.retweetCount ?? t.retweet_count ?? 0,
    replies: t.replyCount ?? t.reply_count ?? 0,
    created_at: t.createdAt || t.created_at || null
  };
}

async function main() {
  const apiKey = loadApiKey();
  const { query, queryType, max } = parseArgs(process.argv.slice(2));
  const url =
    `https://api.twitterapi.io/twitter/tweet/advanced_search` +
    `?query=${encodeURIComponent(query)}` +
    `&queryType=${queryType}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`twitterapi.io ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const tweets = data.tweets ?? data.data ?? [];
  const out = tweets
    .map(normalize)
    .filter((t) => t.url)
    .sort((a, b) => b.faves - a.faves)
    .slice(0, max);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`x-fetch error: ${e.message}\n`);
  process.exit(1);
});
