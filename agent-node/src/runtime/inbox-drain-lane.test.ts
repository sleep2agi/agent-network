import { describe, expect, test } from "bun:test";
import { createInboxDrainLane, drainInboxBatch } from "./inbox-drain-lane.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("inbox drain lanes", () => {
  test("an informational lane drains while the work lane is busy", async () => {
    const errors: unknown[] = [];
    const work = createInboxDrainLane((error) => errors.push(error));
    const informational = createInboxDrainLane((error) => errors.push(error));
    const taskGate = deferred();
    const events: string[] = [];

    work.schedule(async () => {
      events.push("task-start");
      await taskGate.promise;
      events.push("task-end");
    });
    informational.schedule(async () => {
      events.push("message-visible");
    });

    await informational.idle();
    expect(events).toEqual(["task-start", "message-visible"]);

    taskGate.resolve();
    await work.idle();
    expect(events).toEqual(["task-start", "message-visible", "task-end"]);
    expect(errors).toEqual([]);
  });

  test("each lane remains serial", async () => {
    const lane = createInboxDrainLane(() => {});
    const firstGate = deferred();
    const events: string[] = [];

    lane.schedule(async () => {
      events.push("first-start");
      await firstGate.promise;
      events.push("first-end");
    });
    lane.schedule(async () => {
      events.push("second");
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    firstGate.resolve();
    await lane.idle();
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  test("repeated wakeups for the same drain coalesce into one dirty rerun", async () => {
    const lane = createInboxDrainLane(() => {});
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let runs = 0;
    const drain = async () => {
      runs++;
      if (runs === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    };

    lane.schedule(drain);
    await firstStarted.promise;
    for (let i = 0; i < 100; i++) lane.schedule(drain);
    releaseFirst.resolve();
    await lane.idle();

    expect(runs).toBe(2);
  });

  test("a failed drain is reported and does not poison later retries", async () => {
    const errors: unknown[] = [];
    const lane = createInboxDrainLane((error) => errors.push(error));
    const events: string[] = [];

    lane.schedule(async () => {
      events.push("failed-attempt");
      throw new Error("temporary inbox failure");
    });
    lane.schedule(async () => {
      events.push("retry-ran");
    });

    await lane.idle();
    expect(events).toEqual(["failed-attempt", "retry-ran"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("temporary inbox failure");
  });

  test("retry mode backs off and eventually completes the same drain", async () => {
    const errors: unknown[] = [];
    const lane = createInboxDrainLane(
      (error) => errors.push(error),
      { initialDelayMs: 1, maxDelayMs: 2 },
    );
    let attempts = 0;

    lane.schedule(async () => {
      attempts++;
      if (attempts < 3) throw new Error(`transient-${attempts}`);
    });

    await lane.idle();
    expect(attempts).toBe(3);
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("transient-1");
    expect((errors[1] as Error).message).toBe("transient-2");
  });

  test("one failed inbox item does not starve later items in the same snapshot", async () => {
    const attempted: string[] = [];

    await expect(drainInboxBatch(["first", "second", "third"], async (item) => {
      attempted.push(item);
      if (item === "first") throw new Error("first ack failed");
    })).rejects.toThrow("first ack failed");

    expect(attempted).toEqual(["first", "second", "third"]);
  });

  test("ack-only retry does not duplicate the first notification or delay the second", async () => {
    const events: string[] = [];
    const displayed = new Set<string>();
    const pending = new Set(["first", "second"]);
    let firstAckAttempts = 0;
    const lane = createInboxDrainLane(() => {}, { initialDelayMs: 1, maxDelayMs: 1 });

    lane.schedule(() => drainInboxBatch([...pending], async (item) => {
      if (!displayed.has(item)) {
        events.push(`notify:${item}`);
        displayed.add(item);
      }
      if (item === "first" && firstAckAttempts++ === 0) {
        events.push("ack:first:failed");
        throw new Error("lost ack response");
      }
      events.push(`ack:${item}:ok`);
      pending.delete(item);
      displayed.delete(item);
    }));

    await lane.idle();
    expect(events).toEqual([
      "notify:first",
      "ack:first:failed",
      "notify:second",
      "ack:second:ok",
      "ack:first:ok",
    ]);
    expect(events.filter((event) => event === "notify:first")).toHaveLength(1);
  });
});
