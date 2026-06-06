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

function buildPrompt(handle, since, maxPer) {
  const cleanHandle = handle.replace(/^@/, "");
  let windowDesc;
  if (/^\d+h$/i.test(since)) {
    const hours = Number.parseInt(since, 10);
    windowDesc = `最近 ${hours} 小时`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    windowDesc = `自 ${since} 起 (since:${since})`;
  } else {
    windowDesc = since;
  }
  return [
    `找一下 X (Twitter) 上 @${cleanHandle} ${windowDesc}内的帖子, 最多 ${maxPer} 条。`,
    "",
    "**步骤**:",
    `1. 先用 web_search (allowed_domains=["x.com"]) 找 @${cleanHandle} 的最新原创帖子 (不含 retweet)`,
    "2. 必要时用 web_fetch 拿正文",
    "3. 最后只输出一个**严格 JSON 数组**, 不要 markdown, 不要解释, 不要 code fence",
    "",
    "数组每条字段:",
    `  user      ${cleanHandle}    (handle 不带 @)`,
    `  name      显示名 (例: Sam Altman)`,
    `  text      原文或忠实的中文摘要 (~80 字内)`,
    `  url       完整的 https://x.com/${cleanHandle}/status/<id> URL (必须是真链接)`,
    `  date      YYYY-MM-DD (拿不到精确日子用大致月份: YYYY-MM)`,
    "",
    "硬要求:",
    `  · url 字段必须以 "https://x.com/${cleanHandle}/status/" 开头,后接纯数字 status id`,
    "  · 如果搜索不到任何符合时间窗的帖子,返回空数组 []",
    "  · 绝对禁止编造 URL 或 status id",
    "  · 绝对禁止返回 markdown / 解释文字 / code fence",
    "",
    "示例 (替换为真实数据):",
    `[{"user":"${cleanHandle}","name":"...","text":"...","url":"https://x.com/${cleanHandle}/status/123","date":"2026-06-01"}]`,
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

function normalize(raw, handle) {
  const cleanHandle = handle.replace(/^@/, "");
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const url = typeof t.url === "string" ? t.url.trim() : "";
    const m = url.match(URL_RE);
    if (!m) continue;
    const user = m[1];
    const tweetId = m[2];
    if (user.toLowerCase() !== cleanHandle.toLowerCase()) continue;
    const text = typeof t.text === "string" ? t.text.trim() : "";
    if (!text) continue;
    const dateRaw = typeof t.date === "string" ? t.date.trim() : "";
    let date = "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) date = dateRaw;
    else if (/^\d{4}-\d{2}$/.test(dateRaw)) date = `${dateRaw}-01`;
    else date = new Date().toISOString().slice(0, 10);
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : cleanHandle;
    out.push({
      account: `@${user}`,
      name,
      user,
      tweetId,
      text,
      date,
      likes: 0,
      views: 0,
      url,
      source: `@${user}`,
      category: "行业",
      imageUrl: "",
    });
  }
  return out;
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

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  preflight();

  const log = (msg) => {
    if (opts.verbose) process.stderr.write(`[fetch-grok] ${msg}\n`);
  };
  log(`accounts=${opts.accounts.length} since=${opts.since} max-per=${opts.maxPer}`);

  const failures = [];
  const allTweets = [];

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
    const tweets = normalize(parsed.raw, handle);
    log(`  ✓ ${tweets.length} tweet(s)`);
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
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[fetch-grok] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
