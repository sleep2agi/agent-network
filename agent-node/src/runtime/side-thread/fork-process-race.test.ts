import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("cross-process stable fork operation has exactly one RPC executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-fork-process-")); roots.push(root);
  const worker = join(import.meta.dir, "fork-process-race-worker.ts");
  const a = Bun.spawn([process.execPath, worker, root, "a"], { stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(root, "list-ready-a"))) {
    if (Date.now() > deadline) throw new Error("first fork worker did not reach snapshot barrier");
    await Bun.sleep(1);
  }
  const b = Bun.spawn([process.execPath, worker, root, "b"], { stdout: "pipe", stderr: "pipe" });
  const [exitA, exitB] = await Promise.all([a.exited, b.exited]);
  expect([exitA, exitB]).toEqual([0, 0]);
  const rpcFiles = readdirSync(root).filter((name) => name.startsWith("fork-rpc-"));
  const results = readdirSync(root).filter((name) => name.startsWith("result-"))
    .map((name) => JSON.parse(readFileSync(join(root, name), "utf8")));
  expect(rpcFiles).toHaveLength(1);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => String(result.error).includes("already executing"))).toHaveLength(1);
});
