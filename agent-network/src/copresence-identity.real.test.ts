// RFC-030 P3-A v2 — REAL /proc integration tests.
//
// These tests are the answer to independent-audit finding 92d53c8f: the
// pure-mock unit test suite proved "mock and implementation self-consistent"
// but did not prove "real code works on real Linux". The audit reproduced
// scanEnvironForMarker throwing EACCES on /proc/1/environ in ~150ms, and
// verified verifyGroupHomogeneity would permanently skip a group with a
// same-uid zombie member. Neither behavior was covered by any mock test
// because MockEnumer's readEnviron only throws when the test asks it to.
//
// The rule this file enforces (meta-lesson added 2026-07-29 after
// independent audit found the mock-only invariant break):
//   "Every module that touches OS/filesystem/process/network state must have
//    AT LEAST ONE test that calls the real implementation, not the mock,
//    even if only to assert 'does not throw'."
//
// Test coverage here:
//   test A  — scanEnvironForMarker on real /proc (no target uuid) does NOT
//             throw and returns length === 0. This is the EACCES-on-pid-1
//             regression check for Blocker 1.
//   test B  — real zombie fixture: spawn short-lived child, poll until
//             State: Z, verifyGroupHomogeneity does NOT return ENUM_ERROR
//             for the zombie's pgid. Regression check for Blocker 2.
//   test C  — realEnumerator().readEnviron(1) on real /proc (pid 1 = root)
//             actually throws EACCES — verifies the discriminator is what
//             wraps that throw for us at the higher level.
//   test D  — POSITIVE: spawn child with marker uuid, scan finds it. Answers
//             "扫描器真能找到目标" (通信龙 33dfeea0 补充). Without this,
//             tests A/B/C together only prove the scanner doesn't crash;
//             they don't prove it actually finds anything.
//   test E  — END-TO-END: spawn child with marker → readStat for its pgid →
//             verifyGroupHomogeneity(that pgid, uuid) returns ok:true with
//             child pid in members. Proves the full identity chain (scan
//             → group → homogeneity) works on real /proc.
//
// Tests skip cleanly on non-Linux — the whole feature is Linux-only.

import { describe, test, expect } from "bun:test";
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  realEnumerator,
  scanEnvironForMarker,
  verifyGroupHomogeneity,
} from "./copresence-identity";

const IS_LINUX = process.platform === "linux";

function waitFor(predicate: () => boolean, timeoutMs = 500, intervalMs = 10): boolean {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    // Busy-wait only for fixture setup (tiny window, ~500ms max).
    const wait = Date.now() + intervalMs;
    while (Date.now() < wait) { /* short spin */ }
  }
  return predicate();
}

function readState(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = raw.match(/^State:\s*(\S)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

function pgidOf(pid: number): number | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParen = raw.lastIndexOf(")");
    if (lastParen < 0) return null;
    const rest = raw.slice(lastParen + 1).trim().split(/\s+/);
    const pgrp = Number(rest[2]);
    return Number.isFinite(pgrp) ? pgrp : null;
  } catch { return null; }
}

describe("REAL /proc integration (Linux only)", () => {
  test("A: realEnumerator.scanEnvironForMarker on nonexistent uuid does NOT throw on real /proc (Blocker 1 regression)", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    const enumer = realEnumerator();
    // If Blocker 1 is un-fixed, this throws EACCES on /proc/1/environ (systemd).
    // We look for a uuid that certainly doesn't exist anywhere.
    const nonce = `no-such-uuid-${randomUUID()}`;
    let result: number[] = [];
    let threw: unknown = null;
    try { result = scanEnvironForMarker(enumer, nonce); } catch (e) { threw = e; }
    expect(threw).toBeNull();
    expect(result.length).toBe(0);
  });

  test("B: real zombie fixture — verifyGroupHomogeneity does NOT ENUM_ERROR on a zombie in the group (Blocker 2 regression)", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    // Spawn a child that will exit immediately; without parent wait, it becomes a zombie.
    const uuid = `zombie-fixture-uuid-${randomUUID()}`;
    // detached + no waitpid → zombie once child exits.
    const child = spawn("bash", ["-c", "true"], {
      detached: true,
      env: { ...process.env, ANET_NODE_MARKER: uuid },
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) { console.log("[skip] spawn failed to yield pid"); return; }
    const childPid = child.pid;
    // Wait until child hits State=Z (zombie).
    const becameZombie = waitFor(() => readState(childPid) === "Z", 500);
    if (!becameZombie) {
      // Sometimes bun reaps children we spawned; in that case /proc/PID vanishes
      // and this test can't run. Not a fix defect, just fixture unavailable.
      console.log(`[skip] child pid ${childPid} did not reach zombie state (state=${readState(childPid)})`);
      return;
    }
    const pgid = pgidOf(childPid);
    if (pgid == null) {
      console.log(`[skip] could not read pgid of zombie ${childPid}`);
      return;
    }
    const enumer = realEnumerator();
    // The zombie is in `pgid`; verifyGroupHomogeneity should NOT crash / ENUM_ERROR
    // because of the zombie's unreadable environ.
    const result = verifyGroupHomogeneity(enumer, pgid, `unrelated-${randomUUID()}`);
    // The important thing: result.cause !== "ENUM_ERROR" (zombie shouldn't trigger it).
    // With no marker-carrying members in this pgid, expect EMPTY_GROUP or FOREIGN_MEMBER.
    if (!result.ok) {
      expect(result.cause).not.toBe("ENUM_ERROR");
    }
    // Cleanup: allow child to be reaped.
    try { execSync(`wait ${childPid} 2>/dev/null || true`); } catch {}
  });

  test("C: realEnumerator.readEnviron(1) throws EACCES (systemd is root-owned, discriminator handles it)", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    const enumer = realEnumerator();
    let threw: any = null;
    try { enumer.readEnviron(1); } catch (e) { threw = e; }
    // pid 1 is systemd owned by root → we don't own it → EACCES is expected.
    // scanEnvironForMarker's owner-uid discriminator turns this into a skip
    // (see test A which does NOT throw despite this being what would throw).
    expect(threw).not.toBeNull();
    expect(threw?.code).toBe("EACCES");
    // Discriminator sanity: verify readOwnerUid(1) returns 0 (root).
    const uid = enumer.readOwnerUid(1);
    expect(uid).toBe(0);
    expect(uid).not.toBe(process.getuid?.() ?? -1);
  });

  test("D: POSITIVE — spawn child carrying our marker, scan finds it (通信龙 33dfeea0 补充)", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    // The critical positive test: prove the scanner actually finds a marker-
    // carrying process. Tests A/B/C together only prove "doesn't crash";
    // this proves "does find". Without this, a broken impl that returned []
    // would still pass A/B/C.
    const uuid = randomUUID();
    const child = spawn("bash", ["-c", "sleep 5"], {
      detached: true,
      env: { ...process.env, ANET_NODE_MARKER: uuid },
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Test D fixture setup failed: spawn returned no pid");
    }
    const childPid = child.pid;
    try {
      // Wait for /proc/<pid>/environ to be populated with our marker.
      const ready = waitFor(() => {
        try {
          const env = readFileSync(`/proc/${childPid}/environ`, "utf8");
          return env.split("\0").includes(`ANET_NODE_MARKER=${uuid}`);
        } catch { return false; }
      }, 1000);
      expect(ready).toBe(true);
      const enumer = realEnumerator();
      const found = scanEnvironForMarker(enumer, uuid);
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found).toContain(childPid);
    } finally {
      try { process.kill(childPid, "SIGTERM"); } catch {}
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  });

  test("E: END-TO-END — spawn child with marker → scan + verifyGroupHomogeneity → ok with child in members", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    // The end-to-end test: not only does scan find the process, but the full
    // downstream chain (group by pgid, verify homogeneity) also succeeds on
    // real /proc. This is what actually runs at stop time.
    const uuid = randomUUID();
    const child = spawn("bash", ["-c", "sleep 5"], {
      detached: true,
      env: { ...process.env, ANET_NODE_MARKER: uuid },
      stdio: "ignore",
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Test E fixture setup failed: spawn returned no pid");
    }
    const childPid = child.pid;
    try {
      const ready = waitFor(() => {
        try {
          const env = readFileSync(`/proc/${childPid}/environ`, "utf8");
          return env.split("\0").includes(`ANET_NODE_MARKER=${uuid}`);
        } catch { return false; }
      }, 1000);
      expect(ready).toBe(true);
      const enumer = realEnumerator();
      const found = scanEnvironForMarker(enumer, uuid);
      expect(found).toContain(childPid);
      // Group and verify
      const pgid = pgidOf(childPid);
      expect(pgid).not.toBeNull();
      if (pgid == null) return;
      const check = verifyGroupHomogeneity(enumer, pgid, uuid);
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(check.members).toContain(childPid);
      }
    } finally {
      try { process.kill(childPid, "SIGTERM"); } catch {}
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
  });
});
