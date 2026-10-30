// 2026-10-31 —— 重启意图标记的契约。
//
// 它替代的是「用退出码表达意图」，所以测试也要钉住那三件事：
//   ① 意图**持久**（进程退出后仍在）
//   ② 三态：absent / present / unreadable，且 unreadable 不许折成 absent
//   ③ 清除只由「兑现之后」触发，没有 TTL

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESTART_INTENT_FILE,
  clearRestartIntent,
  consumePlannedRestart,
  decideStart,
  readRestartIntent,
  writeRestartIntent,
} from "./restart-intent";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restart-intent-"));
});

const intent = { reason: "apply_restart_tier", at: 1_700_000_000_000, pid: 4242, boot_id: "d6fb613b-1" };

describe("writeRestartIntent / readRestartIntent", () => {
  test("round-trips the intent and persists it as a file (the point: it outlives the process)", () => {
    writeRestartIntent(dir, intent);
    expect(existsSync(join(dir, RESTART_INTENT_FILE))).toBe(true);
    const r = readRestartIntent(dir);
    expect(r).toEqual({ kind: "present", intent });
  });

  test("absent when there is no file — this is the normal 'no planned restart' case", () => {
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });
  });

  test("unreadable is its own state — invalid JSON must NOT look like 'no intent'", () => {
    writeFileSync(join(dir, RESTART_INTENT_FILE), "{ half-written", "utf8");
    expect(readRestartIntent(dir)).toEqual({ kind: "unreadable", error: "invalid_json" });
  });

  test("unreadable on wrong shape (a JSON that parses but isn't an intent)", () => {
    writeFileSync(join(dir, RESTART_INTENT_FILE), JSON.stringify({ at: 1 }), "utf8");
    expect(readRestartIntent(dir)).toEqual({ kind: "unreadable", error: "invalid_shape" });
  });

  test("write is atomic: no leftover temp files, and the target is always complete JSON", () => {
    for (let i = 0; i < 5; i += 1) writeRestartIntent(dir, { ...intent, at: intent.at + i });
    const entries = require("node:fs").readdirSync(dir) as string[];
    expect(entries).toEqual([RESTART_INTENT_FILE]);
    expect(() => JSON.parse(readFileSync(join(dir, RESTART_INTENT_FILE), "utf8"))).not.toThrow();
  });
});

describe("clearRestartIntent", () => {
  test("removes the marker (called after the intent is honoured)", () => {
    writeRestartIntent(dir, intent);
    clearRestartIntent(dir);
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });
  });

  test("is idempotent — clearing twice is not an error", () => {
    expect(() => { clearRestartIntent(dir); clearRestartIntent(dir); }).not.toThrow();
  });
});

describe("consumePlannedRestart（启动时调用一次）", () => {
  test("planned restart: reports it and clears the marker (lifecycle = one exit → next start)", () => {
    writeRestartIntent(dir, intent);
    const r = consumePlannedRestart(dir);
    expect(r.planned).toBe(true);
    expect(r.note).toContain("planned_restart:apply_restart_tier");
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });
  });

  test("no marker ⇒ planned:false with a plain note", () => {
    expect(consumePlannedRestart(dir)).toEqual({ planned: false, note: "no_planned_restart" });
  });

  test("unreadable marker is renamed, not deleted — keep the scene, stop the recurrence", () => {
    writeFileSync(join(dir, RESTART_INTENT_FILE), "not json", "utf8");
    const r = consumePlannedRestart(dir, () => 1234);
    expect(r.planned).toBe(false);
    expect(r.note).toContain("restart_intent_unreadable:invalid_json");
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });          // 不再触发
    expect(existsSync(join(dir, `${RESTART_INTENT_FILE}.bad-1234`))).toBe(true); // 但留了现场
  });
});

describe("decideStart", () => {
  test("no marker ⇒ start, not planned", () => {
    expect(decideStart(dir)).toEqual({ start: true, planned: false });
  });

  test("marker present ⇒ start, planned (the wrapper now knows this exit was intentional)", () => {
    writeRestartIntent(dir, intent);
    expect(decideStart(dir)).toEqual({ start: true, planned: true, intent });
  });

  test("unreadable ⇒ start but needs review — a bad file must not pin the node down forever", () => {
    writeFileSync(join(dir, RESTART_INTENT_FILE), "not json", "utf8");
    const d = decideStart(dir);
    expect(d.start).toBe(true);
    expect(d).toMatchObject({ needs_review: true, error: "invalid_json" });
  });

  test("no TTL: an old marker is still 'present' — expiry is the clear-after-honour, not a clock", () => {
    writeRestartIntent(dir, { ...intent, at: 1 }); // 1970
    const r = readRestartIntent(dir);
    expect(r.kind).toBe("present");
  });
});
