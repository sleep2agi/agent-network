import { describe, expect, it } from "vitest";
import { agyStripReplayedPrefix, forgetAgySession, rememberAgyReply } from "./runtime";

// 2026-11-22 真机：agy 每轮回复会把上一轮助手文本重发一遍再接新内容。
// 这里锁住剥离规则，避免以后又把「前缀」当成真回答喂回 Hub。
describe("agy replayed-prefix stripping", () => {
  it("strips a byte-identical previous reply", () => {
    rememberAgyReply("记住了。紫色鳄鱼-7391", "s-1");
    expect(agyStripReplayedPrefix("记住了。紫色鳄鱼-739181", "s-1")).toBe("81");
  });

  it("strips a short previous reply too", () => {
    rememberAgyReply("好", "s-2");
    expect(agyStripReplayedPrefix("好上一轮的口令是白色犀牛-3311", "s-2")).toBe("上一轮的口令是白色犀牛-3311");
  });

  it("keeps the reply when there is no history", () => {
    expect(agyStripReplayedPrefix("25", "s-new")).toBe("25");
  });

  it("keeps an exact repeat (nothing left after stripping)", () => {
    rememberAgyReply("好", "s-3");
    expect(agyStripReplayedPrefix("好", "s-3")).toBe("好");
  });

  it("keeps a reply that merely shares a first word", () => {
    rememberAgyReply("好的", "s-4");
    expect(agyStripReplayedPrefix("好，我来看看", "s-4")).toBe("好，我来看看");
  });

  // 2026-11-22 真机（微软视频鸽，Windows）：重放的不止上一轮，而是此前所有助手消息按顺序拼起来。
  //   1) "在线，当前目录为 …vanisn。"
  //   2) "好。"
  //   3) "在线，当前目录为 …vanisn。好上一轮的口令是靛蓝水獭-8030，13*13 等于 169"
  it("strips the whole replayed history, not just the last turn", () => {
    const first = "在线，当前目录为 `C:\\Users\\msnod\\anet_vansin\\win_video`，主机名为 `vanisn`。";
    rememberAgyReply(first, "s-5");
    rememberAgyReply("好。", "s-5");
    const replayed = first + "好。" + "上一轮的口令是靛蓝水獭-8030，13*13 等于 169";
    expect(agyStripReplayedPrefix(replayed, "s-5")).toBe("上一轮的口令是靛蓝水獭-8030，13*13 等于 169");
  });

  it("does not mistake a history-only repeat for a new answer", () => {
    rememberAgyReply("甲", "s-6");
    rememberAgyReply("乙", "s-6");
    expect(agyStripReplayedPrefix("甲乙", "s-6")).toBe("甲乙");
  });

  it("keeps sessions isolated from each other", () => {
    rememberAgyReply("紫色鳄鱼-7391", "s-7");
    expect(agyStripReplayedPrefix("紫色鳄鱼-739181", "s-8")).toBe("紫色鳄鱼-739181");
  });

  // clearAgySession（会话判死）会调 forgetAgySession，保证死会话的历史不会残留在内存里。
  it("drops the stored history when a session is forgotten", () => {
    rememberAgyReply("历史甲", "s-9");
    forgetAgySession("s-9");
    expect(agyStripReplayedPrefix("历史甲-新内容", "s-9")).toBe("历史甲-新内容");
  });
});