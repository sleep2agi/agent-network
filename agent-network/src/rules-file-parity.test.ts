import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// app#225 follow-up —— claude-code 会话节点(channel server node-server.ts)也要答
// 规则文件门铃。两个包不能互相 import(agent-node 不依赖 @sleep2agi/agent-network),
// 照 #1918 codex-auth-fingerprint 的先例:**逐字节复制 + 这道门**。
// 路径安全规则(无路径参数、目录固定 cwd、文件名按 runtime、大小上限、只读普通文件、
// 临时文件 + rename)全在这一份里;任一边改了而另一边没跟上,这里先红。
const HERE = import.meta.dir;
const AGENT_NODE = join(HERE, "..", "..", "agent-node", "src", "runtime");
const NAME = "rules-file.ts";
// 节点技能只读查看(node-skills.ts)走同一条门铃,同样逐字节复制。
// 项目文件夹只读查看(node-files.ts)同理。
const SHARED = [NAME, "node-skills.ts", "node-files.ts"];
// rules-file.ts 唯一允许的非 node: 依赖:同样被本门钉住的兄弟文件。
const ALLOWED_SIBLINGS = new Set(["./node-skills", "./node-files"]);

describe("app#225 rules-file logic is byte-identical across packages", () => {
  for (const file of SHARED) {
    test(file, () => {
      const ours = readFileSync(join(HERE, file), "utf8");
      const theirs = readFileSync(join(AGENT_NODE, file), "utf8");
      expect(ours.length).toBeGreaterThan(2000);
      expect(ours).toBe(theirs);
    });
  }

  const importSpecs = (src: string): string[] =>
    src.split("\n")
      .map((line) => /^\s*import[^"']*from\s+["']([^"']+)["']/.exec(line)?.[1])
      .filter((spec): spec is string => !!spec);

  test("depends on node builtins (plus the parity-pinned sibling) only — that is what makes the copy possible", () => {
    for (const file of SHARED) {
      const specs = importSpecs(readFileSync(join(HERE, file), "utf8"));
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) expect(spec.startsWith("node:") || ALLOWED_SIBLINGS.has(spec)).toBe(true);
    }
  });
});
