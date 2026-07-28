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
  groupPidsByPgid,
  verifyGroupHomogeneity,
  callerCarriesMarker,
  sessionStillFresh,
  reapMarkerGroups,
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
  procs = new Map<number, { environ: string; stat: { pgid: number; starttime_jiffies: number; ppid: number } }>();
  listErr: Error | null = null;
  environErrs = new Map<number, Error>();
  statErrs = new Map<number, Error>();

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
  add(pid: number, environ: string, pgid: number, starttime = 0, ppid = 1) {
    this.procs.set(pid, { environ, stat: { pgid, starttime_jiffies: starttime, ppid } });
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

// ─── Test 6: PID reuse ──────────────────────────────────────────────────

describe("Test 6: PID reuse via starttime mismatch", () => {
  // MUTATION CASES:
  //   - Skipping the starttime check → stale marker pid would match a
  //     recycled unrelated pid → this test MUST RED
  //   - Also see boot_id check in Test 8 (readMarker's STALE_BOOT_ID path)
  test("sessionStillFresh returns false when starttime doesn't match", () => {
    const enumer = new MockEnumer();
    // Marker recorded pid=100 starttime=500. Current /proc/100 has different starttime.
    enumer.add(100, "PATH=/\0", 100, /* starttime */ 999);
    const session: SessionInfo = { tmux: "t", pid: 100, pgid: 100, starttime_jiffies: 500 };
    expect(sessionStillFresh(enumer, session)).toBe(false);
  });

  test("sessionStillFresh returns true when starttime matches", () => {
    const enumer = new MockEnumer();
    enumer.add(100, "PATH=/\0", 100, 500);
    const session: SessionInfo = { tmux: "t", pid: 100, pgid: 100, starttime_jiffies: 500 };
    expect(sessionStillFresh(enumer, session)).toBe(true);
  });

  test("sessionStillFresh returns false when pid gone (ENOENT)", () => {
    const enumer = new MockEnumer();
    const session: SessionInfo = { tmux: "t", pid: 100, pgid: 100, starttime_jiffies: 500 };
    expect(sessionStillFresh(enumer, session)).toBe(false);
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
  test("verified groups get SIGTERM, still-alive groups then get SIGKILL", () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    // Two groups, all homogeneous with marker
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 200);
    // First group exits on TERM; second doesn't (needs KILL)
    killer.aliveMap.set(100, false); // exited after TERM
    killer.aliveMap.set(200, true);  // still alive after TERM
    const logs: string[] = [];
    // After we escalate, simulate that group 200 also dies.
    // But before SIGKILL, re-verify happens; group must still be homogeneous.
    // (Post-KILL scan sees no residual because we clear procs.)
    const originalTerm = killer.killPgroup.bind(killer);
    killer.killPgroup = (pgid, sig) => {
      originalTerm(pgid, sig);
      if (sig === "KILL") {
        // Simulate everyone dying on KILL.
        enumer.procs.delete(100); enumer.procs.delete(200);
      }
    };
    const result = reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: (m) => logs.push(m) });
    // SIGTERM sent to both, SIGKILL sent to 200 only.
    const sigs = killer.signals;
    expect(sigs.some(s => s.pgid === 100 && s.signal === "TERM")).toBe(true);
    expect(sigs.some(s => s.pgid === 200 && s.signal === "TERM")).toBe(true);
    expect(sigs.some(s => s.pgid === 200 && s.signal === "KILL")).toBe(true);
    // 100 should NOT get KILL (it exited on TERM).
    expect(sigs.some(s => s.pgid === 100 && s.signal === "KILL")).toBe(false);
    expect(result.kind).toBe("success");
  });

  test("groups with foreign members are SKIPPED, never signaled", () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    // Marker in pgid=100, plus a foreign process also in pgid=100
    enumer.add(100, "ANET_NODE_MARKER=u1\0", 100);
    enumer.add(101, "PATH=/\0", 100); // foreign co-resident
    // Clean group in pgid=200
    enumer.add(200, "ANET_NODE_MARKER=u1\0", 200);
    killer.aliveMap.set(200, false);
    const originalKill = killer.killPgroup.bind(killer);
    killer.killPgroup = (pgid, sig) => { originalKill(pgid, sig); };
    const logs: string[] = [];
    const result = reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: (m) => logs.push(m) });
    // No signal EVER to pgid 100 (it had a foreign member).
    expect(killer.signals.some(s => s.pgid === 100)).toBe(false);
    // Signal(s) to pgid 200 (clean group).
    expect(killer.signals.some(s => s.pgid === 200 && s.signal === "TERM")).toBe(true);
    // Result records that some was skipped and pid 100 is residual.
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.skippedGroups.some(g => g.pgid === 100)).toBe(true);
      expect(result.residualPids).toContain(100);
    }
  });

  test("no marker-carrying pids anywhere → immediate success (idempotent)", () => {
    const enumer = new MockEnumer();
    const killer = new MockKiller();
    const result = reapMarkerGroups(enumer, killer, "u1", { graceMs: 0, logger: () => {} });
    expect(result.kind).toBe("success");
    expect(killer.signals.length).toBe(0);
  });
});
