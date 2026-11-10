import { expect, test } from "bun:test";
import { cleanupAfterExit } from "./close-cleanup";

test("already reclaimed roots need no delay", async () => {
  let waits = 0;
  expect(await cleanupAfterExit(() => true, async () => { waits++; })).toBe(true);
  expect(waits).toBe(0);
});

test("rechecks the guard after the last descendant exits", async () => {
  let referenced = true;
  let checks = 0;
  expect(await cleanupAfterExit(() => { checks++; return !referenced; }, async (ms) => {
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(100);
    referenced = false;
  })).toBe(true);
  expect(checks).toBe(2);
});

test("persistent live, unknown or mismatched identity stays refused with bounded retries", async () => {
  let checks = 0;
  let waits = 0;
  expect(await cleanupAfterExit(() => { checks++; return false; }, async () => { waits++; })).toBe(false);
  expect(checks).toBe(51);
  expect(waits).toBe(50);
});

test("cleanup errors are not converted into successful reclamation", async () => {
  await expect(cleanupAfterExit(() => { throw new Error("identity check failed"); })).rejects.toThrow("identity check failed");
});
