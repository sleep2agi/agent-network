import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimSharedSessionBridge } from "./source-resume-launcher";

function fixture() {
  const project = mkdtempSync("/work/namespace-");
  mkdirSync(join(project, ".anet"), { mode: 0o700 }); mkdirSync(join(project, ".anet", "nodes"), { mode: 0o700 });
  return { project, url: "http://127.0.0.1:29999", serverPid: process.pid, sessionId: "ses_Existing" };
}
test("shared exact ordinary resume and two attach names contend on one atomic namespace; owned close releases", async () => {
  const f = fixture(), workDir = join(f.project, ".anet", "nodes", "a");
  const ordinary = claimSharedSessionBridge({ ...f, workDir, consume: true });
  expect(() => claimSharedSessionBridge({ ...f, workDir: `${workDir}b`, requestId: "second" })).toThrow("source_resume_bridge_claimed");
  expect(() => claimSharedSessionBridge({ ...f, workDir: `${workDir}c`, consume: true })).toThrow("source_resume_bridge_claimed");
  ordinary.release();
  claimSharedSessionBridge({ ...f, workDir, requestId: "attach" });
  expect(() => claimSharedSessionBridge({ ...f, workDir: `${workDir}other`, consume: true })).toThrow();
  const attached = claimSharedSessionBridge({ ...f, workDir, requestId: "attach", consume: true });
  expect(() => claimSharedSessionBridge({ ...f, workDir, requestId: "attach", consume: true })).toThrow();
  attached.release();
});
test("independent processes race for same Session, at most one claim; unknown reservation never auto-clears", async () => {
  const f = fixture();
  const script = (name: string) => `import {claimSharedSessionBridge} from ${JSON.stringify(join(import.meta.dir, "source-resume-launcher.ts"))};
    try { claimSharedSessionBridge(${JSON.stringify({ ...f, workDir: join(f.project, ".anet", "nodes", name), requestId: name })}); process.exit(0) } catch { process.exit(3) }`;
  const children = ["a", "b"].map(n => Bun.spawn([process.execPath, "--eval", script(n)], { stdout: "ignore", stderr: "ignore" }));
  const codes = await Promise.all(children.map(c => c.exited));
  expect(codes.sort()).toEqual([0, 3]);
  expect(() => claimSharedSessionBridge({ ...f, workDir: join(f.project, ".anet", "nodes", "third"), consume: true })).toThrow();
});
test("old live bridge without namespace refuses and its health/process remains unchanged", () => {
  const f = fixture(), old = join(f.project, ".anet", "nodes", "legacy"); mkdirSync(old, { mode: 0o700 });
  const text = JSON.stringify({ generation: f.sessionId, bridge: { pid: process.pid } });
  writeFileSync(join(old, "opencode-launch-health.json"), text, { mode: 0o600 });
  expect(() => claimSharedSessionBridge({ ...f, workDir: `${old}-new`, requestId: "attach" })).toThrow("source_resume_bridge_owned");
  expect(readFileSync(join(old, "opencode-launch-health.json"), "utf8")).toBe(text);
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});
test("legacy unknown per-child claim is never treated as absence or removed", () => {
  const f = fixture(), old = join(f.project, ".anet", "nodes", "unknown"); mkdirSync(old, { mode: 0o700 });
  const text = JSON.stringify({ session_id: f.sessionId, nonce: "unknown" });
  const path = join(old, "source-resume-launch-claim.json"); writeFileSync(path, text, { mode: 0o600 });
  expect(() => claimSharedSessionBridge({ ...f, workDir: `${old}-new`, requestId: "attach" })).toThrow("source_resume_bridge_claimed");
  expect(readFileSync(path, "utf8")).toBe(text);
});
