import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  benignKindsFor,
  classifyRuntimeStderr,
  runtimesWithBenignTable,
  STDERR_PROMOTION_PATTERN,
} from "./stderr-classify";
import { createStderrTurnAggregator } from "./stderr-turn-aggregator";

// The twelve lines a partner team observed on one of its nodes on 2026-09-17 (same condition,
// different paths) — the case that motivated #1917 ②.
const PATH_OUTSIDE_LINES = Array.from({ length: 12 }, (_, i) =>
  `tool_error: tool_output_error Failed to read file: /data/workspaces/agent-network-tmai-dog/file-${i}.ts, ` +
  `IO Error: path outside Grok runtime cwd: /data/workspaces/agent-network-tmai-dog/file-${i}.ts`);

// Real failure shapes that arrive **on grok's stderr** and must stay loud:
// the point of the change is that they stop being drowned, not that they
// join the drowning.
//
// 🔴 #1917 listed three "real WARNs" from that day — `SSE error: terminated`,
// `SSE error: fetch failed`, `stripped 1 leaked CommHub/MCP status line(s)`.
// Only the Settings one is a grok stderr line; the other three are emitted by
// agent-node itself through `warn()` and never reach this classifier. They
// are unaffected by #1917 ② in either direction, which is why they are
// asserted separately below rather than folded into this list.
const REAL_WARN_LINES = [
  "ERROR Settings fetch failed max_attempts=3",
  "Error: connection refused",
  "ENOENT: no such file or directory",
  "permission denied while opening /etc/shadow",
];

describe("classifyRuntimeStderr (#1917 ②)", () => {
  test("grok's path-outside-cwd refusal is benign, not a WARN", () => {
    for (const line of PATH_OUTSIDE_LINES) {
      const v = classifyRuntimeStderr("grok", line);
      expect(v.level).not.toBe("warn");
      expect(v.benignKind).toBe("path-outside-cwd");
    }
  });

  test("a bare tool_output_error without a path is still benign", () => {
    const v = classifyRuntimeStderr("grok", "[grok] tool_error: tool_output_error");
    expect(v.benignKind).toBe("tool-output-error");
    expect(v.level).toBe("debug");
  });

  // ── the other direction: the change must not make real failures quiet ──
  test("real failures stay WARN for the same runtime", () => {
    for (const line of REAL_WARN_LINES) {
      const v = classifyRuntimeStderr("grok", line);
      expect(v.benignKind).toBeUndefined();
      expect(v.level).toBe("warn");
    }
  });

  test("an unseen failure shape stays WARN — new is never quiet", () => {
    const v = classifyRuntimeStderr("grok", "FATAL: cannot allocate memory");
    expect(v.benignKind).toBeUndefined();
    expect(v.level).toBe("warn");
  });

  test("node-emitted warnings never pass through this classifier at all", () => {
    // Documents the boundary #1917's evidence blurred: these three lines are
    // produced by agent-node's own `warn()` calls, not by grok's stderr, so
    // no change to the benign table can quiet them. Asserting them as if the
    // classifier owned them would be a test measuring the wrong object.
    const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8").replace(/\r\n?/g, "\n");
    expect(cli.includes("SSE error:")).toBe(true);
    expect(cli.includes("leaked CommHub/MCP status line")).toBe(true);
    // And under the old keyword rule they would not have been promoted from
    // stderr anyway — the "leaked" line contains none of the keywords.
    expect(STDERR_PROMOTION_PATTERN.test("stripped 1 leaked CommHub/MCP status line(s) from reply")).toBe(false);
  });

  test("chatty non-failure lines stay debug, as before", () => {
    const v = classifyRuntimeStderr("grok", "loaded 12 skills from .agents/skills");
    expect(v.level).toBe("debug");
    expect(v.benignKind).toBeUndefined();
  });

  test("a runtime without a benign table keeps the pre-#1917 rule exactly", () => {
    // Positive control: the very line that grok folds must still WARN for a
    // runtime that has no table, proving the table (not the regex) is what
    // changed behaviour.
    const v = classifyRuntimeStderr("codex", PATH_OUTSIDE_LINES[0]);
    expect(v.level).toBe("warn");
    expect(v.benignKind).toBeUndefined();
    for (const line of REAL_WARN_LINES) {
      expect(classifyRuntimeStderr("codex", line).level).toBe("warn");
    }
    expect(classifyRuntimeStderr("codex", "just a chatty line").level).toBe("debug");
  });

  test("the fallback pattern is still the pre-#1917 keyword rule", () => {
    expect(STDERR_PROMOTION_PATTERN.test("ENOENT: no such file")).toBe(true);
    expect(STDERR_PROMOTION_PATTERN.test("permission denied")).toBe(true);
    expect(STDERR_PROMOTION_PATTERN.test("all good")).toBe(false);
  });

  test("the table is introspectable (docs/tests read it, not a copy of it)", () => {
    expect(runtimesWithBenignTable()).toEqual(["grok"]);
    expect(benignKindsFor("grok").sort()).toEqual(["path-outside-cwd", "tool-output-error"]);
    expect(benignKindsFor("codex")).toEqual([]);
  });
});

describe("stderr turn aggregator (#1917 ②)", () => {
  test("twelve benign lines become exactly one non-WARN line", () => {
    const agg = createStderrTurnAggregator("grok", "[grok-stderr]");
    const emissions = PATH_OUTSIDE_LINES.map((l) => agg.observe(l)).filter((e) => e !== null);
    expect(emissions).toEqual([]); // nothing emitted during the turn
    expect(agg.counts()).toEqual({ "path-outside-cwd": 12 });

    const summary = agg.finish()!;
    expect(summary).not.toBeNull();
    expect(summary.level).not.toBe("warn");
    expect(summary.level).toBe("info"); // visible at the default level
    expect(summary.line).toBe(
      "[grok-stderr] known-benign stderr this turn: 12 (path-outside-cwd 12)",
    );
  });

  test("a real failure is emitted immediately at WARN, not folded", () => {
    const agg = createStderrTurnAggregator("grok", "[grok-stderr]");
    const emitted = agg.observe("SSE error: terminated");
    expect(emitted).toEqual({ level: "warn", line: "[grok-stderr] SSE error: terminated" });
    expect(agg.finish()).toBeNull(); // nothing was folded, so no summary
  });

  test("mixed turn: real failures pass through while benign ones fold", () => {
    const agg = createStderrTurnAggregator("grok", "[grok-stderr]");
    const out: string[] = [];
    for (const line of [...PATH_OUTSIDE_LINES.slice(0, 5), "SSE error: terminated", ...PATH_OUTSIDE_LINES.slice(5)]) {
      const e = agg.observe(line);
      if (e) out.push(`${e.level}:${e.line}`);
    }
    expect(out).toEqual(["warn:[grok-stderr] SSE error: terminated"]);
    const summary = agg.finish()!;
    expect(summary.line).toContain("known-benign stderr this turn: 12");
  });

  test("two benign kinds render a stable, count-ordered breakdown", () => {
    const agg = createStderrTurnAggregator("grok", "[grok-stderr]");
    agg.observe("tool_error: tool_output_error");
    for (const l of PATH_OUTSIDE_LINES.slice(0, 3)) agg.observe(l);
    expect(agg.finish()!.line).toBe(
      "[grok-stderr] known-benign stderr this turn: 4 (path-outside-cwd 3, tool-output-error 1)",
    );
  });

  test("finish() resets, so the next turn starts from zero", () => {
    const agg = createStderrTurnAggregator("grok", "[grok-stderr]");
    agg.observe(PATH_OUTSIDE_LINES[0]);
    expect(agg.finish()!.line).toContain(": 1 (");
    expect(agg.counts()).toEqual({});
    expect(agg.finish()).toBeNull();
    agg.observe(PATH_OUTSIDE_LINES[1]);
    expect(agg.finish()!.line).toContain(": 1 (");
  });
});

describe("wiring (#1917 ②) — the call sites actually use the classifier", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8").replace(/\r\n?/g, "\n");

  test("neither grok stderr handler still carries the blanket keyword regex", () => {
    expect(cli.includes("/error|fail|cannot|denied|enoent|not found/i.test(line)")).toBe(false);
  });

  test("both grok stderr handlers route through the aggregator", () => {
    expect(cli.includes("createStderrTurnAggregator")).toBe(true);
    expect((cli.match(/stderrAggregator\.observe\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((cli.match(/stderrAggregator\.finish\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
