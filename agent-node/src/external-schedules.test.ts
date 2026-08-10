import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { parseExternalSchedulesManifest, readExternalSchedulesSnapshot } from "./external-schedules";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anet-external-schedules-"));
  roots.push(root);
  const nodeDir = join(root, "node");
  mkdirSync(nodeDir);
  const config = join(nodeDir, "config.json");
  writeFileSync(config, "{}\n");
  return { root, nodeDir, config, manifest: join(nodeDir, "external-schedules.json") };
}

describe("external schedule manifest", () => {
  test("reports an exact bounded shape and strips host paths to basename", () => {
    const snapshot = parseExternalSchedulesManifest(JSON.stringify({ external_schedules: [{
      id: "pstation-smoke", name: "P station smoke", kind: "playwright",
      frequency: "*/5 * * * *", last_run_at: "2026-08-10T01:02:03Z",
      last_status: "success", last_error: null, next_run_at: "2026-08-10T01:07:03Z",
      log_path: "/var/private/pstation-smoke.log", enabled: true,
    }] }), "2026-08-10T02:00:00Z");
    expect(snapshot).toEqual({
      observed_at: "2026-08-10T02:00:00.000Z",
      schedules: [{
        id: "pstation-smoke", name: "P station smoke", kind: "playwright",
        frequency: "*/5 * * * *", last_run_at: "2026-08-10T01:02:03.000Z",
        last_status: "success", last_error: null, next_run_at: "2026-08-10T01:07:03.000Z",
        log_ref: "pstation-smoke.log", enabled: true,
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("/var/private");
  });

  test("missing manifest is an explicit empty observation; config-less legacy stays omitted", () => {
    const { config } = fixture();
    expect(readExternalSchedulesSnapshot(config, "2026-08-10T02:00:00Z")).toEqual({
      observed_at: "2026-08-10T02:00:00Z", schedules: [],
    });
    expect(readExternalSchedulesSnapshot("", "2026-08-10T02:00:00Z")).toBeUndefined();
  });

  test("unknown keys, duplicate ids, invalid timestamps, and oversized lists fail closed", () => {
    const good = { id: "a", name: "A", kind: "cron", frequency: "* * * * *" };
    for (const value of [
      { external_schedules: [{ ...good, command: "cat /etc/passwd" }] },
      { external_schedules: [good, good] },
      { external_schedules: [{ ...good, next_run_at: "not-a-time" }] },
      { external_schedules: Array.from({ length: 65 }, (_, i) => ({ ...good, id: `s${i}` })) },
    ]) expect(() => parseExternalSchedulesManifest(JSON.stringify(value))).toThrow();
  });

  test("symlink manifest never follows the target", () => {
    const { root, manifest, config } = fixture();
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ external_schedules: [] }));
    symlinkSync(outside, manifest);
    expect(readExternalSchedulesSnapshot(config, "2026-08-10T02:00:00Z")).toEqual({
      observed_at: "2026-08-10T02:00:00Z", schedules: [], error: "unsafe_manifest",
    });
  });
});
