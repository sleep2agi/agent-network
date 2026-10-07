import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRolloutCodexCompat,
  compareVersions,
  describeMissingOrdinalFailure,
  FIRST_LINE_CHUNK_BYTES,
  parseRolloutHistoryMode,
  readRolloutFirstLine,
} from "./codex-rollout-history-guard.js";
import { nodeRolloutGuard } from "./codex-rollout-guard-node.js";

const THREAD = "01a11846-d796-72f1-af68-8d9215a65dc8";
const meta = (historyMode?: string) =>
  JSON.stringify({ timestamp: "t", ...(historyMode ? { ordinal: 0 } : {}), type: "session_meta", payload: { id: THREAD, cli_version: "0.159.2", ...(historyMode ? { history_mode: historyMode } : {}) } });

function tmpHome(): string { return mkdtempSync(join(tmpdir(), "r734-")); }
function writeRollout(home: string, firstLine: string, rest = ""): string {
  const dir = join(home, "sessions", "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `rollout-2026-10-07T21-30-58-${THREAD}.jsonl`);
  writeFileSync(p, `${firstLine}\n${rest}`);
  return p;
}
const POINT = ["use a newer codex"];

describe("board #734 rollout history guard", () => {
  test("the agent-network copy is byte-identical", () => {
    const here = readFileSync(join(import.meta.dir, "codex-rollout-history-guard.ts"), "utf8");
    const there = readFileSync(join(import.meta.dir, "..", "..", "..", "agent-network", "src", "codex-rollout-history-guard.ts"), "utf8");
    expect(there).toBe(here);
  });

  test("version compare", () => {
    expect(compareVersions("0.133.0", "0.145.0")! < 0).toBe(true);
    expect(compareVersions("codex-cli 0.159.2", "0.145.0")! > 0).toBe(true);
    expect(compareVersions("0.145.0", "0.145.0")).toBe(0);
    expect(compareVersions("0.144.9", "0.145.0")! < 0).toBe(true);
    expect(compareVersions("garbage", "0.145.0")).toBeNull();
  });

  test("history_mode parse: paginated / legacy / not session_meta / not JSON", () => {
    expect(parseRolloutHistoryMode(meta("paginated"))).toEqual({ ok: true, historyMode: "paginated" });
    expect(parseRolloutHistoryMode(meta())).toEqual({ ok: true, historyMode: null });
    expect(parseRolloutHistoryMode(JSON.stringify({ type: "event_msg", payload: {} })).ok).toBe(false);
    expect(parseRolloutHistoryMode("{not json").ok).toBe(false);
  });

  test("blocks codex 0.133 on a paginated rollout; message is actionable", () => {
    const home = tmpHome();
    try {
      const p = writeRollout(home, meta("paginated"));
      const before = readFileSync(p);
      const v = checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: p, codexBin: "/opt/c133/codex", codexVersion: "0.133.0", pointAtNewerCodex: POINT });
      expect(v.verdict).toBe("block");
      const text = v.verdict === "block" ? v.lines.join("\n") : "";
      expect(text).toContain("refusing to start codex 0.133.0");
      expect(text).toContain("0.145.0");
      expect(text).toContain("board #734");
      expect(text).toContain("use a newer codex");
      expect(readFileSync(p).equals(before)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("allows 0.159.2 on paginated, and 0.133 on legacy", () => {
    const home = tmpHome();
    try {
      const p = writeRollout(home, meta("paginated"));
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: p, codexBin: "c", codexVersion: "0.159.2", pointAtNewerCodex: POINT }).verdict).toBe("allow");
      writeFileSync(p, `${meta()}\n`);
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: p, codexBin: "c", codexVersion: "0.133.0", pointAtNewerCodex: POINT }).verdict).toBe("allow");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("missing file / unparsable first line / unknown version never block", () => {
    const home = tmpHome();
    try {
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: null, codexBin: "c", codexVersion: "0.133.0", pointAtNewerCodex: POINT }).verdict).toBe("unknown");
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: join(home, "nope.jsonl"), codexBin: "c", codexVersion: "0.133.0", pointAtNewerCodex: POINT }).verdict).toBe("unknown");
      const p = writeRollout(home, "{garbage");
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: p, codexBin: "c", codexVersion: "0.133.0", pointAtNewerCodex: POINT }).verdict).toBe("unknown");
      writeFileSync(p, `${meta("paginated")}\n`);
      expect(checkRolloutCodexCompat({ threadId: THREAD, rolloutPath: p, codexBin: "c", codexVersion: null, pointAtNewerCodex: POINT }).verdict).toBe("unknown");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("first-line read is bounded: reads one chunk of a large file", () => {
    const home = tmpHome();
    try {
      const p = writeRollout(home, meta("paginated"), "x".repeat(8 * 1024 * 1024) + "\n");
      const r = readRolloutFirstLine(p);
      expect(r.line).toBe(meta("paginated"));
      expect(r.bytesRead).toBeLessThanOrEqual(FIRST_LINE_CHUNK_BYTES);
      // A first line longer than the cap does not block and stops at the cap.
      writeFileSync(p, "y".repeat(3 * 1024 * 1024));
      const capped = readRolloutFirstLine(p, 1024 * 1024);
      expect(capped.line).toBeNull();
      expect(capped.bytesRead).toBe(1024 * 1024);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a first line spanning several chunks is assembled", () => {
    const home = tmpHome();
    try {
      const long = JSON.stringify({ type: "session_meta", payload: { base_instructions: "z".repeat(200_000), history_mode: "paginated" } });
      const p = writeRollout(home, long, "{}\n");
      expect(readRolloutFirstLine(p).line).toBe(long);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("nodeRolloutGuard locates the rollout under CODEX_HOME and probes the version only for paginated", () => {
    const home = tmpHome();
    try {
      let probes = 0;
      writeRollout(home, meta());
      const legacy = nodeRolloutGuard({ threadId: THREAD, env: { CODEX_HOME: home }, codexBin: "c", codexVersion: () => { probes++; return "0.133.0"; }, pointAtNewerCodex: POINT });
      expect(legacy.block).toBeNull();
      expect(probes).toBe(0);
      writeRollout(home, meta("paginated"));
      const blocked = nodeRolloutGuard({ threadId: THREAD, env: { CODEX_HOME: home }, codexBin: "c", codexVersion: () => { probes++; return "0.133.0"; }, pointAtNewerCodex: POINT });
      expect(blocked.block).not.toBeNull();
      expect(probes).toBe(1);
      const missing = nodeRolloutGuard({ threadId: "00000000-0000-0000-0000-000000000000", env: { CODEX_HOME: home }, codexBin: "c", codexVersion: () => "0.133.0", pointAtNewerCodex: POINT });
      expect(missing.block).toBeNull();
      expect(missing.warnings.join("\n")).toContain("not found");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("missing-ordinal diagnosis names cause, untouched file, options and the read-only check", () => {
    const err = "-32603: error resuming thread: Fatal error: Failed to initialize session: thread-store internal error: failed to resume local thread recorder: final paginated rollout record at /h/sessions/2026/10/07/rollout-x.jsonl is missing an ordinal";
    const text = describeMissingOrdinalFailure(err, { threadId: THREAD }).join("\n");
    expect(text).toContain("mixes codex versions");
    expect(text).toContain("untouched: /h/sessions/2026/10/07/rollout-x.jsonl");
    expect(text).toContain("fork recovery");
    expect(text).toContain("--new-session");
    expect(text).toContain("head -n 1 '/h/sessions/2026/10/07/rollout-x.jsonl'");
    expect(describeMissingOrdinalFailure("no rollout found for thread")).toEqual([]);
  });
});
