import { describe, expect, it } from "vitest";
import { AGY_FRESH_SESSION_RETRY_NOTE, AgyReplayOnlyError, agyStripReplayedPrefix, agyStripReplay, forgetAgySession, rememberAgyReply, agyReplyHistorySizeForTests, seedAgyReplaysFromLoad, withFreshSessionRetryNote } from "./runtime";

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

  it("exact repeat without replay evidence is kept as a normal answer", () => {
    // 裸剥离器总会剥；「歧义」由 agyStripReplay 用「本会话是否见过回放」消解（见其注释）。
    rememberAgyReply("好", "s-3");
    expect(agyStripReplay("好", "s-3")).toEqual({ text: "好", replayOnly: false });
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

  it("k>=2 的纯回放无条件判失败；k==1 才看「本会话见过回放」", () => {
    rememberAgyReply("甲", "s-6");
    rememberAgyReply("乙", "s-6");
    // 两条按序拼接 ⇒ 无条件回放（不需要证据）
    expect(agyStripReplay("甲乙", "s-6")).toEqual({ text: "", replayOnly: true });
    // 回放+新内容 ⇒ 只留新内容
    expect(agyStripReplay("甲乙丙", "s-6")).toEqual({ text: "丙", replayOnly: false });
    // k==1 的歧义：另一个会话只有一条历史、没有证据 ⇒ 当正常回答
    rememberAgyReply("好", "s-6b");
    expect(agyStripReplay("好", "s-6b")).toEqual({ text: "好", replayOnly: false });
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
// 2026-11-23 事故（通信鸽连发 5 次 374 字旧回复）——
// 这一轮只有回放、没有新内容时，**必须判失败**，绝不能把旧文本当结果返回。
describe("agy replay-only turn must fail, never echo history", () => {
  it("纯回放（回复 == 历史拼接）⇒ replayOnly=true 且文本为空", () => {
    rememberAgyReply("第一段回复。", "s-ro1");
    rememberAgyReply("第二段回复。", "s-ro1");
    // 先建立「这个会话会回放」的证据（同一会话剥出过非空余量）
    expect(agyStripReplay("第一段回复。第二段回复。新内容。", "s-ro1")).toEqual({ text: "新内容。", replayOnly: false });
    const r = agyStripReplay("第一段回复。第二段回复。", "s-ro1");
    expect(r.replayOnly).toBe(true);
    expect(r.text).toBe("");
  });

  it("回放 + 新内容 ⇒ 只留新内容，不算 replayOnly", () => {
    rememberAgyReply("旧回复A。", "s-ro2");
    const r = agyStripReplay("旧回复A。这轮的新结果。", "s-ro2");
    expect(r.replayOnly).toBe(false);
    expect(r.text).toBe("这轮的新结果。");
  });

  it("合法的重复回答（连问两次都回「好」）不被误判", () => {
    rememberAgyReply("好", "s-ro3");
    const r = agyStripReplay("好", "s-ro3");
    expect(r.replayOnly).toBe(false);
    expect(r.text).toBe("好");
  });

  it("错误带人话与错误码（给用户看的那句不是码）", () => {
    const e = new AgyReplayOnlyError();
    expect(e.code).toBe("agy_replay_only_no_new_content");
    expect(e.message).toContain("请重发一次");
    expect(e.message).not.toContain("agy_replay_only_no_new_content");
  });
});

// 2026-11-23 review 第 1 条：剥法是「按记录顺序拼前缀，取最长命中，每条只剥一次」，
// 不能把「回放 + 新回答恰好等于某条历史」误判成没有新内容。
describe("agy replay model: recorded-order longest prefix, strip once", () => {
  it("历史 [长回复A, 好]，本轮 \"长回复A好好\" ⇒ 新内容「好」，不是 replayOnly", () => {
    rememberAgyReply("长回复A", "s-order1");
    rememberAgyReply("好", "s-order1");
    const r = agyStripReplay("长回复A好好", "s-order1");
    expect(r.replayOnly).toBe(false);
    expect(r.text).toBe("好");
  });

  it("同样的历史，本轮 \"长回复A好\" ⇒ 纯回放（该会话已见过回放）", () => {
    rememberAgyReply("长回复A", "s-order2");
    rememberAgyReply("好", "s-order2");
    // 先建立「这个会话会回放」的证据
    expect(agyStripReplay("长回复A好新内容", "s-order2")).toEqual({ text: "新内容", replayOnly: false });
    expect(agyStripReplay("长回复A好", "s-order2")).toEqual({ text: "", replayOnly: true });
  });

  it("通信鸽那次的 374 字（两条旧回复按序拼接）⇒ replayOnly", () => {
    rememberAgyReply("I've implemented all 4 fixes … opening the PR.", "s-bird");
    rememberAgyReply("正在等待 wt-chat-send-fix 的全量 typecheck …", "s-bird");
    // 先建立证据
    expect(agyStripReplay("I've implemented all 4 fixes … opening the PR.正在等待 wt-chat-send-fix 的全量 typecheck …额外", "s-bird").replayOnly).toBe(false);
    const r = agyStripReplay("I've implemented all 4 fixes … opening the PR.正在等待 wt-chat-send-fix 的全量 typecheck …", "s-bird");
    expect(r.replayOnly).toBe(true);
    expect(r.text).toBe("");
  });

  it("没观察到过回放的会话，回复恰好等于历史 ⇒ 当正常回答（不误伤）", () => {
    rememberAgyReply("好", "s-order3");
    expect(agyStripReplay("好", "s-order3")).toEqual({ text: "好", replayOnly: false });
  });

  it("换会话重做的回复带人话前缀（不悄悄丢上下文）", () => {
    const out = withFreshSessionRetryNote("新会话的正式回复");
    expect(out.startsWith(AGY_FRESH_SESSION_RETRY_NOTE)).toBe(true);
    expect(out.endsWith("新会话的正式回复")).toBe(true);
    expect(AGY_FRESH_SESSION_RETRY_NOTE).toContain("已换新会话重做");
  });
});

// 2026-11-23 review A：k>=2 且余下为空 ⇒ 无条件 replayOnly（不等 sawReplay 证据）
describe("agy replay: k>=2 with empty remainder is unconditional", () => {
  it("历史两条、无任何先前证据、本轮=两条按序拼接 ⇒ replayOnly", () => {
    rememberAgyReply("第一段。", "s-k2-fresh");
    rememberAgyReply("第二段。", "s-k2-fresh");
    // 该会话此前没有剥出过非空余量（模拟进程刚重启、没有证据）
    expect(agyStripReplay("第一段。第二段。", "s-k2-fresh")).toEqual({ text: "", replayOnly: true });
  });

  it("历史两条、本轮=两条拼接+新内容 ⇒ 只留新内容", () => {
    rememberAgyReply("A段。", "s-k2-new");
    rememberAgyReply("B段。", "s-k2-new");
    expect(agyStripReplay("A段。B段。新内容。", "s-k2-new")).toEqual({ text: "新内容。", replayOnly: false });
  });
});

// 2026-11-23 review B：进程重启后历史为空 ⇒ 用 session/load 回放做种子
describe("agy replay: seed from session/load replay (restart case)", () => {
  it("种入 session/load 回放后，续会话本轮只有回放 ⇒ 判失败", () => {
    // 进程内没有任何历史（重启后），只有 session/load 回放出来的那份文本
    seedAgyReplaysFromLoad("s-restart", "上上轮回复。上一轮回复。");
    const r = agyStripReplay("上上轮回复。上一轮回复。", "s-restart");
    expect(r.replayOnly).toBe(true);
    expect(r.text).toBe("");
  });

  it("种入种子后，本轮=回放+新内容 ⇒ 只留新内容", () => {
    seedAgyReplaysFromLoad("s-restart2", "旧回复。");
    expect(agyStripReplay("旧回复。重启后的新回复。", "s-restart2")).toEqual({ text: "重启后的新回复。", replayOnly: false });
  });
});

// 2026-11-23 review B 修正：握手回放**替换**历史，不合并（长跑进程里不膨胀）
describe("agy seed replaces history (no growth across rounds)", () => {
  it("连续三轮续会话：历史长度恒为 1 条（+本轮追加），且第三轮判定正确", () => {
    const sid = "s-multi";
    // 第 1 轮：握手回放 r1，本轮新内容「新1」
    seedAgyReplaysFromLoad(sid, "r1");
    expect(agyReplyHistorySizeForTests(sid)).toBe(1);
    expect(agyStripReplay("r1新1", sid)).toEqual({ text: "新1", replayOnly: false });
    rememberAgyReply("新1", sid);
    expect(agyReplyHistorySizeForTests(sid)).toBe(2);

    // 第 2 轮：握手回放 r1+新1（完整历史），替换掉之前的记录
    seedAgyReplaysFromLoad(sid, "r1新1");
    expect(agyReplyHistorySizeForTests(sid)).toBe(1);
    expect(agyStripReplay("r1新1新2", sid)).toEqual({ text: "新2", replayOnly: false });
    rememberAgyReply("新2", sid);
    expect(agyReplyHistorySizeForTests(sid)).toBe(2);

    // 第 3 轮：握手回放 r1+新1+新2
    seedAgyReplaysFromLoad(sid, "r1新1新2");
    expect(agyReplyHistorySizeForTests(sid)).toBe(1);
    // 回放 + 新内容 ⇒ 只留新内容
    expect(agyStripReplay("r1新1新2新3", sid)).toEqual({ text: "新3", replayOnly: false });
    // 只有回放 ⇒ 判失败
    expect(agyStripReplay("r1新1新2", sid)).toEqual({ text: "", replayOnly: true });
    // 三轮下来数组长度仍是「1 条种子（+本轮尚未 remember）」
    expect(agyReplyHistorySizeForTests(sid)).toBe(1);
  });

  it("没有握手回放（新会话）时不动已有历史", () => {
    seedAgyReplaysFromLoad("s-noop", "历史X");
    const before = agyReplyHistorySizeForTests("s-noop");
    seedAgyReplaysFromLoad("s-noop", undefined);
    seedAgyReplaysFromLoad("s-noop", "   ");
    expect(agyReplyHistorySizeForTests("s-noop")).toBe(before);
  });
});
