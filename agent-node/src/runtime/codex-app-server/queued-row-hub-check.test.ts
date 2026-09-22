import { describe, expect, test } from "bun:test";
import { decideQueuedRowStart, QUEUED_ROW_CHECK_LIMIT } from "./queued-row-hub-check";

const page = (ids: string[]) => ({ ok: true, messages: ids.map((id) => ({ id, type: "reply" })) });

describe("#1930 decideQueuedRowStart", () => {
  test("row still listed as pending → start", () => {
    expect(decideQueuedRowStart({ inboxId: "m2", page: page(["m1", "m2", "m3"]), limit: 100 }))
      .toEqual({ start: true, reason: "pending" });
  });

  test("row absent from a complete (short) page → gone → do not start", () => {
    expect(decideQueuedRowStart({ inboxId: "m9", page: page(["m1", "m2"]), limit: 100 }))
      .toEqual({ start: false, reason: "gone" });
  });

  test("row absent but the page is full → cannot prove absence → start", () => {
    const ids = Array.from({ length: QUEUED_ROW_CHECK_LIMIT }, (_, i) => `m${i}`);
    expect(decideQueuedRowStart({ inboxId: "beyond", page: page(ids), limit: QUEUED_ROW_CHECK_LIMIT }))
      .toEqual({ start: true, reason: "page-full" });
  });

  test("unreadable page (no messages array / null / error object) → start", () => {
    for (const bad of [null, undefined, {}, { ok: false, error: "boom" }, { messages: "nope" }]) {
      expect(decideQueuedRowStart({ inboxId: "m1", page: bad, limit: 100 }).start).toBe(true);
    }
  });

  test("matching is by inbox id, never by task_id", () => {
    // A task row's FIFO id is its task_id, but the gate is only ever handed the
    // inbox id it recorded at enqueue; a row whose task_id happens to match
    // must not count as present.
    const p = { ok: true, messages: [{ id: "row-1", task_id: "m7" }] };
    expect(decideQueuedRowStart({ inboxId: "m7", page: p, limit: 100 })).toEqual({ start: false, reason: "gone" });
    expect(decideQueuedRowStart({ inboxId: "row-1", page: p, limit: 100 })).toEqual({ start: true, reason: "pending" });
  });

  test("an empty page is complete: absent → gone", () => {
    expect(decideQueuedRowStart({ inboxId: "m1", page: page([]), limit: 100 })).toEqual({ start: false, reason: "gone" });
  });
});
