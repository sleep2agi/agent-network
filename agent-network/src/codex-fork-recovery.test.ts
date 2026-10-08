// Board #738 — unit layer for --fork-on-resume-failure (the real-codex layer is tests/test738-*).
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORK_RECOVERY_SNAPSHOT_DIR, FORK_RECOVERY_STATE_FILE, recordForkMapping, resumeOrForkOnMissingOrdinal, sha256OfFile, type ForkRecoveryOptions, type ForkMapping } from "./codex-fork-recovery";

const OLD = "01a11846-d796-72f1-af68-8d9215a65dc8";
const NEW = "01a11900-0000-7000-8000-000000000001";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t738-"));
  const codexHome = join(root, "codex-home");
  const nodeDir = join(root, "node");
  const dir = join(codexHome, "sessions", "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  mkdirSync(nodeDir);
  const rollout = join(dir, `rollout-2026-10-07T21-30-58-${OLD}.jsonl`);
  writeFileSync(rollout, '{"ordinal":0,"type":"session_meta","payload":{"history_mode":"paginated"}}\n{"type":"event_msg"}\n', { mode: 0o600 });
  return { codexHome, nodeDir, rollout };
}

const ordinalError = (path: string) => new Error(`-32600: final paginated rollout record at ${path} is missing an ordinal`);

function opts(f: ReturnType<typeof fixture>, over: Partial<ForkRecoveryOptions> = {}): ForkRecoveryOptions {
  return {
    enabled: true, yes: false, interactive: false, threadId: OLD, codexHome: f.codexHome, nodeDir: f.nodeDir, node: "n1",
    confirm: async () => { throw new Error("confirm must not be called"); }, log: () => {}, ...over,
  };
}

function starter(error: Error, onFork: () => void = () => {}) {
  const calls: boolean[] = [];
  const start = async (forkFirst: boolean) => {
    calls.push(forkFirst);
    if (!forkFirst) throw error;
    onFork();
    return { threadId: NEW };
  };
  return { calls, start };
}

describe("fork mapping history", () => {
  const entry: ForkMapping = { oldThreadId: OLD, newThreadId: NEW, originalRollout: "original", snapshot: "snapshot", sha256: "digest", at: "2026-10-09T00:00:00Z" };

  test("first write and append preserve earlier mappings", () => {
    const f = fixture();
    const path = recordForkMapping(f.nodeDir, entry);
    const next = { ...entry, oldThreadId: NEW, newThreadId: "next-thread" };
    recordForkMapping(f.nodeDir, next);
    expect(JSON.parse(readFileSync(path, "utf8")).forks).toEqual([entry, next]);
  });

  test.each(["{broken", "{}", '{"forks":{}}', "null"])("malformed history is preserved: %s", async (raw) => {
    const f = fixture();
    const path = join(f.nodeDir, FORK_RECOVERY_STATE_FILE);
    writeFileSync(path, raw);
    expect(() => recordForkMapping(f.nodeDir, entry)).toThrow(/Cannot read fork recovery history/);
    expect(readFileSync(path, "utf8")).toBe(raw);
    const s = starter(ordinalError(f.rollout));
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { yes: true }))).rejects.toThrow(path);
    expect(s.calls).toEqual([false]);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readdirSync(f.nodeDir)).toEqual([FORK_RECOVERY_STATE_FILE]);
  });

  test("a history read error stops before snapshot or fork", async () => {
    const f = fixture();
    const path = join(f.nodeDir, FORK_RECOVERY_STATE_FILE);
    mkdirSync(path);
    const s = starter(ordinalError(f.rollout));
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { yes: true }))).rejects.toThrow(/Cannot read fork recovery history/);
    expect(s.calls).toEqual([false]);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(f.nodeDir)).toEqual([FORK_RECOVERY_STATE_FILE]);
  });
});

describe("resumeOrForkOnMissingOrdinal", () => {
  test("a successful resume is returned unchanged; no fork", async () => {
    const f = fixture();
    const calls: boolean[] = [];
    const r = await resumeOrForkOnMissingOrdinal(async (fork) => { calls.push(fork); return { threadId: OLD }; }, opts(f, { yes: true }));
    expect(r.threadId).toBe(OLD);
    expect(calls).toEqual([false]);
  });

  test("without the flag: the original error, no fork, no files", async () => {
    const f = fixture();
    const err = ordinalError(f.rollout);
    const s = starter(err);
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { enabled: false, yes: true }))).rejects.toBe(err);
    expect(s.calls).toEqual([false]);
    expect(readdirSync(f.nodeDir)).toEqual([]);
  });

  test("another resume error class: no fork even with the flag and --yes", async () => {
    const f = fixture();
    const err = new Error("-32600: no rollout found for thread id " + OLD);
    const s = starter(err);
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { yes: true }))).rejects.toBe(err);
    expect(s.calls).toEqual([false]);
    expect(readdirSync(f.nodeDir)).toEqual([]);
  });

  test("non-interactive without --yes: no fork, no files", async () => {
    const f = fixture();
    const err = ordinalError(f.rollout);
    const s = starter(err);
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f))).rejects.toBe(err);
    expect(s.calls).toEqual([false]);
    expect(readdirSync(f.nodeDir)).toEqual([]);
  });

  test("interactive answer other than yes: no fork, no files", async () => {
    const f = fixture();
    const err = ordinalError(f.rollout);
    const s = starter(err);
    const asked: string[] = [];
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { interactive: true, confirm: async (q) => { asked.push(q); return false; } }))).rejects.toBe(err);
    expect(asked.length).toBe(1);
    expect(s.calls).toEqual([false]);
    expect(readdirSync(f.nodeDir)).toEqual([]);
  });

  test("confirmed: read-only snapshot, fork, mapping recorded, original untouched", async () => {
    const f = fixture();
    const before = sha256OfFile(f.rollout);
    const s = starter(ordinalError(f.rollout));
    const lines: string[] = [];
    const r = await resumeOrForkOnMissingOrdinal(s.start, opts(f, { interactive: true, confirm: async () => true, log: (l) => lines.push(l) }));
    expect(r.threadId).toBe(NEW);
    expect(s.calls).toEqual([false, true]);
    expect(sha256OfFile(f.rollout)).toBe(before);
    const state = JSON.parse(readFileSync(join(f.nodeDir, FORK_RECOVERY_STATE_FILE), "utf8"));
    expect(state.forks).toHaveLength(1);
    const m = state.forks[0];
    expect([m.oldThreadId, m.newThreadId, m.originalRollout, m.sha256]).toEqual([OLD, NEW, f.rollout, before]);
    expect(m.snapshot.startsWith(join(f.nodeDir, FORK_RECOVERY_SNAPSHOT_DIR))).toBe(true);
    expect(sha256OfFile(m.snapshot)).toBe(before);
    expect(statSync(m.snapshot).mode & 0o222).toBe(0);
    expect(Number.isNaN(Date.parse(m.at))).toBe(false);
    expect(lines.join("\n")).toContain("keep it, do not move or delete it");
  });

  test("--yes without a terminal confirms", async () => {
    const f = fixture();
    const s = starter(ordinalError(f.rollout));
    const r = await resumeOrForkOnMissingOrdinal(s.start, opts(f, { yes: true }));
    expect(r.threadId).toBe(NEW);
    expect(existsSync(join(f.nodeDir, FORK_RECOVERY_STATE_FILE))).toBe(true);
  });

  test("original changed during the fork: refuse, no mapping", async () => {
    const f = fixture();
    const s = starter(ordinalError(f.rollout), () => appendFileSync(f.rollout, "{}\n"));
    await expect(resumeOrForkOnMissingOrdinal(s.start, opts(f, { yes: true }))).rejects.toThrow(/original rollout changed/);
    expect(existsSync(join(f.nodeDir, FORK_RECOVERY_STATE_FILE))).toBe(false);
  });

  test("a fork that returns the old thread id is refused", async () => {
    const f = fixture();
    const start = async (fork: boolean) => { if (!fork) throw ordinalError(f.rollout); return { threadId: OLD }; };
    await expect(resumeOrForkOnMissingOrdinal(start, opts(f, { yes: true }))).rejects.toThrow(/did not produce a new thread/);
    expect(existsSync(join(f.nodeDir, FORK_RECOVERY_STATE_FILE))).toBe(false);
  });
});
