import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RETENTION_MS,
  sweepDeletedOnce,
  _stopDeletedSweeperForTest,
} from "./deleted-sweeper";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// RFC-027 §5.2 scenario K — 30d backup sweeper真物理删, plus the
// underlying invariants: chmod 700 preserved + no file-name logged.

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "deleted-sweeper-"));
});
afterEach(() => {
  _stopDeletedSweeperForTest();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function seedBackup(deletedRoot: string, ts: number, alias: string, secretBody = "ntok_sensitive") {
  const dirName = `${ts}-${alias}`;
  const dir = join(deletedRoot, dirName);
  mkdirSync(deletedRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  // Plant a "secret" file inside to verify the sweeper's filename-leak
  // guard (we log only the dir-name, never inner files).
  writeFileSync(join(dir, "config.json"), JSON.stringify({ token: secretBody }), { mode: 0o600 });
  chmodSync(dir, 0o700);
  return dir;
}

describe("RFC-027 §5.2 K — sweeper purges 30d+ backups (physical delete, no soft state)", () => {
  test("backup older than RETENTION_MS → physically removed", () => {
    const deletedRoot = join(scratch, "deleted");
    const now = Date.now();
    const oldTs = now - RETENTION_MS - 86_400_000;   // 31 days ago
    const dir = seedBackup(deletedRoot, oldTs, "alias-old");
    expect(statSync(dir).isDirectory()).toBe(true);

    const r = sweepDeletedOnce({ deletedRoot, now });
    expect(r.purged.length).toBe(1);
    expect(r.purged[0].name).toBe(`${oldTs}-alias-old`);
    expect(r.purged[0].age_days).toBeGreaterThanOrEqual(30);
    expect(r.errors).toBe(0);
    // Dir truly gone (recursive fs.rm with force, per D7 nit).
    expect(readdirSync(deletedRoot)).not.toContain(`${oldTs}-alias-old`);
  });

  test("backup younger than 30d → KEPT", () => {
    const deletedRoot = join(scratch, "deleted");
    const now = Date.now();
    const recentTs = now - 7 * 86_400_000;   // 7 days ago
    seedBackup(deletedRoot, recentTs, "alias-recent");

    const r = sweepDeletedOnce({ deletedRoot, now });
    expect(r.purged.length).toBe(0);
    expect(r.scanned).toBe(1);
    expect(readdirSync(deletedRoot)).toContain(`${recentTs}-alias-recent`);
  });

  test("mixed: 2 old + 1 recent → only the 2 olds purged", () => {
    const deletedRoot = join(scratch, "deleted");
    const now = Date.now();
    seedBackup(deletedRoot, now - RETENTION_MS - 100_000, "a1");
    seedBackup(deletedRoot, now - RETENTION_MS - 5_000_000, "a2");
    seedBackup(deletedRoot, now - 24 * 60 * 60_000, "a3");   // 1 day ago

    const r = sweepDeletedOnce({ deletedRoot, now });
    expect(r.purged.length).toBe(2);
    expect(r.scanned).toBe(3);
    const remaining = readdirSync(deletedRoot);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toMatch(/-a3$/);
  });
});

describe("sweeper safety invariants (D7 nit)", () => {
  test("skips dir names that don't match <ts>-<alias> pattern (no accidental purge)", () => {
    const deletedRoot = join(scratch, "deleted");
    mkdirSync(deletedRoot, { recursive: true });
    mkdirSync(join(deletedRoot, "not-a-ts-prefix-dir"));
    mkdirSync(join(deletedRoot, "1234-too-short-ts"));   // 4-digit ts < 10 digits = invalid
    mkdirSync(join(deletedRoot, "12-no-dash-suffix"));

    const r = sweepDeletedOnce({ deletedRoot, now: Date.now() });
    expect(r.purged.length).toBe(0);
    expect(readdirSync(deletedRoot).length).toBe(3);   // all kept untouched
  });

  test("log function receives ONLY the dir name — never any inner file path", () => {
    const deletedRoot = join(scratch, "deleted");
    const now = Date.now();
    const oldTs = now - RETENTION_MS - 100_000;
    seedBackup(deletedRoot, oldTs, "alias-leaky", "VERY-SECRET-TOKEN-DO-NOT-LEAK");

    const logged: string[] = [];
    sweepDeletedOnce({
      deletedRoot, now,
      log: (m) => logged.push(m),
    });
    // The dir name itself MAY be in logs (that's our top-level audit
    // record). What we mustn't see is any file content / filename.
    const joined = logged.join("\n");
    expect(joined).not.toContain("config.json");
    expect(joined).not.toContain("VERY-SECRET-TOKEN");
    expect(joined).toContain(`${oldTs}-alias-leaky`);   // dir name = OK
  });

  test("dir-listing error (deletedRoot missing) → returns clean empty result, no throw", () => {
    const deletedRoot = join(scratch, "does-not-exist");
    const r = sweepDeletedOnce({ deletedRoot, now: Date.now() });
    expect(r.purged.length).toBe(0);
    expect(r.scanned).toBe(0);
    expect(r.errors).toBe(0);
  });

  test("rmDir throw → counted as error, sweep continues for siblings", () => {
    const deletedRoot = join(scratch, "deleted");
    const now = Date.now();
    seedBackup(deletedRoot, now - RETENTION_MS - 100_000, "good");
    seedBackup(deletedRoot, now - RETENTION_MS - 200_000, "bad");
    // Inject rmDir that fails for the 'bad' dir but succeeds for 'good'.
    const r = sweepDeletedOnce({
      deletedRoot, now,
      rmDir: (p) => {
        if (p.endsWith("-bad")) throw new Error("simulated EACCES");
        rmSync(p, { recursive: true, force: true });
      },
    });
    expect(r.errors).toBe(1);
    expect(r.purged.length).toBe(1);
    expect(readdirSync(deletedRoot).filter(n => n.endsWith("-bad")).length).toBe(1);   // bad stayed
  });
});
