import { describe, expect, test } from "bun:test";
import { waitFor, withHumanTui } from "./copresence-human-fixture";

// ── issue #881:污染态被拒时，提示语不能谎称是斜杠命令 ────────────
// 现状(实测):打一行**没有任何斜杠**的普通文字，按一次方向键改错字，再回车 ——
// 这一行被 Ctrl+C 就地清掉、从未提交，而提示语说的是
// `slash command was blocked`。根本没有斜杠命令。
//
// 人因此无从诊断，只会觉得"这个 TUI 有时候按回车没反应"。
// main 已把这条路径改成「根本不拒绝」:编辑后的普通行照常提交,
// 于是谎称 slash 的提示语失去存在条件。本文件钉住这个终态。
describe("tainted composer diagnostics (issue #881)", () => {
  test("navigation-tainted line is refused with a message that does not claim a slash command", async () => {
    await withHumanTui(async ({ fixture, input, runtime }) => {
      input.write("hello");                       // 全程没有斜杠
      await waitFor(() => runtime.state.phase === "human_editing");
      input.write("\x1b[D");                      // ← 左方向键：把 composer 标成污染
      await waitFor(() => fixture.writes.join("").includes("\x1b[D"));
      input.write("\r");
      await waitFor(() => fixture.humanPrompts.length > 0);

      // main 现行语义:无斜杠的编辑行照常提交。拒绝不存在,
      // 谎称 slash 的提示自然也不可能出现 —— #881 以"不拒绝"收场。
      expect(fixture.warnings.join(" ")).not.toContain("slash command");
      expect(fixture.warnings).toEqual([]);
    });
  });
});
