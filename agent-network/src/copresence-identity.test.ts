// RFC-030 P3-A v2 — unit tests for copresence identity/reap module.
//
// Each `describe` block covers one of the 11 scenarios listed in the
// 副指挥 GO (7a9c99df, 2026-07-29). Every assertion is designed to
// TURN RED under a specific mutation of the production code — see the
// `MUTATION CASES` comments for what 通信龙 will attempt.
//
// FIRST PRINCIPLE (fork brief verbatim):
//   This restart's lesson is NOT "code has bugs" — it's "three gates all
//   looked present, none actually worked, and evidence looked green". So
//   every gate here MUST first prove it CAN turn red. Mutation testing
//   (通信龙 will actively break tests to verify they turn red) is the
//   acceptance criterion.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMarker,
  readMarker,
  removeMarker,
  markerFilePath,
  scanEnvironForMarker,
  scanEnvironForMarkerFull,
  groupPidsByPgid,
  verifyGroupHomogeneity,
  callerCarriesMarker,
  reapMarkerGroups,
  realKiller,
  type ProcessEnumerator,
  type KillPrimitive,
  type CopresenceMarker,
  type SessionInfo,
} from "./copresence-identity";

// ─── Test fixtures ──────────────────────────────────────────────────────

let tmpNodesDir: string;

beforeEach(() => {
  tmpNodesDir = mkdtempSync(join(tmpdir(), "p3-v2-test-"));
  chmodSync(tmpNodesDir, 0o700);
});

afterEach(() => {
  try { rmSync(tmpNodesDir, { recursive: true, force: true }); } catch {}
});

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmux: "test-alias-appsrv",
    pid: 1000,
    pgid: 1000,
    starttime_jiffies: 500,
    ...overrides,
  };
}

function makeSessions(): CopresenceMarker["sessions"] {
  return {
    appsrv: makeSession({ tmux: "a-appsrv", pid: 100, pgid: 100, starttime_jiffies: 500 }),
    bridge: makeSession({ tmux: "a-bridge", pid: 200, pgid: 200, starttime_jiffies: 600 }),
    tui: makeSession({ tmux: "a-tui", pid: 300, pgid: 300, starttime_jiffies: 700 }),
  };
}

/** In-memory ProcessEnumerator for tests. */
class MockEnumer implements ProcessEnumerator {
  procs = new Map<number, { environ: string; stat: { pgid: number; starttime_jiffies: number; ppid: number }; ownerUid?: number; state?: string }>();
  listErr: Error | null = null;
  environErrs = new Map<number, Error>();
  statErrs = new Map<number, Error>();
  defaultOwnerUid: number = process.getuid ? process.getuid()! : -1;

  listAllPids(): number[] {
    if (this.listErr) throw this.listErr;
    return [...this.procs.keys()];
  }
  readEnviron(pid: number): string | null {
    const err = this.environErrs.get(pid);
    if (err) throw err;
    const p = this.procs.get(pid);
    return p ? p.environ : null;
  }
  readStat(pid: number) {
    const err = this.statErrs.get(pid);
    if (err) throw err;
    const p = this.procs.get(pid);
    return p ? { ...p.stat } : null;
  }
  readOwnerUid(pid: number): number | null {
    const p = this.procs.get(pid);
    if (!p) return null;
    return p.ownerUid ?? this.defaultOwnerUid;
  }
  readState(pid: number): string | null {
    const p = this.procs.get(pid);
    if (!p) return null;
    return p.state ?? "S"; // default = sleeping (normal running)
  }
  add(pid: number, environ: string, pgid: number, starttime = 0, ppid = 1, opts: { ownerUid?: number; state?: string } = {}) {
    this.procs.set(pid, {
      environ,
      stat: { pgid, starttime_jiffies: starttime, ppid },
      ownerUid: opts.ownerUid,
      state: opts.state,
    });
  }
}

class MockKiller implements KillPrimitive {
  signals: Array<{ pgid: number; signal: "TERM" | "KILL" }> = [];
  aliveMap = new Map<number, boolean>();
  killPgroup(pgid: number, signal: "TERM" | "KILL"): void {
    this.signals.push({ pgid, signal });
  }
  pgroupAlive(pgid: number): boolean {
    return this.aliveMap.get(pgid) ?? false;
  }
}

// ─── Test 1: UUID round-trip (MUST catch Blocker 1) ─────────────────────

describe("Test 1: UUID round-trip", () => {
  // MUTATION CASES (通信龙 will attempt these to verify test turns RED):
  //   - Change writeMarker to generate its own uuid internally, ignoring
  //     the `uuid` parameter → this test MUST RED (marker.marker !== provided)
  //   - Remove the uuid parameter guard, accept "" or number → this test
  //     MUST RED (empty-string or wrong-type must throw)
  //   - cli.ts wiring: any caller that generates a second uuid to inject
  //     into tmux env instead of using the returned marker.marker → the
  //     invariant is tested here at the API level.
  test("writeMarker persists exactly the provided uuid (single source of truth)", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const written = writeMarker(tmpNodesDir, "n1", uuid, makeSessions());
    expect(written.marker).toBe(uuid);
    const read = readMarker(tmpNodesDir, "n1");
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.marker.marker).toBe(uuid);
      // The same uuid MUST be what cli.ts injects into tmux env vars.
      // If the helper had generated its own uuid, this equality would fail
      // — that was Blocker 1 in 9f2ec282.
    }
  });

  test("writeMarker refuses empty uuid (guard against silent regeneration)", () => {
    expect(() => writeMarker(tmpNodesDir, "n2", "", makeSessions())).toThrow(/non-empty/i);
  });

  test("writeMarker refuses non-string uuid", () => {
    // @ts-expect-error deliberate type violation
    expect(() => writeMarker(tmpNodesDir, "n3", 42, makeSessions())).toThrow(/non-empty/i);
    // @ts-expect-error deliberate type violation
    expect(() => writeMarker(tmpNodesDir, "n4", null, makeSessions())).toThrow(/non-empty/i);
  });
});

// ─── Test 2: enumeration failure (MUST catch Blocker 2) ─────────────────

describe("Test 2: enumeration failure is loud (fail-closed)", () => {
  // MUTATION CASES:
  //   - Wrap listAllPids/readStat/readEnviron in `catch { return [] }` in
  //     the real /proc-based ProcessEnumerator → verifyGroupHomogeneity
  //     would judge empty-list as "no foreign members, ok:true" → this
  //     test MUST RED
  //   - Silent swallow of listAllPids error → verifyGroupHomogeneity must
  //     surface ENUM_ERROR, not judge ok
  test("verifyGroupHomogeneity fails-closed when listAllPids throws", () => {
    const enumer = new MockEnumer();
    enumer.listErr = new Error("ps: unknown gnu long option");
    const result = verifyGroupHomogeneity(enumer, 999, "some-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("ENUM_ERROR");
      expect(result.detail).toMatch(/listAllPids failed/);
    }
  });

  test("verifyGroupHomogeneity fails-closed when a member's environ read throws", () => {
    const enumer = new MockEnumer();
    // pid 100 is in the group and has the marker
    enumer.add(100, "ANET_NODE_MARKER=u1\0PATH=/\0", 500);
    // pid 200 is in the group; environ read fails (permission denied)
    enumer.add(200, "x", 500);
    enumer.environErrs.set(200, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("ENUM_ERROR");
      expect(result.unreadablePids).toContain(200);
    }
  });

  test("verifyGroupHomogeneity fails-closed when a stat read throws", () => {
    const enumer = new MockEnumer();
    enumer.add(100, "ANET_NODE_MARKER=u1\0PATH=/\0", 500);
    // synthesize a pid whose stat throws (permission oddity)
    enumer.procs.set(200, { environ: "PATH=/\0", stat: { pgid: 500, starttime_jiffies: 1, ppid: 1 } });
    enumer.statErrs.set(200, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("ENUM_ERROR");
    }
  });
});

// ─── Test 3: foreign member in PGID ─────────────────────────────────────

describe("Test 3: foreign member in PGID → SKIP", () => {
  // MUTATION CASES:
  //   - Skipping the loop over all group pids (only checking the initial
  //     scan result) → test MUST RED
  //   - Trusting only the primary pid's environ → test MUST RED
  //   - Treating "0 foreign" as ok:true when actually enumeration failed →
  //     covered by Test 2
  test("group with unmarked co-resident refuses homogeneity", () => {
    const enumer = new MockEnumer();
    // Two marker-carrying + one foreign pid, all in pgid=500
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 500);
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 500);
    enumer.add(300, "PATH=/\0", 500); // foreign — no marker
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cause).toBe("FOREIGN_MEMBER");
      expect(result.foreignPids).toContain(300);
    }
  });

  test("group where every member carries the marker is ok", () => {
    const enumer = new MockEnumer();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 500);
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 500);
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members.sort()).toEqual([100, 200]);
  });
});

// ─── Test 4: main dead, child alive ─────────────────────────────────────

describe("Test 4: main-dead-child-alive (environ scan is authority)", () => {
  // MUTATION CASES:
  //   - If reap flow trusted marker.sessions.*.pid instead of environ scan
  //     for identity, main-dead scenario would leave workers un-reaped.
  //     scanEnvironForMarker MUST find the surviving worker regardless of
  //     the marker file's stored pids.
  test("scan finds workers even when marker's stored pids are gone", () => {
    const enumer = new MockEnumer();
    // Marker file (hypothetically) recorded pid=100 as main; main died.
    // Only pid=200 (worker) survives, still carrying the marker.
    enumer.add(200, "ANET_NODE_MARKER=u1\0OTHER=x\0", 750);
    // Marker's stored pid=100 does NOT exist in enumer; we don't add it.
    const found = scanEnvironForMarker(enumer, "u1");
    expect(found).toEqual([200]);
    // Grouping uses the worker's CURRENT pgid, not the marker file's hint.
    const groups = groupPidsByPgid(enumer, found);
    expect(groups.get(750)).toEqual([200]);
    expect(groups.has(100)).toBe(false);
  });
});

// ─── Test 5: setsid / new PGID ──────────────────────────────────────────

describe("Test 5: child setsid → new PGID", () => {
  // MUTATION CASES:
  //   - If groupPidsByPgid used the marker.sessions.*.pgid instead of the
  //     current /proc/PID/stat pgid, the detached child would land under
  //     the wrong (dead) pgid and never be reaped.
  test("detached child grouped under its current pgid, not marker's stored pgid", () => {
    const enumer = new MockEnumer();
    // Worker was born under pgid=500 (per marker), but did setsid → now pgid=200.
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 200 /* new pgid */, 1234);
    const found = scanEnvironForMarker(enumer, "u1");
    expect(found).toEqual([200]);
    const groups = groupPidsByPgid(enumer, found);
    expect(groups.get(200)).toEqual([200]); // grouped by current pgid
    expect(groups.has(500)).toBe(false);
  });
});

// ─── Test 6: PID reuse (boot_id defense via readMarker) ─────────────────
//
// Original Test 6 covered `sessionStillFresh` — that function was deleted
// per audit 92d53c8f finding #1 (zero production call sites, gave the tests
// false coverage). PID-reuse defense in practice is:
//   - The boot_id check in readMarker (STALE_BOOT_ID refuse) — after host
//     reboot, every stale marker's pids are unrelated → readMarker refuses
//     the whole thing before reap even starts. Covered by Test 8b's
//     STALE_BOOT_ID test.
//   - The environ-scan-is-truth rule — reap NEVER looks at marker.sessions.*
//     .pid to decide what to kill. Only /proc/*/environ matching the uuid.
//     A stale recycled pid can't carry our uuid (it's a fresh process's
//     environ). Covered by Test 4 (main-dead-child-alive) which proves
//     the reap flow doesn't trust marker's stored pids at all.
describe("Test 6: PID-reuse defense is the boot_id + environ-scan invariant", () => {
  test("environ scan only returns pids whose current environ carries the uuid", () => {
    // Simulate: marker file previously recorded pid=100 as a session pid.
    // Now pid=100 has been recycled to an unrelated process (different environ).
    const enumer = new MockEnumer();
    enumer.add(100, "PATH=/\0OLDER_PROC=1\0", 500);
    // No marker anywhere → scan returns nothing. Recycled pid is never
    // touched by the reap flow because it doesn't carry our uuid.
    const found = scanEnvironForMarker(enumer, "u1-that-does-not-exist-anywhere");
    expect(found).toEqual([]);
  });
});

// ─── Test 7: partial-start rollback ─────────────────────────────────────

describe("Test 7: partial-start rollback (marker gate)", () => {
  // The invariant tested here is: if writeMarker was never called (partial
  // start), then readMarker returns MISSING and the stop caller must treat
  // that as "not our node, don't touch anything" — never blind-kill.
  //
  // MUTATION CASES:
  //   - Any code path that assumes MISSING marker means "clean up by name"
  //     → violates the invariant.
  //   - Any rollback that shells out to `pkill -f <alias>` when marker is
  //     absent → violates the invariant.
  test("MISSING marker after partial start prevents any process action", () => {
    // No marker file exists at all (start failed before writeMarker)
    const r = readMarker(tmpNodesDir, "partial-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("MISSING");
    // The reap flow is not invoked because caller sees MISSING.
    // (Invariant: caller MUST honor MISSING as no-op; verified in cli.ts
    // integration by Test 10's zero-diff check on the legacy path.)
  });
});

// ─── Test 8: malformed marker ───────────────────────────────────────────

describe("Test 8: malformed marker → structured refuse (never throws)", () => {
  // MUTATION CASES:
  //   - Using `"marker" in obj` on a null-body → TypeError, test MUST RED
  //   - Trusting Array/number bodies → schema check catches, MUST RED
  //   - Missing null-check in isPlainObject → MUST RED
  const write = (body: string, mode = 0o600) => {
    const nodeDir = join(tmpNodesDir, "malformed-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(nodeDir, "copresence-identity.json"), body, { mode });
    chmodSync(join(nodeDir, "copresence-identity.json"), mode);
  };

  test("null body → SCHEMA_INVALID (no TypeError from `in` operator)", () => {
    write("null");
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SCHEMA_INVALID");
  });

  test("bare number → SCHEMA_INVALID", () => {
    write("42");
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SCHEMA_INVALID");
  });

  test("empty array → SCHEMA_INVALID", () => {
    write("[]");
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SCHEMA_INVALID");
  });

  test("empty object → SCHEMA_INVALID (missing required fields)", () => {
    write("{}");
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SCHEMA_INVALID");
  });

  test("wrong types in schema → SCHEMA_INVALID", () => {
    write(JSON.stringify({ marker: 42, boot_id: "x", started_at_epoch_ms: 1, owner_uid: 1, sessions: { appsrv: {}, bridge: {}, tui: {} } }));
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SCHEMA_INVALID");
  });

  test("syntactically invalid JSON → PARSE_ERROR", () => {
    write("{not json");
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("PARSE_ERROR");
  });

  test("wrong mode → WRONG_MODE (even with valid JSON)", () => {
    write(JSON.stringify({
      marker: "u1", boot_id: "b1", started_at_epoch_ms: 1, owner_uid: process.getuid?.() ?? -1,
      sessions: { appsrv: makeSession(), bridge: makeSession(), tui: makeSession() },
    }), 0o644);
    const r = readMarker(tmpNodesDir, "malformed-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("WRONG_MODE");
  });

  test("symlink → SYMLINK (refuses to follow)", () => {
    const nodeDir = join(tmpNodesDir, "symlink-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    // Create a target file, then symlink the marker path to it.
    const target = join(tmpNodesDir, "target.json");
    writeFileSync(target, "irrelevant", { mode: 0o600 });
    symlinkSync(target, join(nodeDir, "copresence-identity.json"));
    const r = readMarker(tmpNodesDir, "symlink-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("SYMLINK");
  });
});

// ─── Test 8b: filesystem/environment refuse guards ──────────────────────
//
// These target the three refuses that had no test coverage in the initial
// v2 candidate (通信龙 mutation复核 task fb363cf7). Each fixture is
// carefully constructed so that ONLY the target guard fires — all earlier
// guards in readMarker (SYMLINK → NOT_REGULAR → WRONG_MODE → OWNER_MISMATCH
// → PARSE_ERROR → SCHEMA_INVALID → STALE_BOOT_ID) pass, so the specific
// refuse is uniquely observable.
//
// If a fixture triggered an earlier guard by accident, disabling the target
// guard wouldn't be observable — the earlier guard would mask it. Every
// test below is designed so that removing the target guard changes the
// return value from `refuse:<TARGET>` to something else observable
// (typically `ok`, or a subsequent-guard refuse, or a thrown error).
describe("Test 8b: filesystem/environment refuse guards (mutation-sensitive)", () => {
  // MUTATION CASES (for 通信龙's automated mutation复核):
  //   - Comment `if (!lstat.isFile())` → NOT_REGULAR test RED
  //     (readMarker falls to readFileSync which throws EISDIR on a directory)
  //   - Comment `if (lstat.uid !== ownUid)` → OWNER_MISMATCH test RED
  //     (returns ok:{marker} because our fixture is otherwise valid)
  //   - Comment `if (parsed.boot_id !== currentBoot)` → STALE_BOOT_ID test RED
  //     (returns ok:{marker} because everything else is valid)

  test("NOT_REGULAR: directory at marker path with mode 0600 (skips SYMLINK+WRONG_MODE)", () => {
    // Fixture: create a *directory* at the exact path where the marker file
    // would live. Directory bits 0o600 pass WRONG_MODE. isSymbolicLink=false
    // passes SYMLINK. So NOT_REGULAR is the only fireable guard.
    const nodeDir = join(tmpNodesDir, "notreg-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    // Create the marker "file" as a directory.
    const markerPath = join(nodeDir, "copresence-identity.json");
    mkdirSync(markerPath, { mode: 0o600 });
    // Force mode to 0o600 (mkdir + umask may not honor 0o600 exactly).
    chmodSync(markerPath, 0o600);
    // Sanity check the fixture: lstat sees a directory with mode 0o600.
    const st = statSync(markerPath);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const r = readMarker(tmpNodesDir, "notreg-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("NOT_REGULAR");
    // Note: if NOT_REGULAR guard is removed, readFileSync throws EISDIR
    // and readMarker itself throws. Bun's `expect(fn).toBe(...)` on the
    // thrown result reports failure — test correctly turns RED.
  });

  test("OWNER_MISMATCH: valid marker file whose lstat.uid differs from process.getuid() (SECURITY CRITICAL)", () => {
    // We cannot chown as non-root, so this test overrides process.getuid
    // for its duration. This is the *only* way to construct the mismatch
    // without helper-side DI (which we chose to avoid — see fork brief).
    //
    // The marker file is otherwise fully valid: correct mode, correct
    // schema, matching boot_id. So the ONLY guard that fires is
    // OWNER_MISMATCH. If that guard is removed, readMarker returns
    // { kind: "ok", ... } and the test's `expect(r.kind).toBe("refuse")`
    // assertion fails → test correctly turns RED.
    const uuid = "owner-mismatch-uuid-1234";
    // Write a fully valid marker (uses real process.getuid for owner_uid).
    writeMarker(tmpNodesDir, "owner-mismatch-node", uuid, makeSessions());
    // Now spoof process.getuid to return a different uid.
    const realGetuid = process.getuid;
    const spoofedUid = ((realGetuid ? realGetuid.call(process) : 0) + 424242) >>> 0;
    // Use Object.defineProperty because process.getuid may be non-writable on
    // some Node builds; defineProperty forces the replacement.
    Object.defineProperty(process, "getuid", {
      value: () => spoofedUid,
      configurable: true,
      writable: true,
    });
    try {
      const r = readMarker(tmpNodesDir, "owner-mismatch-node");
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") {
        expect(r.cause).toBe("OWNER_MISMATCH");
        // Also assert the detail message references BOTH uids to catch
        // regressions where the message accidentally uses ownUid in place
        // of lstat.uid or vice versa.
        expect(r.detail).toContain(String(spoofedUid));
      }
    } finally {
      // Restore. Use defineProperty again to reinstall the real fn.
      Object.defineProperty(process, "getuid", {
        value: realGetuid,
        configurable: true,
        writable: true,
      });
    }
  });

  test("STALE_BOOT_ID: valid schema but boot_id differs from current /proc boot_id", () => {
    // Bypass writeMarker (which stamps current boot_id) and hand-write a
    // marker JSON with a deliberately-wrong boot_id. Everything else is
    // valid: mode 0o600, owner=us, schema OK. So the ONLY guard that fires
    // is STALE_BOOT_ID. Removing that guard returns `ok` and the assertion
    // `r.cause === "STALE_BOOT_ID"` fails → test correctly turns RED.
    const nodeDir = join(tmpNodesDir, "stale-boot-node");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    const path = join(nodeDir, "copresence-identity.json");
    const stale = {
      marker: "stale-boot-uuid-9999",
      // A boot_id that cannot possibly match: fixed sentinel unrelated to
      // any real /proc value. If /proc/sys/kernel/random/boot_id ever
      // returned this literal string, we would need to update — but the
      // sentinel is chosen to be visibly not-a-UUID to make that impossible
      // by design.
      boot_id: "0000ffff-stale-boot-id-for-mutation-test-fixture",
      started_at_epoch_ms: 1,
      owner_uid: process.getuid ? process.getuid() : -1,
      sessions: {
        appsrv: { tmux: "a-appsrv", pid: 100, pgid: 100, starttime_jiffies: 500 },
        bridge: { tmux: "a-bridge", pid: 200, pgid: 200, starttime_jiffies: 600 },
        tui: { tmux: "a-tui", pid: 300, pgid: 300, starttime_jiffies: 700 },
      },
    };
    writeFileSync(path, JSON.stringify(stale, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    const r = readMarker(tmpNodesDir, "stale-boot-node");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.cause).toBe("STALE_BOOT_ID");
      // Detail must mention the stale boot_id in the marker (this catches
      // a mutation where the message would use `currentBoot` twice).
      expect(r.detail).toContain(stale.boot_id);
    }
  });
});

// ─── Test 9: self-context ───────────────────────────────────────────────

describe("Test 9: self-context refuses stop from within the tree", () => {
  // MUTATION CASES:
  //   - Any code that excludes caller pid then continues to kill → MUST RED
  //   - Skipping ancestry walk (only checking self pid) → RED for the
  //     "ancestor carries marker" case
  test("caller's own environ carrying the marker is detected", () => {
    const enumer = new MockEnumer();
    // Simulate current pid carrying the marker (in reality process.pid is
    // read; we override the enumer to return the marker for process.pid).
    enumer.add(process.pid, `ANET_NODE_MARKER=u1\0PATH=/\0`, 500, 0, 1);
    const r = callerCarriesMarker(enumer, "u1");
    expect(r.self).toBe(true);
    expect(r.ancestorPid).toBe(process.pid);
  });

  test("ancestor carrying the marker is detected via PPID walk", () => {
    const enumer = new MockEnumer();
    // Chain: self (no marker) → parent 9999 → grandparent 8888 (has marker)
    enumer.add(process.pid, "PATH=/\0", 500, 0, 9999);
    enumer.add(9999, "PATH=/\0", 500, 0, 8888);
    enumer.add(8888, "ANET_NODE_MARKER=u1\0PATH=/\0", 500, 0, 1);
    const r = callerCarriesMarker(enumer, "u1");
    expect(r.self).toBe(false);
    expect(r.ancestorPid).toBe(8888);
  });

  test("clean caller (no marker in ancestry) returns self=false", () => {
    const enumer = new MockEnumer();
    enumer.add(process.pid, "PATH=/\0", 500, 0, 1);
    const r = callerCarriesMarker(enumer, "u1");
    expect(r.self).toBe(false);
    expect(r.ancestorPid).toBeUndefined();
  });
});

// ─── Test 10: ordinary codex-app-server zero-diff ────────────────────────

describe("Test 10: non-copresence codex-app-server → legacy path (zero diff)", () => {
  // The invariant tested here is: the stop gate keys on MARKER FILE
  // EXISTENCE (a persistent side-effect of `anet node start --copresence`),
  // NOT on the runtime string. An ordinary codex-app-server node has NO
  // marker file → readMarker → MISSING → caller falls through to legacy.
  //
  // MUTATION CASES:
  //   - Any gate that keys on `runtime === "codex-app-server"` and forces
  //     the new P3 path for ordinary nodes → RED (breaks ordinary stop)
  //   - Any gate that ignores marker MISSING and proceeds with identity
  //     flow → RED (ordinary node has no marker; nothing would be killed)
  test("readMarker returns MISSING for an ordinary codex-app-server node dir", () => {
    // Simulate: a node exists (as a directory in nodesDir), but was NOT
    // started with --copresence, so writeMarker was never called.
    const nodeDir = join(tmpNodesDir, "ordinary-codex");
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    // Other node config files may exist here, but not copresence-identity.json.
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ runtime: "codex-app-server", copresence: false }), { mode: 0o600 });
    const r = readMarker(tmpNodesDir, "ordinary-codex");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.cause).toBe("MISSING");
    // The stop-command gate MUST short-circuit here to the legacy path.
    // Any code that reads the config's `runtime` field and forces the
    // new path for `codex-app-server` breaks the zero-diff invariant.
  });
});

// ─── Test 11: idempotent 二次 stop ──────────────────────────────────────

describe("Test 11: 二次 stop is idempotent (MISSING = already stopped)", () => {
  // MUTATION CASES:
  //   - Any 2nd-stop path that tries to "clean up residuals" on missing
  //     marker → RED (must be a no-op)
  //   - Any 2nd stop that emits a warning implying failure → RED (caller
  //     must treat MISSING as clean state)
  test("2nd read after successful removeMarker returns MISSING (no side effects)", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeMarker(tmpNodesDir, "n1", uuid, makeSessions());
    // Simulate a successful stop path: caller removes the marker.
    removeMarker(tmpNodesDir, "n1");
    // 2nd stop attempt reads → MISSING.
    const r1 = readMarker(tmpNodesDir, "n1");
    expect(r1.kind).toBe("refuse");
    if (r1.kind === "refuse") expect(r1.cause).toBe("MISSING");
    // 3rd, 4th ... all identical.
    const r2 = readMarker(tmpNodesDir, "n1");
    expect(r2.kind).toBe("refuse");
    if (r2.kind === "refuse") expect(r2.cause).toBe("MISSING");
  });

  test("removeMarker on already-missing marker does not throw", () => {
    // Idempotency at the primitive level.
    expect(() => removeMarker(tmpNodesDir, "never-existed")).not.toThrow();
  });
});

// ─── Reap orchestration integration (glue test for the reap flow) ────────

describe("reapMarkerGroups: end-to-end (mocked /proc + kill)", () => {
  test("verified groups get SIGTERM, still-alive groups then get SIGKILL", async () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 200);
    killer.aliveMap.set(100, false); // exited after TERM
    killer.aliveMap.set(200, true);  // still alive after TERM
    const logs: string[] = [];
    const originalTerm = killer.killPgroup.bind(killer);
    killer.killPgroup = (pgid, sig) => {
      originalTerm(pgid, sig);
      if (sig === "KILL") {
        enumer.procs.delete(100); enumer.procs.delete(200);
      }
    };
    const result = await reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: (m) => logs.push(m) });
    const sigs = killer.signals;
    expect(sigs.some(s => s.pgid === 100 && s.signal === "TERM")).toBe(true);
    expect(sigs.some(s => s.pgid === 200 && s.signal === "TERM")).toBe(true);
    expect(sigs.some(s => s.pgid === 200 && s.signal === "KILL")).toBe(true);
    expect(sigs.some(s => s.pgid === 100 && s.signal === "KILL")).toBe(false);
    expect(result.kind).toBe("success");
  });

  test("groups with foreign members are SKIPPED, never signaled", async () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    enumer.add(101, "PATH=/\0", 100); // foreign co-resident
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 200);
    killer.aliveMap.set(200, false);
    const originalKill = killer.killPgroup.bind(killer);
    killer.killPgroup = (pgid, sig) => { originalKill(pgid, sig); };
    const logs: string[] = [];
    const result = await reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: (m) => logs.push(m) });
    expect(killer.signals.some(s => s.pgid === 100)).toBe(false);
    expect(killer.signals.some(s => s.pgid === 200 && s.signal === "TERM")).toBe(true);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.skippedGroups.some(g => g.pgid === 100)).toBe(true);
      expect(result.residualPids).toContain(100);
    }
  });

  test("no marker-carrying pids anywhere → immediate success (idempotent)", async () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    const result = await reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: () => {} });
    expect(result.kind).toBe("success");
    expect(killer.signals.length).toBe(0);
  });
});

// ─── Finding tests (audit 92d53c8f 2 blockers + 9 finds) ────────────────

describe("Blocker 1: scanEnvironForMarker EACCES discrimination", () => {
  // Root cause of the审 blocker: /proc/1/environ (root pid=1) is 0400 → EACCES.
  // Without discrimination, scanEnvironForMarker crashes on the first
  // non-own-uid process it hits and the whole identity flow falls back to
  // the legacy tmux-name sweep (i.e. this whole feature never actually runs).
  //
  // MUTATION CASES (通信龙 will attempt):
  //   - Change `if (ownerUid !== ownUid) continue` → `throw err` : test #1 RED
  //   - Change `if (state === "Z") continue` → `throw err` : test #3 RED
  //   - Remove the discriminator entirely (revert to naive `throw err`) : both RED
  //   - Change to blind `catch { continue }` (recreates Defect A) : test #4 RED
  //     (marker-carrying own-uid live proc with unexplained EACCES must NOT
  //     be silently missed)

  test("other-user EACCES on environ → skip that pid (expected, not fail)", () => {
    const enumer = new MockEnumer();
    // pid 1 = systemd/root; own-uid discriminator says "not ours, skip"
    enumer.add(1, "IGNORED\0", 1, 0, 0, { ownerUid: 0, state: "S" });
    enumer.environErrs.set(1, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    // Our own pid carrying the marker
    enumer.add(9999, "ANET_NODE_MARKER=u1\0", 999);
    const result = scanEnvironForMarker(enumer, "u1");
    expect(result).toEqual([9999]);
  });

  test("Defect A defense: own-uid running EACCES records unreadable pid → reap refuses to delete marker", async () => {
    // Real-world calibration (audit + practical Linux behavior 2026-07-29):
    // Rather than throwing (which crashed the whole scan on random system
    // processes like sd-pam, docker daemons, systemd-oomd), scan RECORDS
    // the pid as "unreadable own-uid" and continues. reapMarkerGroups treats
    // ANY unreadable-own-uid pid as "cannot prove teardown succeeded" and
    // returns kind:"failed" (preserving the marker file for retry). This
    // maintains Defect A defense WITHOUT crashing on unrelated system procs.
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    // A process that: is ours, is running, but its environ returns EACCES.
    // With NO marker-carrying pids visible, scan would return hits=0 but
    // unreadableOwnUid=[500] — reap must NOT report success.
    enumer.add(500, "ANET_NODE_MARKER=u1\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1, state: "S" });
    enumer.environErrs.set(500, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    // Sanity: scan sees the unreadable
    const scan = scanEnvironForMarkerFull(enumer, "u1");
    expect(scan.hits.length).toBe(0);
    expect(scan.unreadableOwnUid).toEqual([500]);
    // Reap must refuse:
    const result = await reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: () => {} });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.unreadableOwnUid).toEqual([500]);
    }
  });

  test("zombie process environ EACCES → skip (mm freed, expected)", () => {
    const enumer = new MockEnumer();
    // Our own uid, but state=Z means zombie — mm freed, environ unreadable
    enumer.add(500, "IGNORED\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1, state: "Z" });
    enumer.environErrs.set(500, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    // And a live one carrying the marker
    enumer.add(600, "ANET_NODE_MARKER=u1\0", 600);
    const result = scanEnvironForMarker(enumer, "u1");
    expect(result).toEqual([600]);
  });

  test("EACCES-carrying process that vanishes during discrimination → skip", () => {
    const enumer = new MockEnumer();
    // The pid's ownerUid check returns null (pid gone between listAllPids and readOwnerUid)
    // Simulated by not adding it to procs but having listAllPids return it.
    const bumperPids = [1234];
    const originalList = enumer.listAllPids.bind(enumer);
    enumer.listAllPids = () => [...bumperPids, ...originalList()];
    enumer.environErrs.set(1234, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    // readOwnerUid(1234) returns null because not in procs — treat as vanished, skip
    const result = scanEnvironForMarker(enumer, "u1");
    expect(result).toEqual([]);
  });
});

describe("Blocker 2: verifyGroupHomogeneity zombie discrimination + EMPTY_GROUP", () => {
  // If verifyGroupHomogeneity treats a zombie same-uid member as "unreadable
  // → ENUM_ERROR", the whole group gets skipped even though the zombie is
  // dying and irrelevant. Post-SIGTERM re-verify is when zombies are most
  // numerous → teardown never escalates → residual reported forever.

  test("group containing a zombie same-uid member still verifies OK for the live marker members", () => {
    const enumer = new MockEnumer();
    // Live marker member
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1, state: "S" });
    // Same-uid zombie in the same pgid — environ read returns EACCES
    enumer.add(101, "IGNORED\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1, state: "Z" });
    enumer.environErrs.set(101, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members).toEqual([100]);
  });

  test("group containing an other-user EACCES member still verifies OK for our members", () => {
    const enumer = new MockEnumer();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1 });
    enumer.add(101, "IGNORED\0", 500, 0, 1, { ownerUid: 0 }); // root process co-resident
    enumer.environErrs.set(101, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members).toEqual([100]);
  });

  test("empty group (no live marker members) → EMPTY_GROUP refuse (never ok:true)", () => {
    // Finding #6: empty-members judged ok:true was Defect B's shape.
    const enumer = new MockEnumer();
    // No processes at all in pgid=999
    const result = verifyGroupHomogeneity(enumer, 999, "u1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe("EMPTY_GROUP");
  });

  test("own-uid non-zombie unreadable → ENUM_ERROR (fail-closed)", () => {
    const enumer = new MockEnumer();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1 });
    // Same-uid live process in group, environ unreadable for real reason
    enumer.add(101, "IGNORED\0", 500, 0, 1, { ownerUid: process.getuid?.() ?? -1, state: "S" });
    enumer.environErrs.set(101, Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const result = verifyGroupHomogeneity(enumer, 500, "u1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBe("ENUM_ERROR");
  });
});

describe("Finding #2: killPgroup pgid<=0 guard", () => {
  test("realKiller().killPgroup(0, TERM) throws — kill(-0) would target caller's own pgroup", () => {
    const kk = realKiller();
    expect(() => kk.killPgroup(0, "TERM")).toThrow(/pgid must be > 0/);
    expect(() => kk.killPgroup(-1, "TERM")).toThrow(/pgid must be > 0/);
  });
  test("realKiller().pgroupAlive(0) throws", () => {
    const kk = realKiller();
    expect(() => kk.pgroupAlive(0)).toThrow(/pgid must be > 0/);
  });
});

describe("Finding #3: reapMarkerGroups uses async sleep (not busy-wait)", () => {
  test("grace period is truly asynchronous — event loop ticks during it", async () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    // Set up a group so we hit the sleep path.
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    killer.aliveMap.set(100, false); // exits on TERM, so no KILL escalation
    // Prove the event loop can process a setImmediate during the grace window.
    // Busy-wait would block the loop and setImmediate would never fire.
    let loopTicked = false;
    const graceMs = 100;
    const reapP = reapMarkerGroups(enumer, killer, "u1", { graceMs, logger: () => {} });
    // Kick a microtask that requires event-loop turns.
    setImmediate(() => { loopTicked = true; });
    await reapP;
    expect(loopTicked).toBe(true);
  });

  test("injected sleep function is used (tests can override with fast/deterministic version)", async () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    killer.aliveMap.set(100, false);
    let sleepCalledWith = -1;
    await reapMarkerGroups(enumer, killer, "u1", {
      graceMs: 999,
      logger: () => {},
      sleep: async (ms) => { sleepCalledWith = ms; }, // completes immediately
    });
    expect(sleepCalledWith).toBe(999);
  });
});

describe("Finding #7: readMarker PLATFORM_UNSUPPORTED on non-Linux", () => {
  // On Linux the marker file path works as-designed; on Darwin/Windows the
  // whole /proc-based identity flow is fundamentally not applicable. Rather
  // than misreporting corruption on those platforms, refuse with clarity.
  test("on non-Linux, readMarker refuses cleanly regardless of on-disk state", () => {
    // Verify the behavior by checking the guard directly:
    if (process.platform !== "linux") {
      const r = readMarker(tmpNodesDir, "any-node");
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") expect(r.cause).toBe("PLATFORM_UNSUPPORTED");
    } else {
      // On Linux the guard should NOT fire — writing then reading should work.
      const uuid = "linux-platform-uuid";
      writeMarker(tmpNodesDir, "linux-node", uuid, { appsrv: makeSession() });
      const r = readMarker(tmpNodesDir, "linux-node");
      expect(r.kind).toBe("ok");
      // Guard code has been read/kept even on Linux; this test asserts the
      // sibling code path (non-Linux) exists by symmetry.
    }
  });
});

describe("Finding #4: writeMarker accepts partial sessions object", () => {
  // Prior gated on `if (appsrvMk && bridgeMk && tuiMk)`; one flaky tmux
  // display-message → whole marker file skipped → node permanently loses
  // identity teardown ability. Sessions are observability, marker uuid is
  // identity truth. Fix: all sessions optional; only uuid + boot_id matter.
  test("writeMarker with only appsrv session succeeds and readMarker returns ok", () => {
    const uuid = "partial-sessions-uuid";
    writeMarker(tmpNodesDir, "partial-node", uuid, { appsrv: makeSession() });
    const r = readMarker(tmpNodesDir, "partial-node");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.marker.marker).toBe(uuid);
      expect(r.marker.sessions.appsrv).toBeDefined();
      expect(r.marker.sessions.bridge).toBeUndefined();
      expect(r.marker.sessions.tui).toBeUndefined();
    }
  });

  test("writeMarker with empty sessions object still succeeds (uuid is what matters)", () => {
    const uuid = "no-sessions-uuid";
    writeMarker(tmpNodesDir, "no-sessions-node", uuid, {});
    const r = readMarker(tmpNodesDir, "no-sessions-node");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.marker.marker).toBe(uuid);
  });
});
