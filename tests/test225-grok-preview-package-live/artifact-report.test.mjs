import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPrivateReport } from "./artifact-report.mjs";

function withRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), "test225-report-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertPrivateEmptyReport(report) {
  const metadata = lstatSync(report);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.size, 0);
}

test("atomically replaces an existing 0664 report", () => withRoot((root) => {
  const report = join(root, "report.txt");
  writeFileSync(report, "stale-report\n");
  chmodSync(report, 0o664);
  createPrivateReport(report);
  assertPrivateEmptyReport(report);
}));

test("replaces a symlink without changing its target", () => withRoot((root) => {
  const target = join(root, "target.txt");
  const report = join(root, "report.txt");
  writeFileSync(target, "symlink-target\n");
  chmodSync(target, 0o644);
  symlinkSync("target.txt", report);
  createPrivateReport(report);
  assertPrivateEmptyReport(report);
  assert.equal(readFileSync(target, "utf8"), "symlink-target\n");
  assert.equal(statSync(target).mode & 0o777, 0o644);
}));

test("replaces a FIFO without opening it", () => withRoot((root) => {
  const report = join(root, "report.txt");
  execFileSync("mkfifo", [report]);
  createPrivateReport(report);
  assertPrivateEmptyReport(report);
}));

test("replaces one hardlink name without changing its peer", () => withRoot((root) => {
  const peer = join(root, "peer.txt");
  const report = join(root, "report.txt");
  writeFileSync(peer, "hardlink-peer\n");
  linkSync(peer, report);
  const peerInode = statSync(peer).ino;
  createPrivateReport(report);
  assertPrivateEmptyReport(report);
  assert.equal(readFileSync(peer, "utf8"), "hardlink-peer\n");
  assert.equal(statSync(peer).ino, peerInode);
  assert.equal(statSync(peer).nlink, 1);
  assert.notEqual(statSync(report).ino, peerInode);
}));

test("preserves a parent-directory trailing newline", () => withRoot((root) => {
  const actualParent = join(root, "parent\n");
  const truncatedParent = join(root, "parent");
  mkdirSync(actualParent);
  mkdirSync(truncatedParent);
  writeFileSync(join(truncatedParent, "sentinel"), "unchanged\n");
  const report = join(actualParent, "report.txt");
  createPrivateReport(report);
  assertPrivateEmptyReport(report);
  assert.equal(readFileSync(join(truncatedParent, "sentinel"), "utf8"), "unchanged\n");
  assert.equal(existsSync(join(truncatedParent, "report.txt")), false);
}));

test("cross-filesystem staging fails without copying or leaving a temp", () => withRoot((root) => {
  const crossRoot = mkdtempSync("/dev/shm/test225-report-");
  try {
    assert.notEqual(statSync(root).dev, statSync(crossRoot).dev);
    const report = join(root, "report.txt");
    assert.throws(
      () => createPrivateReport(report, { temporaryDirectory: crossRoot }),
      (error) => error?.code === "EXDEV",
    );
    assert.equal(existsSync(report), false);
    assert.deepEqual(readdirSync(crossRoot), []);
  } finally {
    rmSync(crossRoot, { recursive: true, force: true });
  }
}));
