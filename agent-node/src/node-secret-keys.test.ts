// #1474 — the node reports KEY NAMES only. The load-bearing assertion is that
// no value can escape: every fixture value here is a sentinel, and the test
// fails if any returned string contains it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSecretKeys, SECRET_KEYS_MAX } from "./node-secret-keys.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "anet-secretkeys-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {} } });

test("missing file → no keys, no throw", () => {
  expect(collectSecretKeys(mk())).toEqual([]);
});

test("no node dir → no keys", () => {
  expect(collectSecretKeys(undefined)).toEqual([]);
  expect(collectSecretKeys(null)).toEqual([]);
  expect(collectSecretKeys("")).toEqual([]);
});

test("returns sorted key names, and never a value", () => {
  const d = mk();
  const SENTINEL = "sentinel-value-DO-NOT-REPORT-7c1f";
  writeFileSync(join(d, "secrets.env"), [
    `ZULU_KEY=${SENTINEL}`,
    `ALPHA_KEY=${SENTINEL}`,
    "# a comment",
    `MID_KEY=${SENTINEL}`,
  ].join("\n"));
  const keys = collectSecretKeys(d);
  expect(keys).toEqual(["ALPHA_KEY", "MID_KEY", "ZULU_KEY"]);
  for (const k of keys) expect(k).not.toContain(SENTINEL);
  // Strong form: serialising the whole result must not contain the value.
  expect(JSON.stringify(keys)).not.toContain(SENTINEL);
});

test("reserved keys are skipped (they are not secrets)", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), ["PATH=/usr/bin", "LD_PRELOAD=/x.so", "REAL_SECRET=v"].join("\n"));
  expect(collectSecretKeys(d)).toEqual(["REAL_SECRET"]);
});

test("malformed names are skipped rather than reported", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), ["lower_case=v", "WITH-DASH=v", "OK_KEY=v"].join("\n"));
  expect(collectSecretKeys(d)).toEqual(["OK_KEY"]);
});

test("a symlinked secrets.env is not followed", () => {
  const d = mk();
  const target = mk();
  writeFileSync(join(target, "secrets.env"), "SECRET_KEY=v");
  symlinkSync(join(target, "secrets.env"), join(d, "secrets.env"));
  expect(collectSecretKeys(d)).toEqual([]);
});

test("the list is capped", () => {
  const d = mk();
  const lines: string[] = [];
  for (let i = 0; i < SECRET_KEYS_MAX + 10; i++) lines.push(`KEY_${String(i).padStart(3, "0")}=v`);
  writeFileSync(join(d, "secrets.env"), lines.join("\n"));
  const keys = collectSecretKeys(d);
  expect(keys).toHaveLength(SECRET_KEYS_MAX);
  expect(keys[0]).toBe("KEY_000");
});
