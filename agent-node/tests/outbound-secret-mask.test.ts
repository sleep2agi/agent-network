/**
 * RFC-020 §19 — outbound secret-mask tests.
 *
 * Real motivating case (Vincent 2026-07-01):
 *   - User pasted `github_pat_XXX...` into Feishu chat
 *   - Feishu quoted it in the reply → PAT entered session
 *   - MiniMax content-filter fired → out>0 but result="" → user got
 *     `执行出错: claude-agent-sdk 返回空响应` on every subsequent turn
 *   - Direct probe #8 confirmed M3 also EAGERLY put PAT into
 *     `tool_use.input.cmd` to try `gh api ... "Authorization: token
 *     github_pat_..."`
 *
 * The right fix is outbound edge — mask before bytes leave our process.
 * This test suite locks pattern coverage, hit reporting, message-shape
 * traversal, and defensive input handling.
 *
 * Run: `bun tests/outbound-secret-mask.test.ts`
 */

import {
  maskSecretsInText,
  maskSecretsInMessage,
  maskSecretsInMessages,
  maskSecretsInContentBlock,
  summarizeHits,
  OUTBOUND_SECRET_PATTERNS,
} from "../src/outbound-secret-mask";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Pattern coverage — real-shape fake fixtures ─────────────────────────
// FIXTURES USE OBVIOUSLY-FAKE PATTERNS per team rule. `X` padding matches
// the regex length gate but can never be a live credential; Slack uses
// array.join to avoid GitHub Secret Scanning on the source file.

const FAKE_GHP = "ghp_" + "X".repeat(36);
const FAKE_GITHUB_PAT = "github_pat_" + "X".repeat(24);
const FAKE_NTOK = "ntok_" + "X".repeat(24);
const FAKE_UTOK = "utok_" + "X".repeat(24);
const FAKE_ATOK = "atok_" + "X".repeat(24);
const FAKE_SLACK_BOT = ["xoxb", "0".repeat(20), "X".repeat(24)].join("-");
const FAKE_SLACK_USER = ["xoxp", "0".repeat(20), "X".repeat(24)].join("-");
const FAKE_SK = "sk-" + "X".repeat(40);
const FAKE_SK_ANT = "sk-ant-" + "X".repeat(40);

for (const [label, secret] of [
  ["ghp_ classic PAT", FAKE_GHP],
  ["github_pat_ fine-grained", FAKE_GITHUB_PAT],
  ["ntok_ anet network token", FAKE_NTOK],
  ["utok_ anet user token", FAKE_UTOK],
  ["atok_ anet admin token", FAKE_ATOK],
  ["xoxb- Slack bot", FAKE_SLACK_BOT],
  ["xoxp- Slack user", FAKE_SLACK_USER],
  ["sk- OpenAI-style", FAKE_SK],
  ["sk-ant- Anthropic-style", FAKE_SK_ANT],
] as const) {
  const r = maskSecretsInText(secret);
  expect(`isolated ${label} masked`, r.masked.startsWith("[REDACTED_"), r.masked);
  expect(`isolated ${label} 1 hit`, r.hits.length === 1);
  expect(`isolated ${label} placeholder shape`, /^\[REDACTED_[A-Z_]+\]$/.test(r.masked), r.masked);
}

// ── 2. Inline PAT in prose (Vincent's real case) ──────────────────────────

{
  const prose = `帮我看下 github token 是不是有效的：${FAKE_GHP} 谢谢`;
  const r = maskSecretsInText(prose);
  expect("inline PAT: text preserved around", r.masked.startsWith("帮我看下") && r.masked.endsWith("谢谢"));
  expect("inline PAT: 1 hit", r.hits.length === 1);
  expect("inline PAT: placeholder replaces token", r.masked.includes("[REDACTED_GHP]"));
  expect("inline PAT: no literal token bytes left", !r.masked.includes(FAKE_GHP));
}

// ── 3. Multiple secrets in one text — different kinds ─────────────────────

{
  const multi = `token=${FAKE_GHP}, slack=${FAKE_SLACK_BOT}, api=${FAKE_SK}`;
  const r = maskSecretsInText(multi);
  expect("multi: 3 hits", r.hits.length === 3, `got: ${JSON.stringify(r.hits)}`);
  const kinds = new Set(r.hits.map((h) => h.kind));
  expect("multi: kinds diverse", kinds.has("ghp") && kinds.has("slack_token") && kinds.has("sk_key"));
  expect("multi: all replaced", !r.masked.includes(FAKE_GHP) && !r.masked.includes(FAKE_SLACK_BOT) && !r.masked.includes(FAKE_SK));
}

// ── 4. Same-kind repeats (Vincent's real: PAT quoted N times in history) ──

{
  const repeated = [FAKE_GHP, "some text", FAKE_GHP, "more text", FAKE_GHP].join(" ");
  const r = maskSecretsInText(repeated);
  expect("repeated: 3 hits", r.hits.length === 3);
  expect("repeated: no literal bytes", !r.masked.includes(FAKE_GHP));
  expect("repeated: prose preserved", r.masked.includes("some text") && r.masked.includes("more text"));
}

// ── 5. Non-secret text passes through untouched ───────────────────────────

const NON_SECRETS = [
  "hello, world",
  "帮我看下 github/anthropic 文档在哪里",
  "curl https://api.example.com/foo",
  "sk-example", // too short (fails length gate)
  "ghp_short", // too short
  "github_pat_",
  "just random text no patterns here 12345",
  "ntok_", // no bytes after prefix
];
for (const text of NON_SECRETS) {
  const r = maskSecretsInText(text);
  expect(`non-secret passes through: ${text.slice(0, 40)}`, r.hits.length === 0 && r.masked === text, `got: ${JSON.stringify(r)}`);
}

// ── 6. Length gates — sub-threshold ────────────────────────────────────────

// GitHub classic must be exactly 36 chars after ghp_ (not 34, not 40).
expect(
  "ghp_ 34-char body: NOT match (need 36)",
  maskSecretsInText("ghp_" + "X".repeat(34)).hits.length === 0,
);
// Fine-grained must be ≥ 20 chars.
expect(
  "github_pat_ 19-char body: NOT match",
  maskSecretsInText("github_pat_" + "X".repeat(19)).hits.length === 0,
);
expect(
  "github_pat_ 20-char body: match",
  maskSecretsInText("github_pat_" + "X".repeat(20)).hits.length === 1,
);
// sk- gates at 32.
expect(
  "sk- 31-char body: NOT match",
  maskSecretsInText("sk-" + "X".repeat(31)).hits.length === 0,
);

// ── 7. Word boundary — no false-positive on embedded substrings ────────────

// Longer word containing "ghp_XXX...36" bytes shouldn't false-fire because
// of the \b anchor at start.
{
  const embedded = "prefix" + FAKE_GHP; // no leading \b before ghp_
  const r = maskSecretsInText(embedded);
  expect(
    "no leading word boundary: NOT match (avoid false-positive)",
    r.hits.length === 0,
    r.masked,
  );
}

// ── 8. Defensive input — null / undefined / non-string ────────────────────

expect("null input: pass through", maskSecretsInText(null as any).hits.length === 0);
expect("undefined input: pass through", maskSecretsInText(undefined as any).hits.length === 0);
expect("number input: no crash, empty hits", maskSecretsInText(42 as any).hits.length === 0);
expect("empty string: empty result", maskSecretsInText("").masked === "" && maskSecretsInText("").hits.length === 0);

// ── 9. maskSecretsInContentBlock — text block ─────────────────────────────

{
  const block = { type: "text", text: `请审计 token ${FAKE_GHP}` };
  const r = maskSecretsInContentBlock(block);
  expect("content-block text: 1 hit", r.hits.length === 1);
  expect("content-block text: masked", (r.masked.text as string).includes("[REDACTED_GHP]"));
  expect("content-block text: no leak", !(r.masked.text as string).includes(FAKE_GHP));
}

// ── 10. maskSecretsInContentBlock — tool_use.input (case 8 exact repro) ──

// This is Vincent's case-8 empirical: M3 wanted to shell out `gh api` with
// the PAT baked into the tool input. The mask MUST reach into nested JSON.
{
  const block = {
    type: "tool_use",
    id: "call_case8",
    name: "bash",
    input: {
      cmd: `gh api repos/anthropic/claude-code/pulls?per_page=3 --header "Authorization: token ${FAKE_GHP}"`,
    },
  };
  const r = maskSecretsInContentBlock(block);
  expect("case-8 tool_use.input.cmd: 1 hit", r.hits.length === 1);
  expect(
    "case-8: literal PAT stripped from tool_use.input.cmd",
    !((r.masked.input as any).cmd as string).includes(FAKE_GHP),
    JSON.stringify(r.masked.input),
  );
  expect(
    "case-8: placeholder in cmd",
    ((r.masked.input as any).cmd as string).includes("[REDACTED_GHP]"),
  );
}

// ── 11. maskSecretsInMessage — string-content shorthand ───────────────────

{
  const msg = { role: "user", content: `我的 token 是 ${FAKE_GHP}` };
  const r = maskSecretsInMessage(msg);
  expect("string-content: 1 hit", r.hits.length === 1);
  expect("string-content: masked", (r.masked.content as string).includes("[REDACTED_GHP]"));
  expect("string-content: role preserved", r.masked.role === "user");
}

// ── 12. maskSecretsInMessage — array-content with mixed blocks ────────────

{
  const msg = {
    role: "assistant" as const,
    content: [
      { type: "text", text: `use ${FAKE_GHP}` },
      { type: "tool_use", id: "x", name: "y", input: { arg: FAKE_SK } },
      { type: "text", text: "no secret here" },
    ],
  };
  const r = maskSecretsInMessage(msg);
  expect("array-content: 2 hits", r.hits.length === 2);
  const blocks = r.masked.content as any[];
  expect(
    "array-content: text[0] masked",
    (blocks[0].text as string).includes("[REDACTED_GHP]"),
  );
  expect(
    "array-content: tool_use.input.arg masked",
    (blocks[1].input.arg as string).includes("[REDACTED_SK_KEY]"),
  );
  expect("array-content: text[2] untouched", blocks[2].text === "no secret here");
}

// ── 13. maskSecretsInMessages — arrays ─────────────────────────────────────

{
  const messages = [
    { role: "user", content: `first ${FAKE_GHP}` },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: `second ${FAKE_NTOK}` },
  ];
  const r = maskSecretsInMessages(messages);
  expect("messages: 2 hits total", r.hits.length === 2);
  expect(
    "messages: kinds ghp + ntok",
    new Set(r.hits.map((h) => h.kind)).size === 2,
  );
  const kinds = r.hits.map((h) => h.kind).sort();
  expect("messages: correct kind labels", JSON.stringify(kinds) === JSON.stringify(["ghp", "ntok"]));
}

// ── 14. Deeply nested tool_result.content string ──────────────────────────

{
  const block = {
    type: "tool_result",
    tool_use_id: "x",
    content: `command output: token = ${FAKE_UTOK}`,
  };
  const r = maskSecretsInContentBlock(block);
  expect("tool_result.content: 1 hit", r.hits.length === 1);
  expect(
    "tool_result.content: masked",
    (r.masked.content as string).includes("[REDACTED_UTOK]"),
  );
}

// ── 15. tool_result.content as nested array of blocks ─────────────────────

{
  const block = {
    type: "tool_result",
    tool_use_id: "x",
    content: [
      { type: "text", text: `output line 1` },
      { type: "text", text: `token = ${FAKE_GHP}` },
    ],
  };
  const r = maskSecretsInContentBlock(block);
  expect("tool_result nested: 1 hit", r.hits.length === 1);
  const inner = (r.masked.content as any[])[1].text as string;
  expect("tool_result nested: masked in inner text", inner.includes("[REDACTED_GHP]"));
}

// ── 16. summarizeHits — observability shape ────────────────────────────────

expect("summarize empty: 'none'", summarizeHits([]) === "none");
{
  const hits = [
    { kind: "ghp", length: 40 },
    { kind: "ghp", length: 40 },
    { kind: "slack_token", length: 45 },
  ];
  const s = summarizeHits(hits);
  expect("summarize: counts by kind", s.includes("ghp=2") && s.includes("slack_token=1"), s);
  expect("summarize: total chars", s.includes("125 chars"), s);
}

// ── 17. Idempotence — masking twice is a no-op after the first ────────────

{
  const text = `token ${FAKE_GHP} here`;
  const r1 = maskSecretsInText(text);
  const r2 = maskSecretsInText(r1.masked);
  expect("idempotence: second pass finds nothing", r2.hits.length === 0);
  expect("idempotence: text unchanged after second pass", r2.masked === r1.masked);
}

// ── 18. Placeholder is greppable + never overlaps real credentials ────────

{
  const placeholder = "[REDACTED_GHP]";
  const r = maskSecretsInText(placeholder);
  expect(
    "placeholder itself is not a credential match (no accidental cascade)",
    r.hits.length === 0,
    r.masked,
  );
}

// ── 19. Vincent-shaped real scenario — Feishu quote block ─────────────────

{
  // Feishu quote-reply syntax: >> quoted line — bot receives event with
  // the ORIGINAL user message text embedded, PAT included.
  const feishuEvent = `>> 用户 2026-07-01 12:00:00\n>> 请帮我用这个 token ${FAKE_GHP} 拉 pr\n\n继续帮我查一下`;
  const r = maskSecretsInText(feishuEvent);
  expect("feishu quote: 1 hit", r.hits.length === 1);
  expect("feishu quote: PAT stripped", !r.masked.includes(FAKE_GHP));
  expect("feishu quote: quote syntax preserved", r.masked.includes(">> 用户"));
  expect("feishu quote: user's follow-up prose kept", r.masked.includes("继续帮我查一下"));
}

// ── 20. OUTBOUND_SECRET_PATTERNS shape lock ───────────────────────────────

expect("patterns list non-empty", OUTBOUND_SECRET_PATTERNS.length >= 5);
expect(
  "every pattern has kind + regex + global flag",
  OUTBOUND_SECRET_PATTERNS.every((p) => typeof p.kind === "string" && p.regex.global),
);

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} outbound-secret-mask tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
