import { describe, expect, test } from "bun:test";
import { HUMAN_EDITING_IDLE_MS, describeAbandonedHumanEditing } from "./abandoned-human-editing";
describe("#880 abandoned human editing", () => {
  test("human_editing + 10 分钟无按键 + 有任务在等 → 取消草稿,并说清两个数字", () => {
    const m = describeAbandonedHumanEditing({ phase: "human_editing", sinceLastHumanInputMs: HUMAN_EDITING_IDLE_MS, queued: 2 });
    expect(m).toMatch(/no keystrokes for 10m/); expect(m).toMatch(/2 network task/);
  });
  test("没有任务在等 → 不打扰(草稿放多久都不动)", () => {
    expect(describeAbandonedHumanEditing({ phase: "human_editing", sinceLastHumanInputMs: 3 * HUMAN_EDITING_IDLE_MS, queued: 0 })).toBeNull();
  });
  test("最近还在打字 → 不动", () => {
    expect(describeAbandonedHumanEditing({ phase: "human_editing", sinceLastHumanInputMs: HUMAN_EDITING_IDLE_MS - 1, queued: 1 })).toBeNull();
  });
  test("不是 human_editing → 不管", () => {
    expect(describeAbandonedHumanEditing({ phase: "network_turn", sinceLastHumanInputMs: 1e9, queued: 1 })).toBeNull();
    expect(describeAbandonedHumanEditing({ phase: "idle", sinceLastHumanInputMs: 1e9, queued: 1 })).toBeNull();
  });
});
