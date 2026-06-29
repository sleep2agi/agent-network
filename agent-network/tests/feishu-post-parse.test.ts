/**
 * RFC-020 §3 — Feishu post (rich-text 图文混排) message parsing.
 *
 * Vincent UAT 2026-06-29: sending image+text in a single Feishu message
 * arrives as `message_type:"post"`. Adapter previously dropped these
 * silently via the `return null` fallthrough. This test locks the new
 * `post` branch + image_key extraction.
 *
 * Run: `bun tests/feishu-post-parse.test.ts`
 */

import {
  parsePostContent,
  extractPostImageKeys,
} from "../src/im/feishu/adapter";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Plain text-only post (no images) ────────────────────────────────────

const p1 = JSON.stringify({
  title: "标题",
  content: [
    [{ tag: "text", text: "你好，" }, { tag: "text", text: "世界" }],
    [{ tag: "text", text: "第二段" }],
  ],
});

expect(
  "text-only post: title + 2 paragraphs",
  parsePostContent(p1) === "标题\n\n你好，世界\n\n第二段",
  `got: ${parsePostContent(p1)}`,
);
expect("text-only post: no image_keys", extractPostImageKeys(p1).length === 0);

// ── 2. Single image with surrounding text ──────────────────────────────────

const p2 = JSON.stringify({
  content: [
    [
      { tag: "text", text: "看这张图: " },
      { tag: "img", image_key: "img_v3_AAA_xxxxx", width: 600, height: 400 },
      { tag: "text", text: " 怎么样？" },
    ],
  ],
});

const p2text = parsePostContent(p2);
expect("img + text inline: text preserved", p2text.includes("看这张图:"));
expect("img + text inline: [图片] placeholder", p2text.includes("[图片]"));
expect("img + text inline: closing text preserved", p2text.includes("怎么样？"));
expect(
  "img + text inline: single image_key extracted",
  extractPostImageKeys(p2).length === 1 && extractPostImageKeys(p2)[0] === "img_v3_AAA_xxxxx",
);

// ── 3. Multi-image post ────────────────────────────────────────────────────

const p3 = JSON.stringify({
  content: [
    [
      { tag: "text", text: "第一张: " },
      { tag: "img", image_key: "key_one" },
    ],
    [
      { tag: "text", text: "第二张: " },
      { tag: "img", image_key: "key_two" },
      { tag: "text", text: " 还有第三张 " },
      { tag: "img", image_key: "key_three" },
    ],
  ],
});

const p3keys = extractPostImageKeys(p3);
expect("multi-image: 3 keys extracted", p3keys.length === 3);
expect("multi-image: keys in order", p3keys[0] === "key_one" && p3keys[1] === "key_two" && p3keys[2] === "key_three");

// ── 4. Link (`a` tag) and @at and emotion ──────────────────────────────────

const p4 = JSON.stringify({
  content: [
    [
      { tag: "at", user_id: "ou_xxx", user_name: "张三" },
      { tag: "text", text: " 详情见 " },
      { tag: "a", text: "文档", href: "https://example.com/docs" },
      { tag: "emotion", emoji_type: "SMILE" },
    ],
  ],
});

const p4text = parsePostContent(p4);
expect("at: rendered as @user_name", p4text.includes("@张三"));
expect("a: rendered as markdown link", p4text.includes("[文档](https://example.com/docs)"));
expect("emotion: rendered as [emoji] placeholder", p4text.includes("[emoji]"));

// ── 5. Edge cases ──────────────────────────────────────────────────────────

// Empty content
const p5 = JSON.stringify({ title: "", content: [] });
expect("empty content: empty string", parsePostContent(p5) === "");

// No title
const p6 = JSON.stringify({ content: [[{ tag: "text", text: "no title" }]] });
expect("no title: just paragraph", parsePostContent(p6) === "no title");

// Unknown tag — silent skip
const p7 = JSON.stringify({
  content: [[{ tag: "video", url: "x" }, { tag: "text", text: "after unknown" }]],
});
expect("unknown tag: skipped", parsePostContent(p7) === "after unknown");

// at with user_id only (no user_name) — falls back to user_id
const p8 = JSON.stringify({ content: [[{ tag: "at", user_id: "ou_fallback" }]] });
expect("at fallback: user_id when no name", parsePostContent(p8) === "@ou_fallback");

// a with no text (use href as label)
const p9 = JSON.stringify({ content: [[{ tag: "a", href: "https://example.com" }]] });
expect(
  "a fallback: href as label when no text",
  parsePostContent(p9) === "[https://example.com](https://example.com)",
);

// Malformed: content is not an array
const p10 = JSON.stringify({ content: "not-an-array" });
expect("malformed content (not array): empty string", parsePostContent(p10) === "");

// Malformed: paragraph is not an array
const p11 = JSON.stringify({ content: [{ tag: "text", text: "wrong shape" }] });
expect("malformed paragraph: skipped, empty", parsePostContent(p11) === "");

// extractPostImageKeys ignores invalid JSON gracefully
expect("invalid JSON: empty keys", extractPostImageKeys("not-json").length === 0);
expect(
  "img without image_key string: skipped",
  extractPostImageKeys(
    JSON.stringify({ content: [[{ tag: "img", image_key: 42 }, { tag: "img" }]] }),
  ).length === 0,
);

// ── 6. Vincent UAT real shape (TM-anonymized) ──────────────────────────────

const realPost = JSON.stringify({
  title: "",
  content: [
    [
      { tag: "text", text: "v1.20.4 进度跟踪截图: " },
      { tag: "img", image_key: "img_v3_real_keyABC" },
    ],
    [{ tag: "text", text: "请帮我看下哪些已完成" }],
  ],
});

expect(
  "real shape: text rendered",
  parsePostContent(realPost).includes("v1.20.4 进度") &&
    parsePostContent(realPost).includes("请帮我看下哪些已完成"),
);
expect(
  "real shape: image_key extracted",
  extractPostImageKeys(realPost)[0] === "img_v3_real_keyABC",
);

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-post-parse tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
