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

// 🔴 The harness assertion used to live here and does not any more.
//
// tests/test745-agent-network-unit-ci's image copies ONLY agent-network/ (plus
// agent-node/package.json and its own run.sh), so reading
// tests/test235-.../socket-harness.ts from this suite is ENOENT there. I tried
// two ways to be clever about that and got both wrong:
//
//   1. read it unconditionally      → ENOENT in the container
//   2. skip when `tests/` is absent → the container HAS a `tests/` directory
//                                     (test745's own run.sh lives in it), so the
//                                     probe said "full checkout" and asserted
//                                     anyway
//
// The second failure is the same mistake twice: probing an incidental feature
// ("is there a tests/ directory") instead of the thing itself. Rather than build
// a third detector, this suite now asserts only what is inside its own package.
//
// The consequence is stated rather than papered over: NOTHING gates the fact
// that socket-harness.ts derives its expectation from OUTBOUND_TOOL_NAMES. That
// is not a new gap introduced here — no workflow and neither of qa.sh's L0/L1
// lists runs test235 at all, which is why its assertion could be wrong on main
// for as long as it was. Wiring test235 into CI is the fix for that, and it is a
// separate change: it needs a real hub and a socket harness, not a unit runner.
