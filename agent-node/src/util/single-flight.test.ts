import { describe, expect, test } from "bun:test";
import { createSingleFlight } from "./single-flight.js";

describe("single-flight resource initialization", () => {
  test("concurrent callers share exactly one initializer", async () => {
    const gate = Promise.withResolvers<void>();
    const flight = createSingleFlight<{ id: number }>();
    let starts = 0;
    const open = async () => {
      starts++;
      await gate.promise;
      return { id: starts };
    };

    const callers = Array.from({ length: 20 }, () => flight.run(open));
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(flight.pending()).not.toBeNull();
    gate.resolve();

    const values = await Promise.all(callers);
    expect(values.every((value) => value === values[0])).toBe(true);
    expect(values[0].id).toBe(1);
    await Promise.resolve();
    expect(flight.pending()).toBeNull();
  });

  test("a rejected initializer is cleared and can be retried", async () => {
    const flight = createSingleFlight<string>();
    let starts = 0;

    await expect(flight.run(async () => {
      starts++;
      throw new Error("open failed");
    })).rejects.toThrow("open failed");
    await Promise.resolve();
    expect(flight.pending()).toBeNull();

    await expect(flight.run(async () => {
      starts++;
      return "ready";
    })).resolves.toBe("ready");
    expect(starts).toBe(2);
  });
});
