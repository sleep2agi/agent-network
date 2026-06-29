/**
 * RFC-020 §14 — feishu markdown-image hybrid route tests.
 *
 * Locks the routing decision (shouldRenderAsImage). The actual PNG
 * render path is exercised by Docker e2e (needs system chromium); this
 * harness covers the pure routing logic that decides text vs card vs
 * image.
 *
 * Run: `bun tests/feishu-markdown-image.test.ts`
 */

import { shouldRenderAsImage } from "../src/im/feishu/markdown-image-renderer";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Heading at start of line → image ────────────────────────────────────

const HEADING_IMAGE: Array<[string, string]> = [
  ["h1 alone", "# Title"],
  ["h1 with body", "# 测试报告\n\n详情见下"],
  ["h2 mid-text", "前言\n\n## 第二章\n\n正文"],
  ["h3", "### Sub heading\n内容"],
  ["h6 deepest", "###### tiny\nbody"],
  ["heading at literal start", "# 第一行就是标题"],
];
for (const [name, text] of HEADING_IMAGE) {
  expect(`heading → image: ${name}`, shouldRenderAsImage(text), JSON.stringify(text));
}

// ── 2. Table → image ───────────────────────────────────────────────────────

const TABLE_IMAGE: Array<[string, string]> = [
  ["table at start", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["table at start w/ trailing", "| a | b |\n|---|---|\n| 1 | 2 |\n"],
  ["table after prose", "结果如下\n\n| 字段 | 值 |\n|---|---|\n| 名称 | 测试 |\n"],
  ["table with alignment", "\n| a | b |\n|:---:|---:|\n| 1 | 2 |\n"],
];
for (const [name, text] of TABLE_IMAGE) {
  expect(`table → image: ${name}`, shouldRenderAsImage(text), JSON.stringify(text));
}

// ── 3. Long content → image ────────────────────────────────────────────────

expect(
  "long plain prose → image (>2000 chars)",
  shouldRenderAsImage("a".repeat(2001)),
);
expect(
  "exactly 2001 chars → image",
  shouldRenderAsImage("我是一段很长的中文" + " ".repeat(2000)),
);

// ── 4. Short markdown without heading/table → NOT image (use card) ─────────

const NOT_IMAGE: Array<[string, string]> = [
  ["plain text short", "你好"],
  ["short prose", "今天天气真好，适合工作。"],
  ["short bold", "重点是 **加粗文字** 看清楚"],
  ["short list", "步骤:\n- 一\n- 二\n- 三"],
  ["short ordered list", "顺序:\n1. 先\n2. 后"],
  ["link", "详情见 [文档](https://example.com)"],
  ["inline code", "用 `npm install` 安装"],
  ["short code block", "示例:\n```\nx=1\n```\n用就这样"],
  ["mixed but short", "**重点**: 用 `bash` 跑\n\n- 第一步\n- 第二步"],
];
for (const [name, text] of NOT_IMAGE) {
  expect(`short md (no heading/table) → NOT image: ${name}`, !shouldRenderAsImage(text), JSON.stringify(text));
}

// ── 5. Edge / boundary cases ───────────────────────────────────────────────

expect("empty string → not image", !shouldRenderAsImage(""));
expect("null-ish → not image", !shouldRenderAsImage(null as any));
expect("undefined-ish → not image", !shouldRenderAsImage(undefined as any));
expect("just whitespace → not image", !shouldRenderAsImage("   \n   "));

// ATX heading must have space after `#`s — `#tag` (no space) is NOT a heading
expect("hashtag-style #tag NOT heading", !shouldRenderAsImage("#nospace"));
// 7+ hashes is not a heading either
expect("####### too deep is NOT heading", !shouldRenderAsImage("####### nope"));

// Length at the boundary
expect("exactly 2000 chars → NOT image", !shouldRenderAsImage("a".repeat(2000)));

// Table requires real separator row — single `|...|` line alone is not a table
expect(
  "single pipe row no separator → NOT image (not a real table)",
  !shouldRenderAsImage("| a | b |\nfoo bar"),
);

// ── 6. Vincent UAT real-shape (TM-anonymized) — triggers image ─────────────

const realShape = `# API 测试报告

## 结果

| 端点 | 状态 |
|---|---|
| /v1/chat | ✓ |
| /v1/models | ✓ |

**结论**: 全部通过`;

expect(
  "realistic test report (heading + table + bold) → image",
  shouldRenderAsImage(realShape),
);

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-markdown-image tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
