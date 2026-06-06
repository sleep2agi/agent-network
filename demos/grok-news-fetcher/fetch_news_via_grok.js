#!/usr/bin/env node
/**
 * fetch_news_via_grok.js
 *
 * Headless grok-build X (Twitter) news fetcher.
 *
 * Drop-in fallback for A站 ai-insight's news pipeline when twitterapi.io quota
 * is exhausted. Output schema is byte-identical to
 * `auto_update_news.js --fetch-only`.
 *
 * Usage:
 *   ./fetch_news_via_grok.js \
 *     --accounts @OpenAI,@AnthropicAI,@sama \
 *     --since 24h \
 *     --start-id 1 \
 *     --out news.json
 *
 *   ./fetch_news_via_grok.js --since 2026-06-06 --out -    # stdout
 *
 * Defaults:
 *   --accounts   the 10 anchor accounts (see DEFAULT_ACCOUNTS below)
 *   --since      24h
 *   --start-id   1
 *   --out        ./news.json     (use "-" for stdout)
 *   --max-per    5               (max tweets per account)
 *   --timeout    180             (per-account grok timeout, seconds)
 *
 * Exit codes:
 *   0  success — at least 1 tweet aggregated
 *   1  all accounts failed / total tweet count = 0 (output is empty tweets array)
 *   2  bad CLI arguments
 *   3  grok binary missing / not logged in
 *
 * Strictly:
 *   - parses STDOUT only (stderr has PermissionDenied + serde noise, ignored)
 *   - never fabricates data — failed accounts produce zero entries silently
 *   - writes the canonical schema even on full failure (empty tweets array)
 */

const { spawnSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ACCOUNTS = [
  "@OpenAI",
  "@AnthropicAI",
  "@GoogleDeepMind",
  "@xai",
  "@sama",
  "@karpathy",
  "@Alibaba_Qwen",
  "@deepseek_ai",
  "@Kimi_Moonshot",
  "@nvidia",
];

const DEFAULTS = {
  since: "24h",
  startId: 1,
  out: "./news.json",
  maxPer: 5,
  timeout: 180,
};

function parseArgs(argv) {
  const out = {
    accounts: null,
    since: DEFAULTS.since,
    startId: DEFAULTS.startId,
    out: DEFAULTS.out,
    maxPer: DEFAULTS.maxPer,
    timeout: DEFAULTS.timeout,
    verbose: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--accounts":
        out.accounts = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--since":
        out.since = next();
        break;
      case "--start-id":
        out.startId = Number.parseInt(next(), 10);
        break;
      case "--out":
        out.out = next();
        break;
      case "--max-per":
        out.maxPer = Number.parseInt(next(), 10);
        break;
      case "--timeout":
        out.timeout = Number.parseInt(next(), 10);
        break;
      case "-v":
      case "--verbose":
        out.verbose = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        process.stderr.write(`unknown arg: ${a}\n`);
        process.exit(2);
    }
  }
  if (!out.accounts) out.accounts = DEFAULT_ACCOUNTS;
  if (!Number.isFinite(out.startId) || out.startId < 0) out.startId = 1;
  if (!Number.isFinite(out.maxPer) || out.maxPer < 1) out.maxPer = DEFAULTS.maxPer;
  if (!Number.isFinite(out.timeout) || out.timeout < 30) out.timeout = DEFAULTS.timeout;
  return out;
}

function printHelp() {
  process.stdout.write(`fetch_news_via_grok.js — headless X fetcher (grok-build)

Usage:
  fetch_news_via_grok.js [options]

Options:
  --accounts <list>   Comma-separated @handles  (default: 10 anchor accounts)
  --since <window>    Time window. Either "<N>h" (relative hours) or
                      "YYYY-MM-DD" (absolute date). Default: 24h
  --start-id <n>      Sets the "nextId" field in the output. Default: 1
  --out <path>        Output file path. Use "-" for stdout. Default: ./news.json
  --max-per <n>       Max tweets per account. Default: 5
  --timeout <secs>    Per-account grok call timeout. Default: 180
  -v, --verbose       Log per-account progress to stderr
  -h, --help          Show this help

Exit codes:
  0  >=1 tweet aggregated
  1  zero tweets after all accounts
  2  bad CLI args
  3  grok binary missing / not logged in
`);
}

function preflight() {
  try {
    const v = execSync("grok --version", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (!v.match(/^grok 0\.2\./)) {
      process.stderr.write(`[warn] grok version ${v} is outside the tested 0.2.x band\n`);
    }
  } catch {
    process.stderr.write(`[err] grok binary not on PATH — install grok-build CLI first\n`);
    process.exit(3);
  }
  // Best-effort: warn if no auth.json — grok will still err with a clear message.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && !fs.existsSync(path.join(home, ".grok", "auth.json"))) {
    process.stderr.write(`[warn] ~/.grok/auth.json missing — run "grok login" before this script\n`);
  }
}

function computeCutoff(since) {
  const now = new Date();
  if (/^\d+h$/i.test(since)) {
    const hours = Number.parseInt(since, 10);
    const cutoff = new Date(now.getTime() - hours * 3600 * 1000);
    return { cutoffISO: cutoff.toISOString().slice(0, 10), hours };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return { cutoffISO: since, hours: null };
  }
  return { cutoffISO: now.toISOString().slice(0, 10), hours: 24 };
}

function buildPrompt(handle, since, maxPer) {
  const cleanHandle = handle.replace(/^@/, "");
  const today = new Date().toISOString().slice(0, 10);
  const { cutoffISO, hours } = computeCutoff(since);
  const windowDescZh = hours != null ? `最近 ${hours} 小时 (自 ${cutoffISO} 起)` : `自 ${cutoffISO} 起`;
  const windowDescEn = hours != null ? `the last ${hours} hours (since ${cutoffISO})` : `since ${cutoffISO}`;
  return [
    `Today is ${today}. Find recent original posts on X (Twitter) from @${cleanHandle} within ${windowDescEn}, at most ${maxPer} posts.`,
    `(中文: 今天是 ${today}, 找 @${cleanHandle} ${windowDescZh}内的原创帖, 最多 ${maxPer} 条, 不含 retweet)`,
    "",
    "**Steps**:",
    `1. Use web_search (allowed_domains=["x.com"]) to find @${cleanHandle}'s most recent original posts`,
    "2. Use web_fetch if needed to confirm post body and publish date",
    "3. Output ONLY a strict JSON array — no markdown, no explanation, no code fence",
    "",
    "Each array item fields:",
    `  user        "${cleanHandle}"          (handle without @)`,
    `  name        display name              (e.g. "Sam Altman")`,
    `  text        post body or faithful summary in Chinese (~80 chars)`,
    `  url         https://x.com/${cleanHandle}/status/<id>  (real, browser-openable)`,
    `  date        YYYY-MM-DD  (real publish date — MUST be accurate to the day)`,
    `  media_url   https://pbs.twimg.com/... or https://video.twimg.com/...  (real direct media link; "" if no image/video)`,
    "",
    "**HARD RECENCY REQUIREMENTS** (post will be dropped otherwise):",
    `  · date MUST be >= ${cutoffISO} (the cutoff). Do NOT include older posts. Do NOT pad date with today's date if you don't know the real one — drop that post instead.`,
    "  · If unsure of the real publish date, drop the post — do NOT fabricate a recent date to pass the filter.",
    `  · If no posts in [${cutoffISO}, ${today}] match, return empty array [].`,
    "",
    "**OTHER HARD RULES**:",
    `  · url MUST start with "https://x.com/${cleanHandle}/status/" followed by digits-only status id`,
    `  · media_url, if non-empty, MUST be a real direct image/video link (pbs.twimg.com, video.twimg.com, or x.com/.../photo/...). Do NOT fabricate.`,
    "  · NEVER fabricate URL / status id / media_url / date.",
    "  · Output is JSON ONLY. No markdown, no explanation, no code fence.",
    "",
    "Example (replace with real data):",
    `[{"user":"${cleanHandle}","name":"...","text":"...","url":"https://x.com/${cleanHandle}/status/123","date":"${today}","media_url":"https://pbs.twimg.com/media/abc.jpg"}]`,
  ].join("\n");
}

function callGrok(prompt, timeoutSecs) {
  const result = spawnSync(
    "grok",
    ["-p", prompt, "--output-format", "json", "--always-approve"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutSecs * 1000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  if (result.error) {
    return { ok: false, reason: `spawn: ${result.error.message}` };
  }
  if (result.signal === "SIGTERM" || result.signal === "SIGKILL") {
    return { ok: false, reason: `timeout after ${timeoutSecs}s` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `grok exit ${result.status}` };
  }
  return { ok: true, stdout: result.stdout };
}

function parseEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    return { ok: false, reason: `envelope JSON.parse: ${e.message}` };
  }
  if (envelope == null || typeof envelope !== "object") {
    return { ok: false, reason: "envelope not an object" };
  }
  if (envelope.stopReason && envelope.stopReason !== "EndTurn") {
    return { ok: false, reason: `non-EndTurn stopReason: ${envelope.stopReason}` };
  }
  if (typeof envelope.text !== "string") {
    return { ok: false, reason: "envelope.text missing or non-string" };
  }
  let inner = envelope.text.trim();
  if (inner.startsWith("```")) {
    inner = inner.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  const firstBracket = inner.indexOf("[");
  const lastBracket = inner.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    return { ok: false, reason: "no JSON array bracket in envelope.text" };
  }
  inner = inner.slice(firstBracket, lastBracket + 1);
  let raw;
  try {
    raw = JSON.parse(inner);
  } catch (e) {
    return { ok: false, reason: `inner JSON.parse: ${e.message}` };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "inner payload is not an array" };
  }
  return { ok: true, raw };
}

const URL_RE = /^https:\/\/x\.com\/([^/]+)\/status\/(\d+)/;
const MEDIA_HOST_RE = /^https:\/\/(pbs\.twimg\.com|video\.twimg\.com|ton\.twitter\.com)\//;

function verifyMediaUrl(mediaUrl, timeoutSecs = 8) {
  if (!mediaUrl) return { ok: false, reason: "empty" };
  if (!MEDIA_HOST_RE.test(mediaUrl)) {
    return { ok: false, reason: `non-twitter media host: ${mediaUrl.slice(0, 60)}` };
  }
  const result = spawnSync(
    "curl",
    [
      "-I", "-L", "--max-redirs", "3",
      "-m", String(timeoutSecs),
      "-s", "-o", "/dev/null",
      "-w", "%{http_code}\t%{content_type}",
      "-A", "Mozilla/5.0 (compatible; ai-insight-fetcher/1.0)",
      mediaUrl,
    ],
    { encoding: "utf8", timeout: (timeoutSecs + 2) * 1000 },
  );
  if (result.error || result.status !== 0) {
    return { ok: false, reason: `curl err: ${result.error?.message || `exit ${result.status}`}` };
  }
  const [code, ctype = ""] = (result.stdout || "").split("\t");
  if (code !== "200") return { ok: false, reason: `http ${code}` };
  if (!ctype.startsWith("image/") && !ctype.startsWith("video/")) {
    return { ok: false, reason: `non-media content-type: ${ctype}` };
  }
  return { ok: true, contentType: ctype };
}

function normalize(raw, handle, cutoffISO, todayISO, mediaLog) {
  const cleanHandle = handle.replace(/^@/, "");
  const out = [];
  const drops = { badUrl: 0, wrongUser: 0, emptyText: 0, badDate: 0, outOfWindow: 0, mediaVerifyFail: 0 };
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const url = typeof t.url === "string" ? t.url.trim() : "";
    const m = url.match(URL_RE);
    if (!m) { drops.badUrl++; continue; }
    const user = m[1];
    const tweetId = m[2];
    if (user.toLowerCase() !== cleanHandle.toLowerCase()) { drops.wrongUser++; continue; }
    const text = typeof t.text === "string" ? t.text.trim() : "";
    if (!text) { drops.emptyText++; continue; }
    const dateRaw = typeof t.date === "string" ? t.date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) { drops.badDate++; continue; }
    if (dateRaw < cutoffISO || dateRaw > todayISO) { drops.outOfWindow++; continue; }
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : cleanHandle;
    let imageUrl = "";
    const mediaRaw = typeof t.media_url === "string" ? t.media_url.trim() : "";
    if (mediaRaw) {
      const v = verifyMediaUrl(mediaRaw);
      if (mediaLog) {
        mediaLog.push({
          tweetId,
          handle: cleanHandle,
          url: mediaRaw,
          ok: v.ok,
          contentType: v.contentType || "",
          reason: v.reason || "",
        });
      }
      if (v.ok) imageUrl = mediaRaw;
      else drops.mediaVerifyFail++;
    }
    out.push({
      account: `@${user}`,
      name,
      user,
      tweetId,
      text,
      date: dateRaw,
      likes: 0,
      views: 0,
      url,
      source: `@${user}`,
      category: "行业",
      imageUrl,
    });
  }
  return { tweets: out, drops };
}

function dedupe(tweets) {
  const seen = new Set();
  const out = [];
  for (const t of tweets) {
    const key = t.tweetId || t.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function summarize(tweets, cutoffISO, todayISO) {
  if (tweets.length === 0) return { line: "no tweets", byDate: {}, freshestAgeDays: null };
  const byDate = {};
  for (const t of tweets) byDate[t.date] = (byDate[t.date] || 0) + 1;
  const dates = Object.keys(byDate).sort();
  const freshest = dates[dates.length - 1];
  const oldest = dates[0];
  const withMedia = tweets.filter((t) => t.imageUrl).length;
  const today = new Date(todayISO + "T00:00:00Z");
  const f = new Date(freshest + "T00:00:00Z");
  const ageDays = Math.round((today.getTime() - f.getTime()) / 86400000);
  return {
    line: `freshest=${freshest} (${ageDays}d ago) | oldest=${oldest} | window=[${cutoffISO}, ${todayISO}] | media-verified=${withMedia}/${tweets.length}`,
    byDate,
    freshestAgeDays: ageDays,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  preflight();

  const todayISO = new Date().toISOString().slice(0, 10);
  const { cutoffISO } = computeCutoff(opts.since);

  const log = (msg) => {
    if (opts.verbose) process.stderr.write(`[fetch-grok] ${msg}\n`);
  };
  log(`accounts=${opts.accounts.length} since=${opts.since} max-per=${opts.maxPer} window=[${cutoffISO}, ${todayISO}]`);

  const failures = [];
  const allTweets = [];
  const mediaLog = [];
  const totalDrops = { badUrl: 0, wrongUser: 0, emptyText: 0, badDate: 0, outOfWindow: 0, mediaVerifyFail: 0 };

  for (const handle of opts.accounts) {
    log(`→ ${handle}`);
    const prompt = buildPrompt(handle, opts.since, opts.maxPer);
    const call = callGrok(prompt, opts.timeout);
    if (!call.ok) {
      failures.push({ handle, reason: call.reason });
      log(`  ✗ ${call.reason}`);
      continue;
    }
    const parsed = parseEnvelope(call.stdout);
    if (!parsed.ok) {
      failures.push({ handle, reason: parsed.reason });
      log(`  ✗ ${parsed.reason}`);
      continue;
    }
    const { tweets, drops } = normalize(parsed.raw, handle, cutoffISO, todayISO, mediaLog);
    for (const k of Object.keys(totalDrops)) totalDrops[k] += drops[k];
    const dropTags = Object.entries(drops).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(",");
    log(`  ✓ ${tweets.length} tweet(s) kept${dropTags ? ` [drops: ${dropTags}]` : ""}`);
    allTweets.push(...tweets);
  }

  const tweets = dedupe(allTweets);
  const payload = { nextId: opts.startId + tweets.length, tweets };
  const json = JSON.stringify(payload, null, 2);

  if (opts.out === "-") {
    process.stdout.write(json + "\n");
  } else {
    fs.writeFileSync(opts.out, json + "\n", "utf8");
    log(`wrote ${tweets.length} tweet(s) to ${opts.out}`);
  }

  // freshness self-check — surfaces "grok index lag" early
  const summary = summarize(tweets, cutoffISO, todayISO);
  process.stderr.write(`[fetch-grok] summary: ${summary.line}\n`);
  if (Object.keys(summary.byDate).length > 0) {
    const dateLines = Object.entries(summary.byDate)
      .sort()
      .map(([d, n]) => `  ${d}: ${n}`)
      .join("\n");
    process.stderr.write(`[fetch-grok] date distribution:\n${dateLines}\n`);
  }
  const droppedTags = Object.entries(totalDrops).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
  if (droppedTags) {
    process.stderr.write(`[fetch-grok] total drops: ${droppedTags}\n`);
  }
  if (mediaLog.length > 0) {
    const kept = mediaLog.filter((m) => m.ok).length;
    process.stderr.write(`[fetch-grok] media verify: ${kept}/${mediaLog.length} passed (HTTP 200 + image/video content-type)\n`);
    if (opts.verbose) {
      for (const m of mediaLog) {
        const tag = m.ok ? `✓ ${m.contentType}` : `✗ ${m.reason}`;
        process.stderr.write(`  [@${m.handle} ${m.tweetId}] ${tag}\n    ${m.url}\n`);
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `[fetch-grok] ${failures.length}/${opts.accounts.length} accounts failed:\n`,
    );
    for (const f of failures) {
      process.stderr.write(`  - ${f.handle}: ${f.reason}\n`);
    }
  }

  if (tweets.length === 0) {
    process.stderr.write(
      `[fetch-grok] zero tweets aggregated — exit 1 (downstream should skip write)\n`,
    );
    process.exit(1);
  }
  // Freshness warning (non-fatal): A站 needs last-24h ideally, surface if grok index lagged
  if (summary.freshestAgeDays != null && summary.freshestAgeDays > 2) {
    process.stderr.write(
      `[fetch-grok] WARN: freshest tweet is ${summary.freshestAgeDays} days old — grok web index may be lagging behind real-time X\n`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[fetch-grok] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
