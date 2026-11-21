import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { adoptionCandidatesReportSchema } from "./adoption-candidates.js";

// 2026-11-20 真机实测（antigravity-acp #3682 之后）—— admin 发一条真实任务给
// ANet反重力 节点，agy（Go 写的 ACP server）拒绝了整个 report_status 工具：
//   "tool \"mcp_commhub_report_status\" advertises an invalid parameter schema
//    … is not valid regex: error parsing regexp: invalid escape sequence: \u"
//   at '…/daemon_capabilities/properties/adoption_candidates/items/properties/workdir/pattern'
//
// 根因：adoptionCandidatesReportSchema 的 workdir 正则用的是 \u0000-\u001f（Unicode
// 转义，JS 正则和 JSON Schema 规范都认），这份 schema 经 zod/v4 的 z.toJSONSchema()
// 序列化成 MCP 工具参数时，`pattern` 字段原样带着这个转义——但 agy 的 Go 后端用
// Go regexp(RE2) 去编译它，RE2 根本不支持 \u 这种写法。JS 这边永远测不出这个问题
// （JS 正则引擎认得 \u），只有真的喂给一个 Go 正则编译器才会炸——这正是这条测试要
// 守住的：不 mock、不猜，直接断言 z.toJSONSchema() 真实产出的 pattern 字符串里
// 没有这个转义形式，字符范围（0x00–0x1F）不变，写法换成 \x，两边都认。
test("adoptionCandidatesReportSchema's JSON Schema pattern has no \\u escape (Go RE2 can't parse it; real breakage, not theoretical)", () => {
  const schema = z.toJSONSchema(z.object({ adoption_candidates: adoptionCandidatesReportSchema }));
  const asText = JSON.stringify(schema);
  expect(asText).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  // 正向断言：\x 写法确实在，而且字符范围没被我顺手改错。
  expect(asText).toContain("\\\\x00-\\\\x1f");
});

// 2026-11-21 真机实测——换 \x 之后又在**同一条 pattern**上炸出第二个 Go RE2 坑：
//   "error parsing regexp: invalid repeat count: `{0,1023}`"
// Go 的 regexp/syntax 把 {n,m} 里的 m 硬性限制在 1000 以内（JS 正则和 JSON Schema 规范都没有
// 这个上限），所以这条只能从真实的 Go 编译器才会暴露，JS 侧只能守住"写出来的 pattern 字符串
// 里不再出现任何一段超过 1000 的重复次数"这个必要条件（不是完整证明，完整证明要靠 Go 侧真机）。
test("adoptionCandidatesReportSchema's JSON Schema pattern has no single repeat-count above 1000 (Go RE2's maxRepeat cap; distinct bug from the \\u escape above)", () => {
  const schema = z.toJSONSchema(z.object({ adoption_candidates: adoptionCandidatesReportSchema }));
  const asText = JSON.stringify(schema);
  const counts = [...asText.matchAll(/\{(\d+),(\d+)\}/g)].map(m => Number(m[2]));
  expect(counts.length).toBeGreaterThan(0);
  for (const n of counts) expect(n).toBeLessThanOrEqual(1000);
  // 正向断言：workdir 的实际字符上限（含开头的 "/"，共 1024）没有被拆分弄丢。
  expect(asText).toContain("\\\\x00-\\\\x1f]{0,1000}[^\\\\x00-\\\\x1f]{0,23}");
});
