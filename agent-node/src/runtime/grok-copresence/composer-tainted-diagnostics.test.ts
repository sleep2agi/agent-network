import { describe, expect, test } from "bun:test";
import { waitFor, withHumanTui } from "./copresence-human-fixture";

// ── issue #881:污染态被拒时，提示语不能谎称是斜杠命令 ────────────
// 现状(实测):打一行**没有任何斜杠**的普通文字，按一次方向键改错字，再回车 ——
// 这一行被 Ctrl+C 就地清掉、从未提交，而提示语说的是
// `slash command was blocked`。根本没有斜杠命令。
//
// 人因此无从诊断，只会觉得"这个 TUI 有时候按回车没反应"。
// 本文件记录的是**要求的新行为**(提示语说实话)，不是现状快照 ——
// 现状快照在 slash-gate.test.ts，两种语义分开放。
describe("tainted composer diagnostics (issue #881)", () => {
  test("navigation-tainted line is refused with a message that does not claim a slash command", async () => {
    await withHumanTui(async ({ fixture, input, runtime }) => {
      input.write("hello");                       // 全程没有斜杠
      await waitFor(() => runtime.state.phase === "human_editing");
      input.write("\x1b[D");                      // ← 左方向键：把 composer 标成污染
      await waitFor(() => fixture.writes.join("").includes("\x1b[D"));
      input.write("\r");
      await waitFor(() => fixture.warnings.length > 0);

      const warning = fixture.warnings.join(" ");
      // 这一行确实发不出去 —— 那是现状，本次不改。
      expect(fixture.humanPrompts).toEqual([]);
      // 要改的是这里：别再指一件没发生的事。
      expect(warning).not.toContain("slash command");
      // 而且要说清楚怎么办，否则人只知道"失败了"。
      expect(warning).toContain("retype");
    });
  });
});
