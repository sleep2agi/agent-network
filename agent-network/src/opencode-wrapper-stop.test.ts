import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import {
  signalExactProcessGracefully,
  stopExactProcessTermOnly,
  type ExactProcessState,
} from "./opencode-wrapper-stop";

const children: ChildProcess[] = [];
const detachedGroups: number[] = [];

function procStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return close < 0 ? undefined : stat.slice(close + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function exactState(pid: number, startTime: string): ExactProcessState {
  const current = procStartTime(pid);
  if (current === undefined) {
    try {
      process.kill(pid, 0);
      return "unknown";
    } catch {
      return "exited-or-reused";
    }
  }
  return current === startTime ? "same" : "exited-or-reused";
}

async function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), timeoutMs)),
  ]);
}

async function waitForProcState(pid: number, wanted: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = readFileSync(`/proc/${pid}/stat`, "utf8").match(/\)\s+([A-Z])/i)?.[1];
      if (state === wanted) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`process ${pid} did not enter state ${wanted}`);
}

afterEach(async () => {
  for (const pgid of detachedGroups.splice(0)) {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(child.pid, "SIGCONT"); } catch {}
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      await waitForExit(child).catch(() => {});
    }
  }
});

describe("bound OpenCode wrapper TERM-only stop", () => {
  test("a responsive wrapper exits after SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    const pid = child.pid!;
    const startTime = procStartTime(pid)!;

    expect(await stopExactProcessTermOnly({
      pid,
      readState: () => exactState(pid, startTime),
      timeoutMs: 2_000,
      pollMs: 10,
    })).toBe(true);
    await waitForExit(child);
  });

  test("a parent-forwarded SIGINT retains a SIGSTOP'd wrapper and detached child", async () => {
    const wrapperSource = [
      'const { spawn } = require("child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '  { detached: true, stdio: "ignore" });',
      'process.stdout.write(String(child.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const child = spawn(process.execPath, ["-e", wrapperSource], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    const pid = child.pid!;
    const startTime = procStartTime(pid)!;
    const detachedPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wrapper did not report detached child")), 2_000);
      child.stdout!.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(Number(String(chunk).trim()));
      });
    });
    detachedGroups.push(detachedPid);
    expect(procStartTime(detachedPid)).toBeDefined();
    process.kill(pid, "SIGSTOP");
    await waitForProcState(pid, "T");

    expect(await signalExactProcessGracefully({
      pid,
      readState: () => exactState(pid, startTime),
      timeoutMs: 100,
      pollMs: 10,
    }, "SIGINT")).toBe(false);
    expect(exactState(pid, startTime)).toBe("same");
    expect(readFileSync(`/proc/${pid}/stat`, "utf8").match(/\)\s+([A-Z])/i)?.[1]).toBe("T");
    // The failure retains the ownership relationship: the wrapper is still
    // present to resume its shutdown handler, and its detached ACP analogue
    // remains live instead of becoming an ownerless survivor after SIGKILL.
    expect(procStartTime(detachedPid)).toBeDefined();
    expect(Number(readFileSync(`/proc/${detachedPid}/stat`, "utf8")
      .slice(readFileSync(`/proc/${detachedPid}/stat`, "utf8").lastIndexOf(")") + 2)
      .trim().split(/\s+/)[2])).toBe(detachedPid);
  });
});
