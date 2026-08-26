import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonIMCorrelationStore } from "./correlation-store";
import type { IMTaskCorrelation } from "./types";

let scratch = "";
let now = 1_000;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "anet-im-correlation-"));
  now = 1_000;
});

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function statePath(): string {
  return join(scratch, "channels", "feishu", "state.json");
}

function store(options: ConstructorParameters<typeof JsonIMCorrelationStore>[1] = {}) {
  return new JsonIMCorrelationStore(statePath(), {
    now: () => now,
    seenTtlMs: 500,
    terminalTtlMs: 700,
    ...options,
  });
}

function correlation(overrides: Partial<IMTaskCorrelation> = {}): IMTaskCorrelation {
  return {
    conversationRef: {
      platform: "feishu",
      conversationId: "oc_test_chat",
      conversationType: "group",
      threadRootId: "om_root",
    },
    sourceMessageId: "om_source",
    placeholderMessageId: "om_placeholder",
    status: "pending",
    createdAt: now,
    ...overrides,
  };
}

describe("JsonIMCorrelationStore", () => {
  test("records and reads idempotency keys across store instances", async () => {
    const first = store();
    await first.recordSeen("feishu:conn:message-1", "task-1");

    const second = store();
    expect(await second.hasSeen("feishu:conn:message-1")).toBe("task-1");
    expect(await second.hasSeen("feishu:conn:missing")).toBeNull();
  });

  test("stores task correlation needed to route a reply back to IM", async () => {
    const first = store();
    const value = correlation();

    await first.putCorrelation("task-1", value);

    const second = store();
    expect(await second.getCorrelation("task-1")).toEqual(value);
    expect(await second.getCorrelation("task-missing")).toBeNull();
  });

  test("updates task status without losing conversation routing fields", async () => {
    const s = store();
    await s.putCorrelation("task-1", correlation());

    now = 1_200;
    await s.updateStatus("task-1", "completed");

    expect(await s.getCorrelation("task-1")).toEqual({
      ...correlation({ status: "completed" }),
      createdAt: 1_000,
    });
  });

  test("gc removes expired seen keys and terminal correlations only", async () => {
    const s = store();
    await s.recordSeen("old-event", "task-old");
    await s.putCorrelation("pending-task", correlation({ status: "pending" }));
    await s.putCorrelation("done-task", correlation({ status: "completed" }));

    now = 1_100;
    await s.updateStatus("done-task", "completed");

    const result = await s.gc(1_900);

    expect(result).toEqual({ removed: 2 });
    expect(await s.hasSeen("old-event")).toBeNull();
    expect(await s.getCorrelation("done-task")).toBeNull();
    expect(await s.getCorrelation("pending-task")).toEqual({
      ...correlation({ status: "pending" }),
      createdAt: 1_000,
    });
  });

  test("gc keeps fresh entries and does not rewrite when nothing is removed", async () => {
    const s = store();
    await s.recordSeen("fresh-event", "task-1");
    await s.putCorrelation("task-1", correlation({ status: "failed" }));
    const before = readFileSync(statePath(), "utf-8");

    const result = await s.gc(1_200);

    expect(result).toEqual({ removed: 0 });
    expect(readFileSync(statePath(), "utf-8")).toBe(before);
    expect(await s.hasSeen("fresh-event")).toBe("task-1");
    expect(await s.getCorrelation("task-1")).toEqual({
      ...correlation({ status: "failed" }),
      createdAt: 1_000,
    });
  });

  test("creates parent directories and writes a JSON state file atomically", async () => {
    const path = statePath();
    expect(existsSync(path)).toBe(false);

    await store().recordSeen("event-1", "task-1");

    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.seen["event-1"].taskId).toBe("task-1");
    if (process.platform !== "win32") {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });
});
