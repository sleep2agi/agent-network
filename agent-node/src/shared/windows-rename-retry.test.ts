import { describe, expect, test } from "bun:test";
import { renameOverExistingSync } from "./windows-rename-retry";

const eperm = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

describe("#2222 win32 rename over a briefly-held target", () => {
  test("retries the exact bounded backoff, then succeeds", () => {
    const calls: string[] = [], sleeps: number[] = [];
    let failures = 3;
    renameOverExistingSync("a.tmp", "a.json", (from, to) => {
      calls.push(`${from}->${to}`);
      if (failures-- > 0) throw eperm();
    }, (ms) => sleeps.push(ms), "win32");
    expect(calls.length).toBe(4);
    expect(sleeps).toEqual([10, 25, 50]);
  });

  test("stops after 5 attempts and rethrows（有界,不是死循环）", () => {
    let calls = 0;
    expect(() => renameOverExistingSync("a.tmp", "a.json", () => { calls++; throw eperm(); }, () => {}, "win32")).toThrow("EPERM");
    expect(calls).toBe(5);
  });

  test("posix never retries（那边覆盖打开中的文件本该成功,重试只会掩盖真问题）", () => {
    let calls = 0;
    expect(() => renameOverExistingSync("a.tmp", "a.json", () => { calls++; throw eperm(); }, () => {}, "linux")).toThrow("EPERM");
    expect(calls).toBe(1);
  });

  test("win32 non-transient errors skip the backoff entirely", () => {
    let calls = 0, sleeps = 0;
    expect(() => renameOverExistingSync("a.tmp", "a.json", () => {
      calls++; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }, () => { sleeps++; }, "win32")).toThrow("ENOENT");
    expect([calls, sleeps]).toEqual([1, 0]);
  });
});
