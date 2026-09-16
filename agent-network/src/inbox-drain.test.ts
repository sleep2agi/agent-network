import { describe, expect, test } from "bun:test";
import { drainInbox } from "./inbox-drain";

const page = (ids: string[]) => ({ ok: true, messages: ids.map((id) => ({ id })) });

describe("drainInbox (#1900: one get_inbox(limit 5) per event left the rest waiting)", () => {
  test("keeps fetching until a short page: 7 messages, page size 5 → 2 pages, all 7 delivered", async () => {
    const queue = ["a", "b", "c", "d", "e", "f", "g"];
    const handled: string[] = [];
    const r = await drainInbox({
      pageSize: 5,
      fetchPage: async (limit) => page(queue.slice(0, limit)),
      handle: async (m) => { handled.push(m.id); queue.splice(queue.indexOf(m.id), 1); },
    });
    expect(handled).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(r).toEqual({ delivered: 7, pages: 2, stoppedBy: "short-page" });
  });

  test("exactly one full page then empty → stops on empty, no duplicate handling", async () => {
    const queue = ["a", "b", "c", "d", "e"];
    const handled: string[] = [];
    const r = await drainInbox({
      pageSize: 5,
      fetchPage: async (limit) => page(queue.slice(0, limit)),
      handle: async (m) => { handled.push(m.id); queue.splice(queue.indexOf(m.id), 1); },
    });
    expect(handled.length).toBe(5);
    expect(r.stoppedBy).toBe("empty");
  });

  test("a hub that keeps returning the same rows (ack not taking effect) stops instead of spinning", async () => {
    const handled: string[] = [];
    const r = await drainInbox({ pageSize: 5, fetchPage: async () => page(["x", "y", "z", "w", "v"]), handle: async (m) => { handled.push(m.id); } });
    expect(handled).toEqual(["x", "y", "z", "w", "v"]);
    expect(r.stoppedBy).toBe("no-progress");
  });

  test("fetch error after some deliveries reports what was delivered", async () => {
    let calls = 0;
    const r = await drainInbox({ pageSize: 2, fetchPage: async () => { calls++; if (calls === 2) throw new Error("boom"); return page(["a", "b"]); }, handle: async () => {} });
    expect(r).toEqual({ delivered: 2, pages: 2, stoppedBy: "fetch-error" });
  });

  test("empty inbox → nothing delivered, one page", async () => {
    const r = await drainInbox({ fetchPage: async () => ({ ok: true, messages: [] }), handle: async () => { throw new Error("must not be called"); } });
    expect(r).toEqual({ delivered: 0, pages: 1, stoppedBy: "empty" });
  });

  test("maxPages caps a pathological stream of always-new ids", async () => {
    let n = 0;
    const r = await drainInbox({ pageSize: 2, maxPages: 3, fetchPage: async () => page([`m${n++}`, `m${n++}`]), handle: async () => {} });
    expect(r).toEqual({ delivered: 6, pages: 3, stoppedBy: "max-pages" });
  });
});
