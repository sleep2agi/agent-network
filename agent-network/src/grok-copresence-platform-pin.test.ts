import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GROK_COPRESENCE_PLATFORMS, GROK_COPRESENCE_REDUCED_GUARANTEE_PLATFORMS } from "./grok-copresence-orchestration.js";

// #1768 —— CLI 的平台门必须和 agent-node 的能力表说同一句话。agent-network 不能
// import agent-node(grok-build-drift.test.ts 禁止),所以这里读它的源码:
// `copresenceCapabilities()` 里每个 `if (platform === "X")` 分支的 `supported:`。
// 表在 agent-node 那边改了(加平台 / 撤平台),这条会红,而不是让 Mac 上的节点重启时才发现。
const PLATFORM_TS = join(import.meta.dir, "..", "..", "agent-node", "src", "runtime", "grok-copresence", "platform.ts");

function supportedPlatformsFromAgentNode(source: string): { supported: string[]; reduced: string[] } {
  const supported: string[] = [];
  const reduced: string[] = [];
  const blocks = source.split(/^\s*if \(platform === "/m).slice(1);
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of blocks) {
    const platform = block.slice(0, block.indexOf('"'));
    const body = block.slice(0, block.indexOf("\n  }\n"));
    const m = /supported:\s*([a-zA-Z]+)/.exec(body);
    expect(m, platform).not.toBeNull();
    // `supported: procfs` (linux) is a runtime probe that defaults to true.
    if (m![1] === "true" || m![1] === "procfs") supported.push(platform);
    if (/reducedGuarantees:\s*\[\s*"/.test(body)) reduced.push(platform);
  }
  return { supported, reduced };
}

describe("#1768 CLI platform gate mirrors agent-node copresenceCapabilities", () => {
  const source = readFileSync(PLATFORM_TS, "utf8");
  const table = supportedPlatformsFromAgentNode(source);

  test("the parser sees agent-node's real table (positive control)", () => {
    expect(table.supported).toContain("linux");
    expect(table.reduced).not.toContain("linux");
  });

  test("every platform agent-node supports is admitted by the CLI, and nothing else", () => {
    expect([...GROK_COPRESENCE_PLATFORMS].sort()).toEqual([...table.supported].sort());
  });

  test("the reduced-guarantee notice covers exactly the platforms agent-node lists reducedGuarantees for", () => {
    expect([...GROK_COPRESENCE_REDUCED_GUARANTEE_PLATFORMS].sort()).toEqual([...table.reduced].sort());
  });
});
