// #501 — claude-agent-sdk 0.3.289 records a bare-string systemPrompt on a session's first request and
// replays it verbatim on `resume`, so a changed systemPrompt was ignored after a restart (canary
// 2026-10-05: A→B + resume still answered A on 0.3.289, B on 0.3.231). processWithClaude must pass the
// prompt as { type: "custom", prompt, snapshot: false }. This pins that shape so a refactor back to the
// bare string fails here instead of silently on a live node.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

describe("#501 claude systemPrompt is not snapshotted", () => {
  test("processWithClaude sets systemPrompt with snapshot: false", () => {
    expect(src).toMatch(/options\.systemPrompt\s*=\s*\{\s*type:\s*"custom",\s*prompt:\s*combinedSystemPrompt,\s*snapshot:\s*false\s*\}/);
  });
  test("no bare-string systemPrompt assignment remains", () => {
    expect(src).not.toMatch(/options\.systemPrompt\s*=\s*combinedSystemPrompt\s*;/);
  });
});
