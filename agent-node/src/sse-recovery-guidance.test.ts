import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sseAbandonGuidance } from "./sse-recovery-guidance";

describe("sseAbandonGuidance", () => {
  test("states that abandon leaves the current process alive", () => {
    const text = sseAbandonGuidance("node-b", "http://127.0.0.1:9200");
    expect(text).toContain("当前 agent-node 实例");
    expect(text).toContain("仍在运行");
    expect(text).toContain("alias=node-b");
  });

  test("requires stop-and-replace instead of starting a duplicate", () => {
    const text = sseAbandonGuidance("node-b", "http://127.0.0.1:9200");
    expect(text).toContain("不要另起同 alias 实例");
    expect(text).toContain("重复消费者");
    expect(text).toContain("先停止当前实例");
    expect(text).toContain("替换式重启");
    expect(text).not.toContain("anet node start node-b");
  });

  test("preserves the co-presence launch shape in recovery guidance", () => {
    const text = sseAbandonGuidance("A站负责人TUI", "https://hub.example.invalid");
    expect(text).toContain("--copresence");
    expect(text).toContain("专用 config");
    expect(text).toContain("不能改用通用 node start");
  });

  test("the production SSE abandon hook uses the honest guidance", () => {
    const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    expect(cli).toContain("onAbandon: () => error(sseAbandonGuidance(ALIAS, COMMHUB_URL))");
    expect(cli).not.toContain("运行 `anet node start ${ALIAS}` 手动恢复");
  });

  test("guidance says the node retries slowly and recovers by itself", () => {
    const text = sseAbandonGuidance("node-b", "http://127.0.0.1:9200");
    expect(text).toContain("降频重连");
    expect(text).toContain("自动");
    expect(text).toContain("看起来是在线的");
    expect(text).not.toContain("已停止自动重连");
  });

  test("the SSE supervisor keeps probing after the abandon threshold", () => {
    const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    expect(cli).toContain("slowRetryAfterAbandonMs: 5 * 60_000");
  });
});
