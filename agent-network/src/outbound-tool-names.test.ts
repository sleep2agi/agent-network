import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { OUTBOUND_TOOL_NAMES } from "./outbound-tool-names";

test("the outbound set contains every tool a node-server exposes in outbound-only mode", () => {
  expect([...OUTBOUND_TOOL_NAMES].sort()).toEqual([
    "commhub_get_all_status",
    "commhub_send_message",
    "commhub_send_task",
    "commhub_upload_file",
  ]);
});

test("importing the constant does not boot a server", () => {
  // node-server.ts opens an MCP stdio connection and starts an SSE listener on
  // import. A test that reads the list must not pay for that, or it fails for
  // reasons unrelated to what it tests.
  // Strip comments first. This is the second time tonight an absence-assertion
  // tripped on prose that quotes the thing being forbidden — the header of that
  // module explains the boot problem by quoting an import statement. Assert
  // about the code.
  const raw = readFileSync(join(import.meta.dir, "outbound-tool-names.ts"), "utf8");
  const code = raw.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  expect(code).not.toContain("import ");
  expect(code).not.toMatch(/require\(/);
});

test("node-server.ts consumes the shared constant rather than redeclaring it", () => {
  const src = readFileSync(join(import.meta.dir, "node-server.ts"), "utf8");
  expect(src).toContain('from "./outbound-tool-names"');
  // A second declaration is the drift this module exists to prevent.
  expect(src).not.toMatch(/const OUTBOUND_TOOL_NAMES\s*=\s*new Set/);
});

test("test235's harness derives its expectation instead of copying the names", () => {
  const harness = readFileSync(
    join(import.meta.dir, "..", "..", "tests", "test235-grok-mcp-outbound-only", "socket-harness.ts"),
    "utf8",
  );
  expect(harness).toContain('from "../../agent-network/src/outbound-tool-names"');
  expect(harness).toContain("[...OUTBOUND_TOOL_NAMES].sort()");
  // The old copy asserted exactly three names and went stale when the fourth
  // shipped; nothing noticed, because no CI job runs test235.
  expect(harness).not.toContain('JSON.stringify(["commhub_send_task", "commhub_send_message", "commhub_get_all_status"])');
});
