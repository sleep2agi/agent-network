import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const HARNESS = join(import.meta.dir, "..", "..", "tests", "test235-grok-mcp-outbound-only", "socket-harness.ts");
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

test.skipIf(!existsSync(HARNESS))("test235's harness derives its expectation instead of copying the names", () => {
  const harness = readFileSync(HARNESS, "utf8");
  expect(harness).toContain('from "../../agent-network/src/outbound-tool-names"');
  expect(harness).toContain("[...OUTBOUND_TOOL_NAMES].sort()");
  // The old copy asserted exactly three names and went stale when the fourth
  // shipped; nothing noticed, because no CI job runs test235.
  expect(harness).not.toContain('JSON.stringify(["commhub_send_task", "commhub_send_message", "commhub_get_all_status"])');
});

// 🔴 Why skipIf rather than a plain test: this file also runs inside
// tests/test745-agent-network-unit-ci, whose image copies ONLY agent-network/
// (plus agent-node/package.json and its own run.sh). Reaching across to
// tests/test235-.../socket-harness.ts passes on a full checkout and fails with
// ENOENT in that container — which is exactly what happened on the first CI run
// of this branch.
//
// Skipping when the file is absent is a fail-open, so it is paired with a check
// that says so out loud instead of quietly reporting a pass: in a full checkout
// the file must be there, and its absence there is a real regression.
test("the harness assertion is not silently skipped in a full checkout", () => {
  const fullCheckout = existsSync(join(import.meta.dir, "..", "..", "tests"));
  if (fullCheckout) {
    expect(existsSync(HARNESS)).toBe(true);
  } else {
    // Package-scoped container. Say which assertion did not run, so a green
    // here is never mistaken for "the harness was checked".
    console.warn(
      "[outbound-tool-names.test] tests/ is not present — the socket-harness " +
      "assertion did NOT run in this image. It runs on a full checkout.",
    );
  }
});
