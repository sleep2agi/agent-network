// #1345 — the proxy's file log sink. Behavioral tests against a real fs.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, chmodSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createActivityLogSink } from "./node-activity-log";

describe("#1345 createActivityLogSink", () => {
  test("writes lines to .anet/nodes/<alias>/logs/<utc-date>.log and appends", () => {
    const base = mkdtempSync(join(tmpdir(), "nal-"));
    const fixed = new Date("2026-08-28T23:59:59.000Z"); // UTC date pins the filename
    const sink = createActivityLogSink(base, "测试牛", () => fixed);
    sink.append("[10:00:00] [commhub] first");
    sink.append("[10:00:01] [commhub] second");
    const dir = join(base, ".anet", "nodes", "测试牛", "logs");
    expect(readdirSync(dir)).toEqual(["2026-08-28.log"]);
    const content = readFileSync(join(dir, "2026-08-28.log"), "utf8");
    expect(content).toBe("[10:00:00] [commhub] first\n[10:00:01] [commhub] second\n");
  });

  test("filename is the UTC date, not the local one", () => {
    const base = mkdtempSync(join(tmpdir(), "nal-"));
    // 2026-08-29T00:30Z is still 08-28 in UTC-8 and already 08-29 in UTC+8;
    // the sink must follow UTC regardless of the host TZ (log-name discipline).
    const sink = createActivityLogSink(base, "a", () => new Date("2026-08-29T00:30:00.000Z"));
    sink.append("x");
    expect(readdirSync(join(base, ".anet", "nodes", "a", "logs"))).toEqual(["2026-08-29.log"]);
  });

  test("a torn-down node dir is NEVER recreated — sink goes permanently silent", () => {
    // The race this guards: `anet node stop` removes .anet/nodes/<alias>/
    // and then verifies nothing survived; the proxy's SSE-disconnect
    // callbacks still log() during that window. Resurrecting the dir makes
    // stop's cleanup verification fail (test225 CI red, 2026-08-28).
    const base = mkdtempSync(join(tmpdir(), "nal-"));
    const sink = createActivityLogSink(base, "c", () => new Date("2026-08-28T00:00:00.000Z"));
    sink.append("before stop");
    const nodeDir = join(base, ".anet", "nodes", "c");
    rmSync(nodeDir, { recursive: true, force: true }); // stop tears the node dir down
    sink.append("during stop teardown");
    expect(existsSync(nodeDir)).toBe(false); // ← the actual invariant stop depends on
    sink.append("after stop");
    expect(existsSync(nodeDir)).toBe(false); // stays down: sink is permanently disabled
  });

  test("an unwritable destination is swallowed, then recovers when writable again", () => {
    const base = mkdtempSync(join(tmpdir(), "nal-"));
    const nodesDir = join(base, ".anet", "nodes");
    mkdirSync(nodesDir, { recursive: true });
    chmodSync(nodesDir, 0o555); // mkdir of <alias> under it fails
    const sink = createActivityLogSink(base, "b", () => new Date("2026-08-28T00:00:00.000Z"));
    expect(() => sink.append("dropped")).not.toThrow();
    chmodSync(nodesDir, 0o755);
    sink.append("kept");
    const content = readFileSync(join(nodesDir, "b", "logs", "2026-08-28.log"), "utf8");
    expect(content).toBe("kept\n"); // the failed line is gone, the next one lands
  });
});
