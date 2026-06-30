/**
 * RFC-020 §16 — feishu outbound render mode tests.
 *
 * Vincent 2026-06-30: "你别发我图片啊，发我文字，issue 发文字" — the bot
 * was rendering markdown-heavy replies (issues, code, structured content)
 * to PNG via #329 and the user lost copy/paste. This PR adds per-channel
 * `outboundRender: "plain" | "card" | "auto"` with **default "plain"**.
 *
 * Matrix covered:
 *   3 modes × {heading, table, long, short-markdown, plain-text} +
 *   attachment-priority + caption-mode (forceTextOnly) + text chunking
 *   + config loading defaults.
 *
 * Run: `bun tests/feishu-outbound-render-mode.test.ts`
 */

import {
  FEISHU_TEXT_SINGLE_LIMIT,
  splitTextForFeishu,
  looksLikeMarkdown,
} from "../src/im/feishu/adapter";
import { resolveOutboundRoute } from "../src/im/feishu/outbound-route";
import { shouldRenderAsImage } from "../src/im/feishu/markdown-image-renderer";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// RFC-020 §16.1 test-teeth hardening: bind the REAL `resolveOutboundRoute`
// helper (extracted from adapter.ts). The pre-extraction version of this
// test had a sibling `pickRoute` copy that would silently drift if the
// production decision tree changed — bind to the real one so changes
// trip a red test.
//
// `pickRoute` is now a thin adapter that maps the real helper's route
// enum to the legacy `msgType` shape the test assertions key on.
type Decision =
  | { msgType: "text"; reason: string }
  | { msgType: "interactive"; reason: string }
  | { msgType: "image"; reason: string }
  | { msgType: "file"; reason: string };

function pickRoute(opts: {
  text?: string;
  imagePath?: string;
  files?: { name: string; path: string }[];
  forceTextOnly?: boolean;
  mode: "plain" | "card" | "auto";
}): Decision {
  const d = resolveOutboundRoute({
    text: opts.text,
    imagePath: opts.imagePath,
    files: opts.files,
    forceTextOnly: opts.forceTextOnly,
    mode: opts.mode,
  });
  // Map the route enum to the msgType the existing assertions use.
  // image_upload → "image", file_upload → "file", text → "text",
  // card_short_md → "interactive", image_render → "image" (PNG path
  // still produces msg_type:image at the API level).
  switch (d.route) {
    case "image_upload":
    case "image_render":
      return { msgType: "image", reason: d.reason };
    case "file_upload":
      return { msgType: "file", reason: d.reason };
    case "card_short_md":
      return { msgType: "interactive", reason: d.reason };
    case "text":
      return { msgType: "text", reason: d.reason };
  }
}

// ── 1. Default mode is "plain" — Vincent's UAT case ────────────────────────

{
  const VINCENT_ISSUE = "# Issue: title here\n\n- bullet 1\n- bullet 2\n\nDescription paragraph.";
  // shouldRenderAsImage would fire on the heading → PNG under "auto"
  const auto = pickRoute({ text: VINCENT_ISSUE, mode: "auto" });
  expect("auto: issue with heading → PNG (legacy fidelity preserved)", auto.msgType === "image", auto.reason);

  const plain = pickRoute({ text: VINCENT_ISSUE, mode: "plain" });
  expect("plain: same issue → msg_type:text (copyable)", plain.msgType === "text", plain.reason);

  const card = pickRoute({ text: VINCENT_ISSUE, mode: "card" });
  expect("card: heading → plain text (not PNG, not card — fidelity-lossy but no image)", card.msgType === "text", card.reason);
}

// ── 2. Table — under each mode ────────────────────────────────────────────

{
  const TABLE = "Hi:\n\n| col1 | col2 |\n|------|------|\n| a    | b    |\n| c    | d    |";
  expect("table → shouldRenderAsImage (sanity)", shouldRenderAsImage(TABLE) === true);

  const auto = pickRoute({ text: TABLE, mode: "auto" });
  expect("auto + table → PNG", auto.msgType === "image", auto.reason);

  const plain = pickRoute({ text: TABLE, mode: "plain" });
  expect("plain + table → text (ugly but copyable)", plain.msgType === "text", plain.reason);

  const card = pickRoute({ text: TABLE, mode: "card" });
  expect("card + table → plain text (card markdown elem can't render tables)", card.msgType === "text", card.reason);
}

// ── 3. Long content (>2000 chars) ──────────────────────────────────────────

{
  const LONG = "Some prefix.\n\n" + "x".repeat(2500);
  const auto = pickRoute({ text: LONG, mode: "auto" });
  expect("auto + long → PNG", auto.msgType === "image", auto.reason);

  const plain = pickRoute({ text: LONG, mode: "plain" });
  expect("plain + long → text (will chunk; not PNG)", plain.msgType === "text", plain.reason);

  const card = pickRoute({ text: LONG, mode: "card" });
  expect("card + long → text (fidelity loss, no PNG)", card.msgType === "text", card.reason);
}

// ── 4. Short markdown (bold + bullets, no heading/table/long) ─────────────

{
  const SHORT_MD = "Reply: **bold** with `inline code` and:\n- list a\n- list b";
  // No heading, no table, < 2000 chars → shouldRenderAsImage=false; markdown=true
  expect("short md → !shouldRenderAsImage", shouldRenderAsImage(SHORT_MD) === false);
  expect("short md → looksLikeMarkdown", looksLikeMarkdown(SHORT_MD) === true);

  const auto = pickRoute({ text: SHORT_MD, mode: "auto" });
  expect("auto + short markdown → schema 1.0 card", auto.msgType === "interactive", auto.reason);

  const card = pickRoute({ text: SHORT_MD, mode: "card" });
  expect("card + short markdown → schema 1.0 card", card.msgType === "interactive", card.reason);

  const plain = pickRoute({ text: SHORT_MD, mode: "plain" });
  expect("plain + short markdown → msg_type:text (no card styling)", plain.msgType === "text", plain.reason);
}

// ── 5. Plain text ─────────────────────────────────────────────────────────

{
  const PLAIN_TEXT = "hello, no markdown here.";
  expect("plain text → !shouldRenderAsImage", shouldRenderAsImage(PLAIN_TEXT) === false);
  expect("plain text → !looksLikeMarkdown", looksLikeMarkdown(PLAIN_TEXT) === false);

  for (const mode of ["plain", "card", "auto"] as const) {
    const d = pickRoute({ text: PLAIN_TEXT, mode });
    expect(`${mode} + plain text → msg_type:text`, d.msgType === "text", d.reason);
  }
}

// ── 6. Attachment priority (always wins) ──────────────────────────────────

{
  for (const mode of ["plain", "card", "auto"] as const) {
    const d1 = pickRoute({ imagePath: "/work/x/y.png", text: "# heading", mode });
    expect(`${mode} + imagePath → image upload (heading text ignored)`, d1.msgType === "image", d1.reason);

    const d2 = pickRoute({ files: [{ name: "x.pdf", path: "/work/x/y.pdf" }], text: "# heading", mode });
    expect(`${mode} + files → file upload (heading text ignored)`, d2.msgType === "file", d2.reason);
  }
}

// ── 7. Caption mode (forceTextOnly) ───────────────────────────────────────

{
  // forceTextOnly should win over mode for the text leg
  const HEADING = "# Caption\n\nHere's your file";
  for (const mode of ["plain", "card", "auto"] as const) {
    const d = pickRoute({ text: HEADING, forceTextOnly: true, mode });
    expect(`${mode} + forceTextOnly → text (caption mode bypass)`, d.msgType === "text", d.reason);
  }
}

// ── 8. splitTextForFeishu ─────────────────────────────────────────────────

expect("short text: single chunk", splitTextForFeishu("hello world", 100).length === 1);
expect("short text: identity", splitTextForFeishu("hello world", 100)[0] === "hello world");
expect("exactly limit: single chunk", splitTextForFeishu("x".repeat(100), 100).length === 1);
expect("just over limit: 2 chunks at word boundary", splitTextForFeishu("a".repeat(50) + " " + "b".repeat(60), 100).length === 2);

// Paragraph boundary split
{
  const text = "Paragraph 1\n\n" + "p".repeat(80) + "\n\nParagraph 2\n\n" + "q".repeat(80);
  const chunks = splitTextForFeishu(text, 100);
  expect("paragraph boundary split: 2+ chunks", chunks.length >= 2, `chunks: ${chunks.length}`);
  // Each chunk should NOT exceed maxChars (modulo small overrun for line boundaries)
  for (const c of chunks) {
    expect(`chunk fits: ${c.slice(0, 20)}... (${c.length} chars)`, c.length <= 100);
  }
}

// Line boundary fallback
{
  const text = "line 1\n" + "p".repeat(80) + "\nline 3\n" + "q".repeat(80);
  const chunks = splitTextForFeishu(text, 100);
  expect("line boundary split", chunks.length >= 2);
}

// Word boundary fallback
{
  const text = "word ".repeat(40); // no newlines, 200 chars total
  const chunks = splitTextForFeishu(text, 100);
  expect("word boundary split", chunks.length >= 2);
}

// Hard split fallback (no whitespace anywhere)
{
  const text = "x".repeat(250);
  const chunks = splitTextForFeishu(text, 100);
  expect("hard split (no whitespace)", chunks.length >= 3);
  expect("hard split: all chunks ≤ maxChars", chunks.every((c) => c.length <= 100));
}

// Roundtrip — sum of chunk lengths should approximate the input (minus
// consumed boundary whitespace).
{
  const text = "para 1\n\npara 2\n\npara 3 with " + "x".repeat(100);
  const chunks = splitTextForFeishu(text, 50);
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  expect(
    "roundtrip char count approximates input",
    total >= text.length - chunks.length * 4 && total <= text.length,
    `text=${text.length} total=${total} chunks=${chunks.length}`,
  );
}

// ── 9. FEISHU_TEXT_SINGLE_LIMIT shape ─────────────────────────────────────

expect("limit is positive integer", Number.isInteger(FEISHU_TEXT_SINGLE_LIMIT) && FEISHU_TEXT_SINGLE_LIMIT > 0);
expect("limit is conservative (well under Feishu's ~30 KB ceiling)", FEISHU_TEXT_SINGLE_LIMIT <= 10000);
expect("limit is large enough to be useful (>= 1KB)", FEISHU_TEXT_SINGLE_LIMIT >= 1000);

// ── 10. Mode contract — "auto" preserves pre-2026-06-30 behavior byte-identical ──

{
  // The CORE invariant: under `auto`, every text input must route to the
  // SAME msgType the pre-mode-switch code did. Probe the 5 key shapes.
  const PROBES: Array<[string, "text" | "interactive" | "image", string]> = [
    ["plain hello", "text", "no markup → text"],
    ["**bold** only", "interactive", "short md → card"],
    ["# heading\n\nbody", "image", "heading → PNG"],
    ["| a | b |\n|---|---|\n| x | y |", "image", "table → PNG"],
    ["x".repeat(2500), "image", "long → PNG"],
  ];
  for (const [text, want, why] of PROBES) {
    const d = pickRoute({ text, mode: "auto" });
    expect(`auto-byte-identical: ${why}`, d.msgType === want, `got ${d.msgType}, want ${want}, reason=${d.reason}`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-outbound-render-mode tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
