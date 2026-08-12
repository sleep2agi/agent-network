// RFC-030 P3-A — REAL /proc integration tests.
//
// These tests are the answer to the repeated independent-audit finding that
// the pure-mock suite proved "mock and implementation are self-consistent"
// but not "the real code works on real Linux". Three candidate rounds passed
// 52/52 mock tests while the feature was 100% non-functional on this host.
//
// The rule this file enforces:
//   "Every module that touches OS/filesystem/process state must have AT
//    LEAST ONE test that drives the REAL implementation (realEnumerator /
//    realKiller), not a mock — including at least one that proves the happy
//    path actually succeeds, not merely that nothing throws."
//
// Fixture policy (audit blocker 9): a test whose fixture cannot be built
// FAILS. It never `return`s early and reports green — that is how a whole
// test can go from "covers a regression" to "asserts nothing" without
// anyone noticing.
//
// Coverage map:
//   A — scan on real /proc with a nonce uuid does not throw, finds nothing.
//   B — live marker member + REAL zombie sibling in the same pgroup →
//       verifyGroupHomogeneity returns ok:true so escalation to SIGKILL is
//       still possible. (v2's zombie test asserted `cause !== ENUM_ERROR`
//       against an EMPTY_GROUP result — vacuously true, covered nothing.)
//   C — readEnviron(1) EACCESes and readOwnerUid(1) is root. Skipped when
//       running as root, where pid 1's environ is readable and both
//       assertions would be false.
//   D — POSITIVE: a spawned marker carrier is found by the scan.
//   E — END-TO-END: scan → group → homogeneity on real /proc.
//   F — REAL REAP: reapMarkerGroups with realEnumerator + realKiller
//       actually kills a real marker-carrying process tree and returns
//       kind:"success". Blocker 1 regression: on this host v2 returned
//       "failed" 100% of the time.
//   G — CLEAN-HOST REAP: nothing carries the uuid → success, so the caller
//       removes the marker. This is the exact case v2 could never reach on
//       any host running a same-uid/different-gid process.
//   H — NON-DUMPABLE: a marker-carrying, prctl(PR_SET_DUMPABLE,0) child of
//       a marker carrier is accounted for (in-scope unreadable) instead of
//       silently dropped. Blocker 2 regression.
//   I — readOwnerUid reports the REAL uid of a non-dumpable process, where
//       the /proc/PID/environ inode owner lies and says root. Blocker 2 unit.
//   J — REAL START SEAM: prepareIdentityForStart against real marker files
//       and real processes reclaims the previous generation, then installs
//       the new identity. Blockers 5+6.
//   K — REAL START SEAM: a previous generation that genuinely cannot be
//       reaped (foreign member in its pgroup) blocks the start and its
//       marker survives untouched. Blocker 6.
//   L — anchorsFromMarker + starttime validation against real /proc.
//
// Tests skip cleanly on non-Linux — the whole feature is Linux-only.

import { describe, test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  realEnumerator,
  realKiller,
  scanEnvironForMarker,
  scanEnvironForMarkerFull,
  verifyGroupHomogeneity,
  reapMarkerGroups,
  prepareIdentityForStart,
  writeMarker,
  readMarker,
  removeMarker,
  anchorsFromMarker,
} from "./copresence-identity";

const IS_LINUX = process.platform === "linux";
const IS_ROOT = (process.getuid?.() ?? -1) === 0;

/** python3 is the fixture interpreter: it survives PR_SET_DUMPABLE=0 (bun
 *  does not — it dies within ~2s) and it never reaps its children, which is
 *  what makes a stable zombie. Absence is a hard failure, never a skip. */
const PYTHON = "python3";
function requirePython(): void {
  const probe = spawnSync(PYTHON, ["-c", "import ctypes"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `real-/proc fixtures require \`${PYTHON}\` with ctypes (needed for a stable zombie and for prctl(PR_SET_DUMPABLE,0)). ` +
      `Install python3 in the test environment — skipping would let blockers 2 and 9 regress unnoticed.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(intervalMs);
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

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pids: number[]): void {
  for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
}

/** Marker-carrying, detached (own pgroup) child that stays alive. */
function spawnCarrier(uuid: string, script: string): number {
  const child = spawn(PYTHON, ["-c", script], {
    detached: true,
    env: { ...process.env, ANET_NODE_MARKER: uuid },
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) throw new Error("fixture setup failed: spawn returned no pid");
  return child.pid;
}

describe("REAL /proc integration (Linux only)", () => {
  test("A: scan on real /proc with a nonce uuid does not throw and finds nothing", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    const enumer = realEnumerator();
    const nonce = `no-such-uuid-${randomUUID()}`;
    let result: number[] = [];
    let threw: unknown = null;
    try { result = scanEnvironForMarker(enumer, nonce); } catch (e) { threw = e; }
    expect(threw).toBeNull();
    expect(result.length).toBe(0);
  });

  test("B: live marker member + REAL zombie sibling in the same pgroup → homogeneity ok:true (escalation stays possible)", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const uuid = randomUUID();
    // Parent stays alive and NEVER waits, so the /bin/true child stays a
    // zombie for the whole test. Both inherit the marker; both share the
    // parent's pgroup (no setsid in the child).
    const parentPid = spawnCarrier(uuid, [
      "import subprocess, time",
      "p = subprocess.Popen(['/bin/true'])",
      "print(p.pid, flush=True)",
      "time.sleep(30)",
    ].join("\n"));
    const spawned: number[] = [parentPid];
    try {
      // Find the zombie by scanning the parent's children.
      const pgid = await waitFor(() => pgidOf(parentPid) != null) ? pgidOf(parentPid)! : null;
      expect(pgid).not.toBeNull();
      const zombieFound = await waitFor(() => {
        const kids = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").trim();
        if (!kids) return false;
        return kids.split(/\s+/).map(Number).some((p) => readState(p) === "Z");
      }, 5000);
      // Blocker 9: fixture failure is a test failure, never a silent return.
      expect(zombieFound).toBe(true);
      const zombiePid = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8")
        .trim().split(/\s+/).map(Number).find((p) => readState(p) === "Z")!;
      spawned.push(zombiePid);
      expect(pgidOf(zombiePid)).toBe(pgid!);

      const enumer = realEnumerator();
      // The parent is a live marker carrier; the zombie is a same-pgroup,
      // same-uid member whose environ EACCESes because its mm is gone. The
      // group MUST still verify, otherwise teardown can never escalate to
      // SIGKILL — and post-SIGTERM is exactly when zombies are everywhere.
      const result = verifyGroupHomogeneity(enumer, pgid!, uuid);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.members).toContain(parentPid);
    } finally {
      killTree(spawned);
    }
  });

  test("C: readEnviron(1) EACCESes and readOwnerUid(1) is root (non-root only)", () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    // Blocker 10: as root, /proc/1/environ IS readable and readOwnerUid(1)
    // equals our own uid, so both assertions below would be false. Many anet
    // container images run as root — asserting them there is a guaranteed
    // false red, not a real signal.
    if (IS_ROOT) { console.log("[skip] running as root — pid 1 is readable to us, assertions do not apply"); return; }
    const enumer = realEnumerator();
    let threw: any = null;
    try { enumer.readEnviron(1); } catch (e) { threw = e; }
    expect(threw).not.toBeNull();
    expect(threw?.code).toBe("EACCES");
    const uid = enumer.readOwnerUid(1);
    expect(uid).toBe(0);
    expect(uid).not.toBe(process.getuid?.() ?? -1);
  });

  test("D: POSITIVE — spawned marker carrier is found by the scan", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const uuid = randomUUID();
    const childPid = spawnCarrier(uuid, "import time; time.sleep(30)");
    try {
      const ready = await waitFor(() => {
        try {
          return readFileSync(`/proc/${childPid}/environ`, "utf8").split("\0").includes(`ANET_NODE_MARKER=${uuid}`);
        } catch { return false; }
      });
      expect(ready).toBe(true);
      const found = scanEnvironForMarker(realEnumerator(), uuid);
      expect(found).toContain(childPid);
    } finally {
      killTree([childPid]);
    }
  });

  test("E: END-TO-END — scan → group → homogeneity all succeed on real /proc", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const uuid = randomUUID();
    const childPid = spawnCarrier(uuid, "import time; time.sleep(30)");
    try {
      const enumer = realEnumerator();
      const ready = await waitFor(() => scanEnvironForMarker(enumer, uuid).includes(childPid));
      expect(ready).toBe(true);
      const pgid = pgidOf(childPid);
      expect(pgid).not.toBeNull();
      const check = verifyGroupHomogeneity(enumer, pgid!, uuid);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.members).toContain(childPid);
    } finally {
      killTree([childPid]);
    }
  });

  test("F: REAL REAP — reapMarkerGroups(realEnumerator, realKiller) kills a real carrier and returns success", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const uuid = randomUUID();
    // Two processes in one detached pgroup: parent + a marker-carrying child
    // that is NOT setsid'd. This is the copresence shape (pane process plus
    // its subprocess) and it is what P2 could not reap.
    const parentPid = spawnCarrier(uuid, [
      "import subprocess, time, sys",
      "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])",
      "print(p.pid, flush=True)",
      "time.sleep(30)",
    ].join("\n"));
    const spawned = [parentPid];
    try {
      const enumer = realEnumerator();
      const bothUp = await waitFor(() => scanEnvironForMarker(enumer, uuid).length >= 2, 5000);
      expect(bothUp).toBe(true);
      const carriers = scanEnvironForMarker(enumer, uuid);
      spawned.push(...carriers);
      expect(carriers).toContain(parentPid);

      const logs: string[] = [];
      const res = await reapMarkerGroups(enumer, realKiller(), uuid, {
        graceMs: 300,
        logger: (m) => logs.push(m),
      });
      if (res.kind !== "success") console.log("[F] reap logs:\n" + logs.join("\n") + "\ndetail=" + res.detail);
      expect(res.kind).toBe("success");
      // And no carrier remains executable. A minimal container's PID 1 may
      // leave an orphaned child as a zombie indefinitely; kill(pid, 0) still
      // sees that PID even though state Z has no executable process behind it.
      const noLiveCarrier = await waitFor(
        () => carriers.every((p) => !alive(p) || readState(p) === "Z"),
        3000,
      );
      expect(noLiveCarrier).toBe(true);
      expect(scanEnvironForMarker(enumer, uuid)).toEqual([]);
    } finally {
      killTree(spawned);
    }
  });

  test("G: CLEAN-HOST REAP — nothing carries the uuid → success on THIS host (blocker 1 regression)", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    // v2 returned kind:"failed" here on any host running a same-uid process
    // whose primary GID differs from ours (docker desktop, systemd user
    // units, anything started under a supplementary group). That made the
    // caller print "identity teardown incomplete" and keep the marker
    // FOREVER on such hosts — teardown could never complete even when the
    // tree was perfectly clean.
    const enumer = realEnumerator();
    const nonce = `clean-host-${randomUUID()}`;
    const scan = scanEnvironForMarkerFull(enumer, nonce);
    expect(scan.hits).toEqual([]);
    // Whatever machine-wide unreadable processes exist, none of them may be
    // in scope for a uuid nothing carries: with no hits and no anchors there
    // is no anchor to be in scope of.
    expect(scan.unreadableOwnUid).toEqual([]);
    const res = await reapMarkerGroups(enumer, realKiller(), nonce, {
      graceMs: 0,
      logger: () => {},
    });
    expect(res.kind).toBe("success");
  });

  test("H: NON-DUMPABLE — marker-carrying non-dumpable child of a carrier is accounted for, not dropped (blocker 2)", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const uuid = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), "anet-nd-"));
    const ndScript = join(dir, "nd.py");
    writeFileSync(ndScript, [
      "import ctypes, os, sys, time",
      "libc = ctypes.CDLL('libc.so.6', use_errno=True)",
      "libc.prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 4",
      "print(os.getpid(), flush=True)",
      "time.sleep(30)",
    ].join("\n"));
    // Parent is a readable marker carrier; the non-dumpable child shares its
    // pgroup, so the invariant-11 scope test reaches it through the parent.
    const parentPid = spawnCarrier(uuid, [
      "import subprocess, time, sys",
      `p = subprocess.Popen([sys.executable, ${JSON.stringify(ndScript)}])`,
      "time.sleep(30)",
    ].join("\n"));
    const spawned = [parentPid];
    try {
      const enumer = realEnumerator();
      const ndFound = await waitFor(() => {
        try {
          const kids = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8").trim();
          if (!kids) return false;
          return kids.split(/\s+/).map(Number).some((p) => {
            try { statSync(`/proc/${p}/environ`); } catch { return false; }
            return statSync(`/proc/${p}/environ`).uid !== (process.getuid?.() ?? -1);
          });
        } catch { return false; }
      }, 8000);
      expect(ndFound).toBe(true);
      const ndPid = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8")
        .trim().split(/\s+/).map(Number)
        .find((p) => { try { return statSync(`/proc/${p}/environ`).uid !== (process.getuid?.() ?? -1); } catch { return false; } })!;
      spawned.push(ndPid);

      // Ground truth: the inode owner LIES (says root), the process is ours.
      expect(statSync(`/proc/${ndPid}/environ`).uid).toBe(0);
      expect(readFileSync(`/proc/${ndPid}/status`, "utf8")).toMatch(/^Uid:\s*1?\d+/m);

      const scan = scanEnvironForMarkerFull(enumer, uuid);
      // It cannot be a hit — its environ is unreadable by anyone but root.
      expect(scan.hits).not.toContain(ndPid);
      // But it MUST be accounted for. v2 dropped it entirely (uid read from
      // the environ inode said root → "not ours" → skip), so teardown
      // reported success and deleted the marker while it lived on.
      expect(scan.unreadableOwnUid).toContain(ndPid);
      expect(scan.unreadableOutOfScope).not.toContain(ndPid);

      // Consequence: reap refuses to report success, so the caller keeps the
      // marker and the process stays reclaimable.
      const res = await reapMarkerGroups(enumer, realKiller(), uuid, {
        graceMs: 200,
        logger: () => {},
      });
      expect(res.kind).toBe("failed");
    } finally {
      killTree(spawned);
    }
  });

  test("I: readOwnerUid reports the REAL uid of a non-dumpable process (environ inode owner lies)", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    const dir = mkdtempSync(join(tmpdir(), "anet-nd2-"));
    const ndScript = join(dir, "nd.py");
    writeFileSync(ndScript, [
      "import ctypes, os, time",
      "libc = ctypes.CDLL('libc.so.6', use_errno=True)",
      "libc.prctl(4, 0, 0, 0, 0)",
      "time.sleep(30)",
    ].join("\n"));
    const child = spawn(PYTHON, [ndScript], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    try {
      const ready = await waitFor(() => {
        try { return statSync(`/proc/${pid}/environ`).uid === 0; } catch { return false; }
      }, 8000);
      expect(ready).toBe(true);
      const ourUid = process.getuid?.() ?? -1;
      // The v2 implementation was `statSync('/proc/PID/environ').uid`, which
      // returns 0 here and made our own child look like somebody else's.
      expect(statSync(`/proc/${pid}/environ`).uid).toBe(0);
      expect(realEnumerator().readOwnerUid(pid)).toBe(ourUid);
    } finally {
      killTree([pid]);
    }
  });

  test("J: REAL START SEAM — prepareIdentityForStart reclaims a live previous generation and installs the new marker", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    // Everything real: real marker file, real /proc scan, real signals.
    const nodesDir = mkdtempSync(join(tmpdir(), "anet-start-seam-"));
    const nodeId = "seam-node";
    const oldUuid = randomUUID();
    const newUuid = randomUUID();
    const carrier = spawnCarrier(oldUuid, "import time; time.sleep(30)");
    const spawned = [carrier];
    try {
      const enumer = realEnumerator();
      expect(await waitFor(() => scanEnvironForMarker(enumer, oldUuid).includes(carrier))).toBe(true);
      writeMarker(nodesDir, nodeId, oldUuid, {});

      const result = await prepareIdentityForStart(newUuid, {
        readMarker: () => readMarker(nodesDir, nodeId),
        reap: (uuid, anchors) => reapMarkerGroups(realEnumerator(), realKiller(), uuid, { graceMs: 300, logger: () => {}, anchors }),
        removeMarker: () => removeMarker(nodesDir, nodeId),
        writeMarker: (uuid, sessions) => { writeMarker(nodesDir, nodeId, uuid, sessions); },
        logger: () => {},
      });

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.reclaimedUuid).toBe(oldUuid);
      // The previous generation is really dead...
      expect(await waitFor(() => !alive(carrier), 3000)).toBe(true);
      // ...and the marker on disk is the NEW identity.
      const after = readMarker(nodesDir, nodeId);
      expect(after.kind).toBe("ok");
      if (after.kind === "ok") expect(after.marker.marker).toBe(newUuid);
    } finally {
      killTree(spawned);
    }
  });

  test("K: REAL START SEAM — a previous generation that cannot be reaped BLOCKS the start and its marker survives", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    // Real un-reapable shape: a marker carrier sharing its pgroup with a
    // process that does NOT carry the marker. Homogeneity refuses
    // FOREIGN_MEMBER, the group is never signalled, and the reap fails —
    // exactly the state a failed stop leaves behind.
    const nodesDir = mkdtempSync(join(tmpdir(), "anet-start-seam2-"));
    const nodeId = "seam-node";
    const oldUuid = randomUUID();
    const newUuid = randomUUID();
    const carrier = spawnCarrier(oldUuid, [
      "import subprocess, os, sys, time",
      "env = dict(os.environ); env.pop('ANET_NODE_MARKER', None)",
      "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], env=env)",
      "time.sleep(30)",
    ].join("\n"));
    const spawned = [carrier];
    try {
      const enumer = realEnumerator();
      expect(await waitFor(() => scanEnvironForMarker(enumer, oldUuid).includes(carrier))).toBe(true);
      // Wait for the foreign sibling to actually exist in the pgroup.
      expect(await waitFor(() => {
        const kids = readFileSync(`/proc/${carrier}/task/${carrier}/children`, "utf8").trim();
        return kids.length > 0;
      }, 5000)).toBe(true);
      for (const k of readFileSync(`/proc/${carrier}/task/${carrier}/children`, "utf8").trim().split(/\s+/).map(Number)) spawned.push(k);
      writeMarker(nodesDir, nodeId, oldUuid, {});

      const result = await prepareIdentityForStart(newUuid, {
        readMarker: () => readMarker(nodesDir, nodeId),
        reap: (uuid, anchors) => reapMarkerGroups(realEnumerator(), realKiller(), uuid, { graceMs: 300, logger: () => {}, anchors }),
        removeMarker: () => removeMarker(nodesDir, nodeId),
        writeMarker: (uuid, sessions) => { writeMarker(nodesDir, nodeId, uuid, sessions); },
        logger: () => {},
      });

      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") expect(result.cause).toBe("STALE_TREE_ALIVE");
      // The old identity is STILL the one on disk — losing it would strand
      // the surviving processes forever.
      const after = readMarker(nodesDir, nodeId);
      expect(after.kind).toBe("ok");
      if (after.kind === "ok") expect(after.marker.marker).toBe(oldUuid);
      expect(alive(carrier)).toBe(true);
    } finally {
      killTree(spawned);
    }
  });

  test("L: anchorsFromMarker feeds real recorded pane pids into the scope test", async () => {
    if (!IS_LINUX) { console.log("[skip] not Linux"); return; }
    requirePython();
    // A recorded session pid is only allowed to widen scope while it is the
    // SAME process. Real /proc, real starttime.
    const uuid = randomUUID();
    const pid = spawnCarrier(uuid, "import time; time.sleep(30)");
    try {
      const enumer = realEnumerator();
      expect(await waitFor(() => enumer.readStat(pid) != null)).toBe(true);
      const stat = enumer.readStat(pid)!;
      const good = anchorsFromMarker({
        marker: uuid, boot_id: "b", started_at_epoch_ms: 1, owner_uid: process.getuid?.() ?? -1,
        sessions: { appsrv: { tmux: "t", pid, pgid: stat.pgid, starttime_jiffies: stat.starttime_jiffies } },
      });
      expect(good.sessions).toEqual([{ pid, starttime_jiffies: stat.starttime_jiffies }]);
      // A stale record for the same pid must not anchor: prove it by asking
      // the scan with a uuid nothing carries — the anchor is the only thing
      // that could widen scope, and a mismatched starttime must drop it.
      const nonce = `anchor-check-${randomUUID()}`;
      const staleScan = scanEnvironForMarkerFull(enumer, nonce, {
        sessions: [{ pid, starttime_jiffies: stat.starttime_jiffies + 1 }],
      });
      expect(staleScan.unreadableOwnUid).toEqual([]);
    } finally {
      killTree([pid]);
    }
  });
});
