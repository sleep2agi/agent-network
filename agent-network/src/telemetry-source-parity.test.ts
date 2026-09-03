import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1727 —— node-server(agent-network)和 agent-node 用**同一份**采集器源码,
// 这样 hub 名册里 claude-code 族与 agent-node 族的六个字段口径一致。
// agent-network 不能 import agent-node(grok-build-drift.test.ts 禁止),所以是复制 + 这道门:
// 任一边改了而另一边没跟上,这里先红。
const HERE = import.meta.dir;
const AGENT_NODE = join(HERE, "..", "..", "agent-node", "src");

describe("#1727 telemetry collectors are byte-identical across packages", () => {
  for (const name of ["host-telemetry.ts", "process-telemetry.ts"]) {
    test(name, () => {
      const ours = readFileSync(join(HERE, name), "utf8");
      const theirs = readFileSync(join(AGENT_NODE, name), "utf8");
      expect(ours.length).toBeGreaterThan(500);
      expect(ours).toBe(theirs);
    });
  }
});
