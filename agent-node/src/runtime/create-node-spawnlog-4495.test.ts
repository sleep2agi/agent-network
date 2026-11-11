import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preserveSpawnLogDiagnostics } from "./create-node-daemon";

// #4495 —— 子进程 5 秒内退出时，原来 stdout/stderr 被 ignore，事后无从查起；
// 这里钉住：日志被带回（脱敏）并被复制到 failed-creates/ 下，越过 reap。
function freshNodeDir(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "spawnlog-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "logs", "spawn.log"), lines.join("\n"), "utf8");
  return dir;
}

describe("#4495 失败时保留 spawn 日志", () => {
  test("带回日志尾部（可读）", () => {
    const dir = freshNodeDir(["starting", "CommHubError: callCommHub(report_status) HTTP 401", "exit 1"]);
    const tail = preserveSpawnLogDiagnostics({ childDir: dir, requestId: "cr_x", homeDir: dir });
    expect(tail).toContain("report_status");
  });

  test("凭据被脱敏：ntok_/utok_/sk-/Bearer 都不许原样出现", () => {
    const dir = freshNodeDir([
      "token=ntok_abcdef123456",
      "user=utok_zzzzzz999999",
      "key=sk-livesecretvalue",
      "Authorization: Bearer abcdefghijklmnop",
    ]);
    const tail = preserveSpawnLogDiagnostics({ childDir: dir, requestId: "cr_y", homeDir: dir });
    expect(tail).not.toContain("ntok_abcdef123456");
    expect(tail).not.toContain("utok_zzzzzz999999");
    expect(tail).not.toContain("sk-livesecretvalue");
    expect(tail).toContain("[redacted]");
  });

  test("复制一份到 failed-creates/<request>.log（reap 之后仍可查）", () => {
    const dir = freshNodeDir(["boom"]);
    preserveSpawnLogDiagnostics({ childDir: dir, requestId: "cr_z", homeDir: dir });
    const files = readdirSync(join(dir, ".anet", "failed-creates"));
    expect(files).toEqual(["cr_z.log"]);
    expect(readFileSync(join(dir, ".anet", "failed-creates", "cr_z.log"), "utf8")).toContain("boom");
  });

  test("没有日志文件时返回空串，不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawnlog-empty-"));
    expect(preserveSpawnLogDiagnostics({ childDir: dir, requestId: "cr_none", homeDir: dir })).toBe("");
  });

  test("接线：spawn 的 stdio 指向 spawn.log，且失败路径调用本函数", () => {
    const src = readFileSync(join(import.meta.dir, "create-node-daemon.ts"), "utf8");
    expect(src).toContain('join(childDir, "logs", "spawn.log")');
    expect(src).toContain("spawnLogFd");
    expect(src).toContain("preserveSpawnLogDiagnostics({ childDir, requestId })");
    expect(src).toContain("spawn log tail:");
  });
});
