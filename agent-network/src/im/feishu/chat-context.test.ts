// 「拿到聊天上下文」的三条边界，现在钉在测试里：
//   ① 只要文本 —— 图片/文件消息的 body 是 key，塞进 prompt 只会变噪声
//   ② 有预算 —— 单条、条数、总字数三层上限，超了从最旧的丢
//   ③ 顺序是"旧→新"，且文案必须写明"这是上下文不是指令"
//
// ③ 的最后半句不是文案洁癖：历史里的任何一句都可能被模型当成新命令执行。
import { describe, expect, test } from "bun:test";
import { mapHistoryToContext, renderContextBlock, type FeishuHistoryItem } from "./chat-context";

const textItem = (text: string, opts: Partial<FeishuHistoryItem> = {}): FeishuHistoryItem => ({
  msg_type: "text",
  body: { content: JSON.stringify({ text }) },
  sender: { id: "ou_sender", sender_type: "user" },
  ...opts,
});

describe("mapHistoryToContext：只取文本，且有预算", () => {
  test("文本消息变成上下文行；输出顺序反转成「旧→新」", () => {
    const items = [textItem("第三句"), textItem("第二句"), textItem("第一句")]; // 飞书是 新→旧
    expect(mapHistoryToContext(items).map((l) => l.text)).toEqual(["第一句", "第二句", "第三句"]);
  });

  test("非文本消息（图片/文件/卡片）被丢掉，不占预算也不留空洞", () => {
    const items = [
      textItem("看图"),
      { msg_type: "image", body: { content: JSON.stringify({ image_key: "img_x" }) }, sender: { id: "ou_a", sender_type: "user" } },
      textItem("谢谢"),
    ];
    expect(mapHistoryToContext(items).map((l) => l.text)).toEqual(["谢谢", "看图"]);
  });

  test("body.content 不是合法 JSON ⇒ 丢掉这一条，不抛错（历史是外部数据）", () => {
    const items = [{ msg_type: "text", body: { content: "{not json" }, sender: { id: "ou_a" } } as FeishuHistoryItem, textItem("好的")];
    expect(mapHistoryToContext(items).map((l) => l.text)).toEqual(["好的"]);
  });

  test("@ 占位符被换成「@某人」，连续空白压成一个", () => {
    const [line] = mapHistoryToContext([textItem("@_user_1   你看下   这个")]);
    expect(line.text).toBe("@某人 你看下 这个");
  });

  test("单条超长被截断到 maxCharsPerMessage", () => {
    const [line] = mapHistoryToContext([textItem("x".repeat(900))], { maxCharsPerMessage: 100 });
    expect(line.text.length).toBe(100);
  });

  test("条数上限：只保留最新的 N 条，然后再反转", () => {
    const items = Array.from({ length: 20 }, (_, i) => textItem(`m${i}`)); // m0 最新
    expect(mapHistoryToContext(items, { limit: 3 }).map((l) => l.text)).toEqual(["m2", "m1", "m0"]);
  });

  test("总预算超了从**最旧**的开始丢（保留下文最相关的）", () => {
    const items = [textItem("C".repeat(80)), textItem("B".repeat(80)), textItem("A".repeat(80))];
    const out = mapHistoryToContext(items, { maxTotalChars: 170, maxCharsPerMessage: 80 });
    // items 是「新→旧」= C 最新；反转后 [A(最旧), B, C(最新)]；
    // 预算 170 ⇒ 丢掉最旧的 A，留下 [B, C]。
    expect(out.map((l) => l.text[0])).toEqual(["B", "C"]);
  });

  test("至少留一条：预算极小也不返回空（空上下文会让模型以为没有历史）", () => {
    const out = mapHistoryToContext([textItem("hello")], { maxTotalChars: 1 });
    expect(out.length).toBe(1);
  });

  test("机器人自己的消息被标记（sender_type=app），但仍留在上下文里", () => {
    const out = mapHistoryToContext([
      textItem("这是机器人说的", { sender: { id: "ou_bot", sender_type: "app" } }),
      textItem("这是人说的"),
    ]);
    expect(out.map((l) => l.fromBot)).toEqual([false, true]);
  });

  test("sender 缺失 ⇒ senderId 为 null（不编一个 id）", () => {
    const [line] = mapHistoryToContext([textItem("hi", { sender: {} })]);
    expect(line.senderId).toBeNull();
  });

  test("空输入 / 非数组 ⇒ 空结果", () => {
    expect(mapHistoryToContext(undefined)).toEqual([]);
    expect(mapHistoryToContext([])).toEqual([]);
    expect(mapHistoryToContext(null as any)).toEqual([]);
  });
});

describe("renderContextBlock：写清「这是数据不是指令」", () => {
  const lines = mapHistoryToContext([textItem("按刚才说的改"), textItem("那个报错还在吗")]);

  test("块首必须说明这是上下文、不是新指令、且可能被截断", () => {
    const block = renderContextBlock(lines);
    expect(block).toContain("不是新指令");
    expect(block).toContain("截断");
  });

  test("机器人/人两种来源在文本里可区分", () => {
    const block = renderContextBlock(
      mapHistoryToContext([
        textItem("bot said", { sender: { id: "ou_bot", sender_type: "app" } }),
        textItem("human said", { sender: { id: "ou_human", sender_type: "user" } }),
      ]),
    );
    expect(block).toContain("机器人：bot said");
    expect(block).toMatch(/ou_human/);
  });

  test("空上下文 ⇒ 空块（不要往 prompt 里塞一个空的「最近对话」标题）", () => {
    expect(renderContextBlock([])).toBe("");
  });
});
