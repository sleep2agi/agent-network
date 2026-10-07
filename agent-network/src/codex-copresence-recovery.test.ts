import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { backupCodexRecoveryState, codexTopologyAudit, quiesceThenSnapshot, resumeAndVerifyCodexThread, verifyCodexThreadHistory } from "./codex-copresence-recovery";

describe("Codex co-presence recovery", () => {
  test("resume requires exact thread identity and persisted history", () => {
    const v = verifyCodexThreadHistory("thread/resume", "thread_old", { thread: { id: "thread_old", turns: [{ id: "turn_1", status: "completed" }] } }, new Date("2026-08-25T00:00:00Z"));
    expect(v.threadId).toBe("thread_old");
    expect(v.historyTurnCount).toBe(1);
    expect(() => verifyCodexThreadHistory("thread/resume", "thread_old", { thread: { id: "thread_new", turns: [{ id: "x" }] } })).toThrow("identity mismatch");
    expect(() => verifyCodexThreadHistory("thread/resume", "thread_old", { thread: { id: "thread_old", turns: [] } })).toThrow("no persisted history");
    expect(verifyCodexThreadHistory("thread/resume", "thread_old", { thread: { id: "thread_old" } }).historyTurnCount).toBe(0);
  });

  test("stub resume failure is fail-closed and never calls thread/start", async () => {
    const calls: string[] = [];
    await expect(resumeAndVerifyCodexThread("thread_old", async (method) => {
      calls.push(method);
      if (method === "thread/resume") return { thread: { id: "thread_old" } };
      return { thread: { id: "thread_old", turns: [] } };
    })).rejects.toThrow("no persisted history");
    expect(calls).toEqual(["thread/resume", "thread/read"]);
    expect(calls).not.toContain("thread/start");
  });

  test("resume and verification never hydrate the full thread history", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    await resumeAndVerifyCodexThread("thread_old", async (method, params) => {
      calls.push({ method, params });
      return method === "thread/resume" ? { model: "gpt-test" } : { thread: { id: "thread_old" } };
    }, "gpt-test");
    expect(calls).toEqual([
      { method: "thread/resume", params: { threadId: "thread_old", excludeTurns: true, model: "gpt-test" } },
      { method: "thread/read", params: { threadId: "thread_old", includeTurns: false } },
    ]);
  });

  test("backup preserves config and session state but excludes credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-recovery-"));
    const nodeDir = join(root, "node"); const codexHome = join(nodeDir, "codex-home");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ token: "ntok_secret", codexThreadId: "thread_old" }));
    writeFileSync(join(codexHome, "sessions", "old.jsonl"), "history");
    mkdirSync(join(codexHome, "sessions", "nested"));
    writeFileSync(join(codexHome, "sessions", "nested", "turn.jsonl"), "turn-history");
    writeFileSync(join(codexHome, "auth.json"), "SECRET_AUTH");
    const b = backupCodexRecoveryState({ nodeDir, codexHome, now: new Date("2026-08-25T01:02:03Z") });
    const configBackup = readFileSync(join(b.backupDir, "config-recovery.json"), "utf8");
    expect(configBackup).toContain("thread_old");
    expect(configBackup).not.toContain("ntok_secret");
    expect(readFileSync(join(b.backupDir, "codex-state", "sessions", "old.jsonl"), "utf8")).toBe("history");
    const manifest = readFileSync(join(b.backupDir, "manifest.json"), "utf8");
    expect(manifest).not.toContain("ntok_secret");
    expect(manifest).not.toContain("SECRET_AUTH");
    const parsedManifest = JSON.parse(manifest);
    expect(parsedManifest.stateFiles).toContainEqual({
      path: "sessions/nested/turn.jsonl",
      size: 12,
      sha256: "f47d9858f91531997fffdecff55a5ca4cccf094a12df08130da0e83216ad2f27",
    });
    expect(parsedManifest.stateFiles.some((entry: any) => entry.path === "sessions" && entry.sha256)).toBe(false);
  });

  test("active state writer is quiesced before the authoritative snapshot", async () => {
    const events: string[] = [];
    let writing = true;
    const captured = await quiesceThenSnapshot(async () => {
      events.push("quiesce:start");
      writing = false;
      events.push("quiesce:complete");
    }, () => {
      events.push("snapshot");
      if (writing) throw new Error("torn snapshot: writer still active");
      return "stable-state";
    });
    expect(captured).toBe("stable-state");
    expect(events).toEqual(["quiesce:start", "quiesce:complete", "snapshot"]);
  });

  test("recursive snapshot rejects symlinks instead of following state outside CODEX_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-recovery-link-"));
    const nodeDir = join(root, "node"); const codexHome = join(nodeDir, "codex-home");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ codexThreadId: "thread_old" }));
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "must-not-copy");
    symlinkSync(outside, join(codexHome, "sessions", "escape.jsonl"));
    expect(() => backupCodexRecoveryState({ nodeDir, codexHome })).toThrow("refuses symlink");
    expect(readdirSync(join(nodeDir, "recovery"))).toEqual([]);
  });

  test("a rollout larger than 2 GiB is copied and hashed without a whole-file Buffer", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-recovery-large-"));
    const nodeDir = join(root, "node");
    const sessions = join(nodeDir, "codex-home", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ codexThreadId: "large" }));
    const source = join(sessions, "large.jsonl");
    const bytes = 2 * 1024 ** 3 + 4096;
    writeFileSync(source, "prefix");
    truncateSync(source, bytes);
    const backup = backupCodexRecoveryState({ nodeDir, codexHome: join(nodeDir, "codex-home") });
    const target = join(backup.backupDir, "codex-state", "sessions", "large.jsonl");
    expect(statSync(target).size).toBe(bytes);
    const manifest = JSON.parse(readFileSync(join(backup.backupDir, "manifest.json"), "utf8"));
    expect(manifest.stateFiles[0]).toMatchObject({ path: "sessions/large.jsonl", size: bytes });
    expect(manifest.stateFiles[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // A sparse fixture must stay sparse; otherwise this test itself would need >2 GiB disk.
    expect(statSync(target).blocks * 512).toBeLessThan(32 * 1024 ** 2);
  }, 30_000);

  test("audit exposes topology without config secrets", () => {
    const audit = codexTopologyAudit({ codexCopresence: true, codexThreadId: "thread_1", token: "ntok_secret", flags: { sandboxMode: "read-only" } }, "/nodes/n1", "/work");
    expect(audit.threadId).toBe("thread_1");
    expect(JSON.stringify(audit)).not.toContain("ntok_secret");
  });

  test("launcher is fail-closed unless the operator explicitly skips recovery backup", () => {
    const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");
    expect(cli.match(/persistCodexRecoveryPoint\(resolved, opts\.codexHome, opts\.skipRecoveryBackup === true\)/g)).toHaveLength(2);
    expect(cli).toContain("--skip-recovery-backup: STARTING WITHOUT A CODEX RECOVERY POINT");
    expect(cli).toContain(`skipRecoveryBackup: opts["skip-recovery-backup"] === "true"`);
  });
});
