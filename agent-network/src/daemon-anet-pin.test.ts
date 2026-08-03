import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDaemonAnetPin } from "./daemon-anet-pin.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("daemon anet launcher pin", () => {
  test("pins the canonical executable by absolute path + hash and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-pin-")); roots.push(root);
    const cli = join(root, "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('ok')\n", { mode: 0o700 });
    const first = prepareDaemonAnetPin({ projectRoot: root, cliPath: cli });
    const second = prepareDaemonAnetPin({ projectRoot: root, cliPath: cli });
    expect(second).toEqual(first);
    expect(first.ANET_BIN_ABS).toBe(cli);
    expect(statSync(first.ANET_BIN_ABS).mode & 0o777).toBe(0o700);
    expect(readFileSync(first.ANET_BIN_ABS, "utf8")).toContain("console.log('ok')");
  });

  test("rejects a launcher writable by group/other", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-pin-")); roots.push(root);
    const cli = join(root, "cli.js");
    writeFileSync(cli, "original", { mode: 0o722 });
    chmodSync(cli, 0o722);
    expect(() => prepareDaemonAnetPin({ projectRoot: root, cliPath: cli })).toThrow("daemon_pin_source_writable_by_group_or_other");
  });
});
