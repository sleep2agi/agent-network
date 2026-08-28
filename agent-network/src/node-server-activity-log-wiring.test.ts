// #1345 — wiring assertion. node-server.ts is a side-effecting entrypoint
// (importing it dials the hub), so the wiring is pinned against source text:
// the log() body must feed the activity sink, and the sink must be created
// from ALIAS. Deleting either line goes red.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("#1345 node-server log() wiring", () => {
  const src = readFileSync(join(import.meta.dir, "node-server.ts"), "utf8");

  test("creates the sink from cwd + ALIAS", () => {
    expect(src).toContain("const activityLog = createActivityLogSink(process.cwd(), ALIAS)");
  });

  test("log() writes the same line to stderr and the sink", () => {
    const fnStart = src.indexOf("function log(msg: string)");
    expect(fnStart).toBeGreaterThan(-1);
    const body = src.slice(fnStart, src.indexOf("\n}", fnStart));
    expect(body).toContain("activityLog.append(line)");
    expect(body).toContain("process.stderr.write(`${line}\\n`)");
  });
});
