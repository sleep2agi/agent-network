import { describe, expect, it } from "vitest";
import { agyStripReplayedPrefix, rememberAgyReply } from "./runtime";

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
});