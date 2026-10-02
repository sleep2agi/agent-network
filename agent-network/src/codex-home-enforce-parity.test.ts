import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #448 —— CODEX_HOME 强制/核对必须在**两条启动路径**上一致:`anet node start`(launcher 与 tmux 三段)
// 和直起的 agent-node(自有 app-server)。两个包不能互相 import,照 #1918 / #1727 的先例:
// **逐字节复制 + 这道门**。任一边改了而另一边没跟上,这里先红。
const HERE = import.meta.dir;
const AGENT_NODE = join(HERE, "..", "..", "agent-node", "src");
const NAME = "codex-home-enforce.ts";

describe("#448 the CODEX_HOME enforcement module is byte-identical across packages", () => {
  test(NAME, () => {
    const ours = readFileSync(join(HERE, NAME), "utf8");
    const theirs = readFileSync(join(AGENT_NODE, NAME), "utf8");
    expect(ours.length).toBeGreaterThan(500);
    expect(ours).toBe(theirs);
  });

  test("depends on node builtins only — that is what makes the copy possible", () => {
    const specs = readFileSync(join(HERE, NAME), "utf8").split("\n")
      .map((line) => /^\s*import[^"']*from\s+["']([^"']+)["']/.exec(line)?.[1])
      .filter((spec): spec is string => !!spec);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith("node:")).toBe(true);
  });
});
