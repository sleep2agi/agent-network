import { describe, expect, test } from "bun:test";
import { createInboxDrainLane } from "./inbox-drain-lane.js";

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
});
