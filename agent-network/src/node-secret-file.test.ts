// #2056 — `anet node secret` reads names only. Every value below is a sentinel;
// the test fails if any returned string contains it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_SECRET_KEYS_MAX, nodeSecretFileModeWarning, readNodeSecretKeys } from "./node-secret-file.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "anet-node-secret-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {} } });

const SENTINEL = "sentinel-value-DO-NOT-PRINT-3f8a";

test("missing file → kind=missing (not an error)", () => {
  expect(readNodeSecretKeys(mk())).toEqual({ kind: "missing" });
});

test("names only, sorted, values never returned", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), [`ZULU_KEY=${SENTINEL}`, `ALPHA_KEY=${SENTINEL}`, "# comment", ""].join("\n"));
  const r = readNodeSecretKeys(d);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.keys).toEqual(["ALPHA_KEY", "ZULU_KEY"]);
  expect(JSON.stringify(r)).not.toContain(SENTINEL);
});

test("reserved keys and malformed names are skipped", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), ["PATH=/usr/bin", "LD_PRELOAD=/x", "lower=v", "A-B=v", "OK_KEY=v", "NOEQUALS"].join("\n"));
  const r = readNodeSecretKeys(d);
  expect(r.kind === "ok" ? r.keys : []).toEqual(["OK_KEY"]);
});

test("symlinked secrets.env is refused, not followed", () => {
  const d = mk();
  const target = mk();
  writeFileSync(join(target, "secrets.env"), "SECRET_KEY=v");
  symlinkSync(join(target, "secrets.env"), join(d, "secrets.env"));
  const r = readNodeSecretKeys(d);
  expect(r.kind).toBe("unsafe");
  if (r.kind === "unsafe") expect(r.reason).toContain("symlink");
});

test("cap", () => {
  const d = mk();
  const lines: string[] = [];
  for (let i = 0; i < NODE_SECRET_KEYS_MAX + 5; i++) lines.push(`KEY_${String(i).padStart(3, "0")}=v`);
  writeFileSync(join(d, "secrets.env"), lines.join("\n"));
  const r = readNodeSecretKeys(d);
  expect(r.kind === "ok" ? r.keys.length : 0).toBe(NODE_SECRET_KEYS_MAX);
});

test("mode warning only when the loader would refuse it", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), "A_KEY=v", { mode: 0o600 });
  chmodSync(join(d, "secrets.env"), 0o600);
  expect(nodeSecretFileModeWarning(d)).toBeNull();
  chmodSync(join(d, "secrets.env"), 0o644);
  expect(nodeSecretFileModeWarning(d)).toContain("mode 644");
});
