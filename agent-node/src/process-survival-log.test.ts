import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function start(mode: string): { child: ChildProcessWithoutNullStreams; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "t705-survival-"));
  roots.push(dir);
  const child = spawn(process.execPath, [join(import.meta.dir, "process-survival-log.fixture.ts"), dir, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, dir };
}

function ended(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

function datedLog(dir: string): string {
  return readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.log`), "utf8");
}

describe("agent-node process survival log", () => {
  test("the production logger switches to file-only output after EPIPE", () => {
    const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    const installAt = source.indexOf("const processSurvivalLog = installProcessSurvivalLog({");
    const loggerAt = source.indexOf("function _log(");
    expect(installAt).toBeGreaterThan(-1);
    expect(loggerAt).toBeGreaterThan(installAt);
    expect(source).toContain("if (!processSurvivalLog.outputBroken()) console.log(line);");
  });

  test("closed stdout records EPIPE and the process stays alive", async () => {
    const { child, dir } = start("epipe");
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => {
        child.stdout.destroy();
        resolve();
      });
    });
    expect(await ended(child)).toBe(0);
    const log = datedLog(dir);
    expect(log).toContain("[stream] stdout EPIPE");
    expect(log).toContain("[exit] code=0 reason=normal");
  });

  test("repeated broken-stream notifications record EPIPE only once", async () => {
    const { child, dir } = start("repeat-epipe");
    expect(await ended(child)).toBe(0);
    const matches = datedLog(dir).match(/\[stream\].*EPIPE/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  test("uncaught exception preserves its stack on stderr and in the synchronous log", async () => {
    const { child, dir } = start("uncaught");
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    expect(await ended(child)).toBe(1);
    expect(stderr).toContain("Error: deliberate uncaught probe");
    expect(stderr).toContain("process-survival-log.fixture.ts");
    const log = datedLog(dir);
    expect(log).toMatch(/\[\d\d:\d\d:\d\d\] \[ERROR\] \[agent-node\] \[fatal\] uncaughtException:/);
    expect(log).toContain("process-survival-log.fixture.ts");
    expect(log).toContain("[exit] code=1 reason=uncaughtException: Error: deliberate uncaught probe");
  });

  test("unhandled rejection exits 1 with a synchronous reason", async () => {
    const { child, dir } = start("rejection");
    expect(await ended(child)).toBe(1);
    expect(datedLog(dir)).toContain("[exit] code=1 reason=unhandledRejection: Error: deliberate rejection probe");
  });

  test("Grok CLI survival diagnostics use the hardened private-log writer", () => {
    const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    expect(source).toContain('appendLine: GROK_EXECUTION_MODE === "cli"');
    expect(source).toContain("appendPrivateLogLine(PRIVATE_LOG_DIR");
  });
});
