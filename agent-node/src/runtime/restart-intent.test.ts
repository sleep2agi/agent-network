// 2026-10-31 —— 重启意图标记的契约。
//
// 它替代的是「用退出码表达意图」，所以测试也要钉住那三件事：
//   ① 意图**持久**（进程退出后仍在）
//   ② 三态：absent / present / unreadable，且 unreadable 不许折成 absent
//   ③ 清除只由「兑现之后」触发；**时效判据先比内核 boot_id，再比时间**（见 TTL 段）

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

const intent = {
  reason: "apply_restart_tier",
  at: 1_700_000_000_000,
  pid: 4242,
  boot_id: "d6fb613b-1",
  instruction_id: "upd_123",
  target_version: "1.20.12",
};

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
  const BOOT = "boot-aaaa";
  // 同 boot、未超 TTL 的唯一一支才叫 planned
  test("same boot + fresh ⇒ planned, and the marker is cleared (lifecycle = one exit → next start)", () => {
    writeRestartIntent(dir, { ...intent, boot_id: BOOT });
    const r = consumePlannedRestart(dir, { now: () => intent.at + 5_000, bootId: () => BOOT });
    expect(r.verdict).toBe("planned");
    expect(r.planned).toBe(true);
    expect(r.note).toContain("planned_restart:apply_restart_tier");
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });
  });

  test("no marker ⇒ absent, and the note says the two meanings are indistinguishable", () => {
    const r = consumePlannedRestart(dir, { bootId: () => BOOT });
    expect(r.verdict).toBe("absent");
    expect(r.planned).toBe(false);
    // 不在测试里逐字比对整句，但必须钉住那条**歧义**：没有标记 ≠ 没要求过重启
    expect(r.note).toContain("ambiguous");
  });

  test("unreadable marker is renamed, not deleted — keep the scene, stop the recurrence", () => {
    writeFileSync(join(dir, RESTART_INTENT_FILE), "not json", "utf8");
    const r = consumePlannedRestart(dir, { now: () => 1234, bootId: () => BOOT });
    expect(r.verdict).toBe("unreadable");
    expect(r.planned).toBe(false);
    expect(r.note).toContain("restart_intent_unreadable:invalid_json");
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" });
    expect(existsSync(join(dir, `${RESTART_INTENT_FILE}.bad-1234`))).toBe(true);
  });

  // 🔴 本轮修的静默误归因：陈旧的意图会把「崩溃/重启机器」造成的启动说成「按计划重启」
  test("different boot ⇒ stale_reboot: this start cannot have been caused by that intent (no threshold involved)", () => {
    writeRestartIntent(dir, { ...intent, boot_id: BOOT });
    const r = consumePlannedRestart(dir, { now: () => intent.at + 1_000, bootId: () => "boot-bbbb" });
    expect(r.verdict).toBe("stale_reboot");
    expect(r.planned).toBe(false);
    expect(r.note).toContain("NOT caused by it");
    expect(readRestartIntent(dir)).toEqual({ kind: "absent" }); // 仍然读一次就清，不回流
  });

  test("same boot but older than TTL ⇒ stale: not attributed, and still starts", () => {
    writeRestartIntent(dir, { ...intent, boot_id: BOOT });
    const r = consumePlannedRestart(dir, { now: () => intent.at + 11 * 60 * 1000, bootId: () => BOOT });
    expect(r.verdict).toBe("stale");
    expect(r.planned).toBe(false);
    expect(r.note).toContain("restart_intent_stale");
  });

  test("either side's boot_id unknown ⇒ unknown_age (land on 'I cannot tell', never on 'planned')", () => {
    writeRestartIntent(dir, { ...intent, boot_id: BOOT });
    expect(consumePlannedRestart(dir, { now: () => intent.at + 1_000, bootId: () => null }).verdict).toBe("unknown_age");

    writeRestartIntent(dir, { ...intent, boot_id: null });
    expect(consumePlannedRestart(dir, { now: () => intent.at + 1_000, bootId: () => BOOT }).verdict).toBe("unknown_age");
  });

  test("missing `at` (0) ⇒ unknown_age, not stale: 'I don't know how old' ≠ 'I know it's old'", () => {
    writeRestartIntent(dir, { ...intent, at: 0, boot_id: BOOT });
    const r = consumePlannedRestart(dir, { now: () => 1_000, bootId: () => BOOT });
    expect(r.verdict).toBe("unknown_age");
    expect(r.planned).toBe(false);
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

// 2026-10-31 —— **「谁可以读这个标记」本身要是一条断言**（外部复核那条的落点）：
// 对方在另一处确认「把 pending 置 true 只是人工队列标记，不是自动任务触发器」，
// 靠的是把**写入点与读取点逐个清点**。本仓的等价物是 restart-intent.json：
//   · 写：cli.ts 的两处（计划内重启发起时）
//   · 读：consumePlannedRestart（cli.ts:8204 启动路径）
// 只要有人新增第三个读点并据此重启，标记就从一个「意图」变成了「触发器」——
// 而两次重启在日志里长得一模一样。
describe("谁可以读 restart-intent（消费者清单）", () => {
  test("引用点必须与登记表完全一致；新增消费者 = 新增决定，必须改这里", async () => {
    const { execSync } = await import("node:child_process");
    const { readFileSync: rf } = await import("node:fs");
    const repo = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
    // ⚠️ `git ls-files` 只列 **tracked**：刚写的新消费者在 `git add` 之前看不见 ——
    //    而「没人读它」与「我看不到有人读它」同形（今天在测试清单门里踩过一次）。
    // ⇒ 把未跟踪但未被忽略的文件也并进来。
    const trackedList = execSync(
      "git ls-files 'agent-node/src/*.ts' 'agent-network/src/*.ts' 'server/src/*.ts'",
      { cwd: repo, encoding: "utf8" },
    ).split("\n").filter(Boolean);
    const untrackedList = execSync(
      "git ls-files -o --exclude-standard 'agent-node/src/*.ts' 'agent-network/src/*.ts' 'server/src/*.ts'",
      { cwd: repo, encoding: "utf8" },
    ).split("\n").filter(Boolean);
    const files = [...new Set([...trackedList, ...untrackedList])];
    const KNOWN = new Set([
      "agent-node/src/cli.ts",                 // 唯一的生产者 + 唯一的消费者（启动路径）
      "agent-node/src/runtime/config-apply.ts", // 只在注释里提及，不 import
      "agent-node/src/runtime/restart-intent.ts", // 定义本身
      "agent-node/src/runtime/restart-intent.test.ts", // 本文件（含这条清单断言）
    ]);
    const refs = files.filter((f) => {
      if (KNOWN.has(f)) return false;
      const body = rf(join(repo, f), "utf8");
      return /from "\.[^"]*restart-intent(\.js)?"|require\("\.[^"]*restart-intent/.test(body);
    });
    expect(refs).toEqual([]); // 有新增消费者 ⇒ 先在这里登记，再谈它会不会自己重启
  });
});
