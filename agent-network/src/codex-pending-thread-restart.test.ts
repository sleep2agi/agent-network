import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePendingThreadAtStart, findThreadRollouts, reconcilePendingThreadAtStart } from "./codex-pending-thread-restart";

const M1 = "8e5c181e-95e4-4fae-a09d-ca8b56ea7f52";
const M2 = "11111111-2222-4333-8444-555555555555";
const TID = "01a10dbe-2b8b-7ca1-8979-e219de11a750";
const pending = (marker = M1, threadId = TID) => ({ version: 1, threadId, serverUrl: "ws://127.0.0.1:24700", marker });
const none = () => [] as string[];
const has = (path = "/x/rollout-2026-10-06T00-00-00-" + TID + ".jsonl") => () => [path];

describe("#602 decidePendingThreadAtStart", () => {
  test("no candidate → nothing to do", () => {
    expect(decidePendingThreadAtStart(undefined, { kind: "missing" }, none)).toEqual({ kind: "none" });
  });

  test("marker on disk and bound to it but no rollout → drop the unmaterialized fresh candidate", () => {
    expect(decidePendingThreadAtStart(pending(), { kind: "ok", marker: M1 }, none))
      .toEqual({ kind: "drop-unmaterialized", threadId: TID });
  });

  test("marker on disk and bound to it with a rollout → migrate the materialized candidate", () => {
    expect(decidePendingThreadAtStart(pending(), { kind: "ok", marker: M1 }, has()))
      .toEqual({ kind: "migrate", oldMarker: M1 });
  });

  test("marker on disk but candidate bound to another marker → refuse (unchanged)", () => {
    expect(decidePendingThreadAtStart(pending(M2), { kind: "ok", marker: M1 }, none).kind).toBe("refuse");
  });

  test("marker untrustworthy (corrupt/mode/owner) → refuse, never dropped", () => {
    expect(decidePendingThreadAtStart(pending(), { kind: "unreadable", cause: "WRONG_MODE" }, none).kind).toBe("refuse");
  });

  test("the bug: marker removed by a clean stop, thread never had a rollout → drop, start fresh", () => {
    expect(decidePendingThreadAtStart(pending(), { kind: "missing" }, none))
      .toEqual({ kind: "drop-unmaterialized", threadId: TID });
  });

  test("marker gone but the thread HAS a rollout → refuse (never adopt an unproven binding)", () => {
    const d = decidePendingThreadAtStart(pending(), { kind: "missing" }, has());
    expect(d.kind).toBe("refuse");
    expect((d as any).reason).toContain("rollout");
  });

  test("marker gone and the rollout search failed → refuse", () => {
    expect(decidePendingThreadAtStart(pending(), { kind: "missing" }, () => null).kind).toBe("refuse");
  });

  test("marker gone and the candidate is malformed → refuse", () => {
    for (const bad of [null, {}, { ...pending(), version: 2 }, { ...pending(), threadId: "../../x" }, { ...pending(), threadId: 7 }]) {
      expect(decidePendingThreadAtStart(bad, { kind: "missing" }, none).kind).toBe("refuse");
    }
  });

  test("rollout lookup is asked for exactly the candidate's thread id", () => {
    const asked: string[] = [];
    decidePendingThreadAtStart(pending(), { kind: "missing" }, (t) => { asked.push(t); return []; });
    expect(asked).toEqual([TID]);
  });
});

describe("#602 findThreadRollouts", () => {
  const home = () => mkdtempSync(join(tmpdir(), "t602-"));

  test("no sessions dirs at all → no rollouts (not an error)", () => {
    expect(findThreadRollouts(home(), TID)).toEqual([]);
    expect(findThreadRollouts(join(home(), "does-not-exist"), TID)).toEqual([]);
  });

  test("finds the exact thread under sessions/YYYY/MM/DD and archived_sessions, ignores other threads", () => {
    const h = home();
    mkdirSync(join(h, "sessions/2026/10/06"), { recursive: true });
    mkdirSync(join(h, "archived_sessions"), { recursive: true });
    const a = join(h, `sessions/2026/10/06/rollout-2026-10-06T01-02-03-${TID}.jsonl`);
    const b = join(h, `archived_sessions/rollout-2026-10-05T01-02-03-${TID}.jsonl`);
    writeFileSync(a, "{}\n"); writeFileSync(b, "{}\n");
    writeFileSync(join(h, "sessions/2026/10/06/rollout-2026-10-06T01-02-03-01a10dbe-0000-7ca1-8979-e219de11a750.jsonl"), "{}\n");
    expect(findThreadRollouts(h, TID)).toEqual([b, a].sort());
  });

  test("an empty rollout file still counts (the thread was persisted)", () => {
    const h = home();
    mkdirSync(join(h, "sessions/2026/10/06"), { recursive: true });
    writeFileSync(join(h, `sessions/2026/10/06/rollout-x-${TID}.jsonl`), "");
    expect(findThreadRollouts(h, TID)?.length).toBe(1);
  });

  test("an unreadable directory makes the whole lookup fail (caller refuses)", () => {
    if (process.getuid?.() === 0) return; // root reads through 000
    const h = home();
    mkdirSync(join(h, "sessions/2026"), { recursive: true });
    chmodSync(join(h, "sessions/2026"), 0o000);
    try { expect(findThreadRollouts(h, TID)).toBeNull(); }
    finally { chmodSync(join(h, "sessions/2026"), 0o755); }
  });
});

describe("#602 stopped-generation config reconciliation", () => {
  test("Windows start -> stop -> start drops an unmaterialized pending thread before relaunch", () => {
    const stoppedWindowsConfig = {
      node_id: "node_windows",
      codexPendingThread: pending(),
      codexAppServerUrl: "ws://127.0.0.1:24700",
    };
    const result = reconcilePendingThreadAtStart(stoppedWindowsConfig, { kind: "missing" }, none);
    expect(result.kind).toBe("drop-unmaterialized");
    expect(result.changed).toBe(true);
    expect(result.config).toEqual({ node_id: "node_windows", codexAppServerUrl: "ws://127.0.0.1:24700" });
    // The caller's snapshot is not mutated before the private atomic write.
    expect(stoppedWindowsConfig.codexPendingThread).toEqual(pending());
  });

  test("a materialized stopped-generation candidate remains fail-closed", () => {
    const result = reconcilePendingThreadAtStart({ codexPendingThread: pending() }, { kind: "missing" }, has());
    expect(result.kind).toBe("refuse");
    expect(result.changed).toBe(false);
  });
});

describe("#602 wiring in anet node start", () => {
  const cli = readFileSync(join(import.meta.dir, "../bin/cli.ts"), "utf8");
  const start = cli.indexOf("let prelaunchCfg = JSON.parse(");
  const reap = cli.indexOf("const identityPrep = await prepareIdentityForStart(", start);

  test("the decision runs before the previous generation is reaped and before any session starts", () => {
    const at = cli.indexOf("reconcilePendingThreadAtStart(", start);
    expect(start).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(start);
    expect(at).toBeLessThan(reap);
  });

  test("only a MISSING marker maps to `missing`; every other refusal cause stays untrustworthy", () => {
    const block = cli.slice(start, reap);
    expect(block).toContain(`oldIdentity.cause === "MISSING" ? { kind: "missing" }`);
    expect(block).toContain(`{ kind: "unreadable", cause: oldIdentity.cause }`);
  });

  test("rollouts are looked up in the CODEX_HOME this launch hands to the app-server", () => {
    expect(cli.slice(start, reap)).toContain("findThreadRollouts(opts.codexHome, tid)");
  });

  test("refuse still exits before any reap/start", () => {
    const block = cli.slice(start, reap);
    const refuse = block.indexOf(`pendingDecision.kind === "refuse"`);
    expect(refuse).toBeGreaterThan(0);
    expect(block.indexOf("process.exit(1)", refuse)).toBeGreaterThan(refuse);
  });

  test("Windows uses the same pending-thread decision and persists a dropped unmaterialized candidate", () => {
    const windowsStart = cli.indexOf("async function startWindowsCodexCopresence(");
    const snapshot = cli.indexOf("await quiesceThenSnapshot(", windowsStart);
    const block = cli.slice(windowsStart, snapshot);
    expect(block).toContain("const pendingDecision = reconcilePendingThreadAtStart(");
    expect(block).toContain("findThreadRollouts(opts.codexHome, tid)");
    expect(block).toContain(`pendingDecision.kind === "drop-unmaterialized"`);
    expect(block).toContain("recoveryCfg = pendingDecision.config;");
    expect(block).toContain("atomicWritePrivateJson(recoveryCfgPath, recoveryCfg);");
  });
});
