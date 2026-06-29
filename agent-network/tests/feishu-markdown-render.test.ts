/**
 * RFC-020 §14 — Feishu markdown render auto-detect (Vincent 2026-06-29).
 *
 * When the agent's reply text contains markdown syntax (tables, headings,
 * fenced code, bold, lists, links, inline code), the adapter upgrades to
 * `msg_type:"interactive"` with a markdown element so Feishu renders it
 * properly instead of showing raw `|` and `**` as plain text.
 *
 * This test covers the pure detection helper. The adapter wire-up itself
 * (interactive card content shape) is exercised by the production smoke
 * after preview.7 deploy.
 *
 * Run: `bun tests/feishu-markdown-render.test.ts`
 */

import { looksLikeMarkdown } from "../src/im/feishu/adapter";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Markdown true positives ─────────────────────────────────────────────

const MD_POSITIVE: Array<[string, string]> = [
  ["fenced code block", "Here is the code:\n```js\nconst x = 1;\n```\nend"],
  ["fenced code at start", "```\nfoo\n```"],
  ["ATX heading h1", "# 测试报告\n\n详情见下"],
  ["ATX heading h2 mid-text", "前言\n\n## 第二章\n\n正文"],
  ["ATX heading h6", "###### 小标题\n内容"],
  ["table with header sep", "结果如下\n\n| 字段 | 值 |\n|---|---|\n| 名称 | 测试 |\n"],
  ["table with alignment markers", "\n| a | b |\n|:---:|---:|\n| 1 | 2 |\n"],
  // 通信牛 #328 round 1 blocker 2: table at literal start of reply was missed
  // by the old `\n\|...` anchor. Locked here with the exact counterexample
  // from his review.
  ["table at literal position 0", "| a | b |\n|---|---|\n| 1 | 2 |\n"],
  ["table at start + no trailing newline", "| col1 | col2 |\n|------|------|\n| v1 | v2 |"],
  ["bold double-asterisk", "重点是 **加粗文字** 看清楚"],
  ["multiple bold spans", "**第一段** 和 **第二段** 都重要"],
  ["unordered list with -", "步骤:\n- 第一\n- 第二\n- 第三"],
  ["unordered list with *", "项目:\n* a\n* b"],
  ["unordered list with +", "TODO:\n+ x\n+ y"],
  ["ordered list", "顺序:\n1. 先\n2. 然后\n3. 最后"],
  ["markdown link", "详情见 [文档](https://example.com/docs)"],
  ["inline code", "用 `npm install` 安装"],
  ["mixed: heading + code + bold", "# 测试\n\n用 `bun test` 跑, **必须** 全过\n\n```\nresult: ok\n```"],
];
for (const [name, text] of MD_POSITIVE) {
  expect(`MD true: ${name}`, looksLikeMarkdown(text), `text: ${text.slice(0, 60)}`);
}

// ── 2. Plain prose — must NOT trigger ──────────────────────────────────────

const MD_NEGATIVE: Array<[string, string]> = [
  ["plain text", "你好，这是回复"],
  ["text with one bar", "时间是 10|30"], // single `|`, not a table
  ["text with asterisk for emphasis-one-word", "他说 *好* 字"], // single * pair without strong content
  ["URL in text but no markdown link", "去 https://example.com 看"],
  ["one backtick at end of sentence", "运行命令 npm 然后等待"],
  ["text mentioning sharp", "C# 是一门语言"], // C# (no following space)
  ["text mentioning ordered count without dot", "1 2 3 排列"],
  ["text with dash but not list", "前-后 顺序"],
  ["empty string", ""],
  ["whitespace only", "   \n   "],
  ["null-ish", null as unknown as string],
  ["undefined-ish", undefined as unknown as string],
];
for (const [name, text] of MD_NEGATIVE) {
  expect(`MD false: ${name}`, !looksLikeMarkdown(text), `unexpected match for: ${JSON.stringify(text)}`);
}

// ── 3. Edge cases (boundary discipline) ────────────────────────────────────

// Heading must have a space after `#`s — `#foo` (no space) is not heading
expect("MD false: #notspace not heading", !looksLikeMarkdown("#标签"));
// 7-level heading is too deep (max 6 in markdown)
expect("MD false: ####### not a heading", !looksLikeMarkdown("####### too deep"));
// Bold needs non-empty content
expect("MD false: empty bold", !looksLikeMarkdown("**** "));
// List needs a space after marker
expect("MD false: -nospace not list", !looksLikeMarkdown("-foo"));
// Table needs separator row
expect("MD false: single table row no separator", !looksLikeMarkdown("\n| a | b |\n"));
// Ordered list needs `digit. space`
expect("MD false: 1.no-space", !looksLikeMarkdown("\n1.foo"));
// Inline code needs paired backticks AND content
expect("MD false: single backtick alone", !looksLikeMarkdown("正常文字 ` 单引"));
// Markdown link needs both [] and ()
expect("MD false: bracket but no paren", !looksLikeMarkdown("[label] without paren"));

// ── 4. Vincent UAT real-shape example (TM-anonymized) ─────────────────────

// Generic test report shape — what the bot produces in heavy work.
// Should trigger markdown rendering (table + heading + bold + code).
const realShape = `# API 测试报告

测试目标: 通用 API 兼容性

## 结果

| 端点 | 状态 |
|---|---|
| /v1/chat/completions | ✓ |
| /v1/models | ✓ |

执行命令: \`curl -H "Authorization: Bearer XXX" /v1/models\`

**结论**: 全部通过`;

expect(
  "Real-shape test report: triggers markdown render",
  looksLikeMarkdown(realShape),
  "this is the exact shape that broke for Vincent — must render",
);

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-markdown-render tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
