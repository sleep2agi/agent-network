// #1809 —— agent-node 的两条 report_status 路径(3 分钟心跳 + 状态变化上报)都要带 version。
// 此前只有心跳带;状态上报不带,于是 hub 在同 alias 换 resume_id 时(DELETE+INSERT)把
// version 清成 NULL,要等下一次心跳才补回。这是源码契约测试:它只能证明「写了」,
// 真跑的证据在 server/src/report-status-resume-id-handover.test.ts 与 DEV 真机日志。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

function payloadBlocks(): string[] {
  // 每个 callCommHub("report_status", { … }) 的第一层对象字面量
  const out: string[] = [];
  const re = /callCommHub\("report_status",\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1; let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("#1809 report_status 负载带 version", () => {
  test("状态上报 reportStatus():callCommHub(\"report_status\", { … }) 字面量第一层有 version: AGENT_NODE_VERSION", () => {
    const blocks = payloadBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const b of blocks) {
      expect(b, b.slice(0, 200)).toMatch(/^\s*version:\s*AGENT_NODE_VERSION\s*,/m);
    }
  });

  test("3 分钟心跳:传给 callCommHub(\"report_status\", payload) 的 payload 对象也有 version", () => {
    // 心跳先构造 `const payload = { … }` 再传变量名;取该对象字面量的第一层。
    const call = src.indexOf('callCommHub("report_status", payload)');
    expect(call).toBeGreaterThan(0);
    const start = src.lastIndexOf("const payload", call);
    expect(start).toBeGreaterThan(0);
    const open = src.indexOf("{", start);
    let depth = 1; let i = open + 1;
    for (; i < src.length && depth > 0; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; }
    const block = src.slice(open, i);
    expect(block, block.slice(0, 200)).toMatch(/^\s*version:\s*AGENT_NODE_VERSION\s*,/m);
  });
});
