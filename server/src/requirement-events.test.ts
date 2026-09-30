// diffRequirement 的边角(HTTP 层的写路径在 requirement-events-http.test.ts)。
import { describe, expect, test } from "bun:test";
import { diffRequirement, eventPublic, type EventCard } from "./requirement-events.js";

const base: EventCard = {
  requirement_id: "req_1", network_id: "net_1", seq: 7, title: "示例", column_name: "pool", priority: "normal", due_on: null, start_on: null,
  assignee: null, owner_json: null, agent_owner_json: null, participants_json: "[]", tags_json: "[]", checklist_json: "[]", description: null,
  project_id: null, parent_id: null, archived: 0,
};
const ck = (items: { id: string; text: string; done?: boolean }[]) => JSON.stringify(items.map(i => ({ done: false, ...i })));

describe("diffRequirement", () => {
  test("no change → no events; null vs empty string are the same", () => {
    expect(diffRequirement(base, { ...base })).toEqual([]);
    expect(diffRequirement(base, { ...base, due_on: "", assignee: "", description: "" })).toEqual([]);
  });
  test("created carries title and column only", () => {
    expect(diffRequirement(null, base)).toEqual([{ kind: "created", field: null, old: null, new: { title: "示例", column: "pool" } }]);
  });
  test("checklist: reorder, rename, add or remove is one `checklist` event with counts", () => {
    const a = { ...base, checklist_json: ck([{ id: "a", text: "一" }, { id: "b", text: "二", done: true }]) };
    for (const next of [ck([{ id: "b", text: "二", done: true }, { id: "a", text: "一" }]), ck([{ id: "a", text: "一改" }, { id: "b", text: "二", done: true }]), ck([{ id: "a", text: "一" }])]) {
      const out = diffRequirement(a, { ...a, checklist_json: next });
      expect(out.length).toBe(1);
      expect(out[0].field).toBe("checklist");
    }
    expect(diffRequirement(a, { ...a, checklist_json: ck([{ id: "a", text: "一" }]) })[0]).toMatchObject({ old: { total: 2, done: 1 }, new: { total: 1, done: 0 } });
  });
  test("checklist: two items ticked in one write are two `checklist_item` events", () => {
    const a = { ...base, checklist_json: ck([{ id: "a", text: "一" }, { id: "b", text: "二" }]) };
    const out = diffRequirement(a, { ...a, checklist_json: ck([{ id: "a", text: "一", done: true }, { id: "b", text: "二", done: true }]) });
    expect(out.map(e => [e.field, (e.new as { id: string }).id])).toEqual([["checklist_item", "a"], ["checklist_item", "b"]]);
  });
  test("malformed stored JSON reads as empty rather than throwing", () => {
    expect(() => diffRequirement({ ...base, tags_json: "{nope", participants_json: "x" }, base)).not.toThrow();
  });
  test("description records lengths, never text", () => {
    const [e] = diffRequirement(base, { ...base, description: "secret text" });
    expect(e).toEqual({ kind: "changed", field: "description", old: { chars: 0 }, new: { chars: 11 } });
  });
  test("eventPublic: bigint / string ids from PostgreSQL come out as strings, seq as a number", () => {
    const row = { id: 12n as unknown as string, network_id: "n", requirement_id: "r", seq: "3", title: "t", actor_json: null, kind: "changed", field: "priority", old_json: "\"low\"", new_json: "\"high\"", created_at: "2026-10-01T00:00:00.000Z" };
    expect(eventPublic(row)).toMatchObject({ id: "12", seq: 3, old: "low", new: "high", actor: null });
  });
});
