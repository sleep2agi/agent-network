// #2056 — `anet node secret` reads names only. Every value below is a sentinel;
// the test fails if any returned string contains it.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_SECRET_KEYS_MAX, nodeSecretFileModeWarning, readNodeSecretKeys, removeNodeSecret, writeNodeSecret } from "./node-secret-file.js";

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

// ── 写面（set / unset）─────────────────────────────────────────────────
const readRaw = (d: string) => readFileSync(join(d, "secrets.env"), "utf8");

test("set creates the file with mode 0600 and appends", () => {
  const d = mk();
  expect(writeNodeSecret(d, "ALPHA_KEY", "v1")).toEqual({ kind: "ok", changed: true });
  expect(readRaw(d)).toContain("ALPHA_KEY=v1");
  expect(lstatSync(join(d, "secrets.env")).mode & 0o777).toBe(0o600);
});

test("set replaces in place and keeps comments / other keys", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), "# my keys\nALPHA_KEY=old\nZULU_KEY=z\n", { mode: 0o600 });
  writeNodeSecret(d, "ALPHA_KEY", "new");
  const raw = readRaw(d);
  expect(raw).toContain("# my keys");
  expect(raw).toContain("ALPHA_KEY=new");
  expect(raw).toContain("ZULU_KEY=z");
  expect(raw).not.toContain("ALPHA_KEY=old");
  // 位置不变（第一行注释之后仍是 ALPHA）
  expect(raw.split("\n")[1]).toBe("ALPHA_KEY=new");
});

test("set collapses duplicate keys instead of letting the last one win silently", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), "A_KEY=one\nA_KEY=two\n", { mode: 0o600 });
  writeNodeSecret(d, "A_KEY", "three");
  const lines = readRaw(d).trim().split("\n");
  expect(lines).toEqual(["A_KEY=three"]);
});

test("set quotes values the loader would otherwise mangle", () => {
  const d = mk();
  writeNodeSecret(d, "A_KEY", "has space");
  expect(readRaw(d)).toContain('A_KEY="has space"');
});

test("set rejects reserved keys, bad names and multi-line values (and writes nothing)", () => {
  const d = mk();
  expect(writeNodeSecret(d, "PATH", "x").kind).toBe("rejected");
  expect(writeNodeSecret(d, "lower", "x").kind).toBe("rejected");
  expect(writeNodeSecret(d, "OK_KEY", "a\nb").kind).toBe("rejected");
  expect(existsSync(join(d, "secrets.env"))).toBe(false);
});

test("set refuses to write through a symlink", () => {
  const d = mk();
  const target = mk();
  writeFileSync(join(target, "secrets.env"), "OTHER=v\n", { mode: 0o600 });
  symlinkSync(join(target, "secrets.env"), join(d, "secrets.env"));
  const r = writeNodeSecret(d, "A_KEY", "x");
  expect(r.kind).toBe("rejected");
  expect(readFileSync(join(target, "secrets.env"), "utf8")).toBe("OTHER=v\n");
});

test("unset removes only that key; absent key reports unchanged", () => {
  const d = mk();
  writeFileSync(join(d, "secrets.env"), "A_KEY=1\nB_KEY=2\n", { mode: 0o600 });
  expect(removeNodeSecret(d, "A_KEY")).toEqual({ kind: "ok", changed: true });
  expect(readRaw(d)).toBe("B_KEY=2\n");
  expect(removeNodeSecret(d, "A_KEY")).toEqual({ kind: "ok", changed: false });
});

test("no temp file is left behind", () => {
  const d = mk();
  writeNodeSecret(d, "A_KEY", "v");
  const leftovers = readdirSync(d).filter(n => n.includes(".tmp-"));
  expect(leftovers).toEqual([]);
});
