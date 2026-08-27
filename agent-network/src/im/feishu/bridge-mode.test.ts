import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FEISHU_BRIDGE_MODE,
  resolveFeishuBridgeMode,
  type FeishuBridgeMode,
} from "./bridge";

describe("feishu bridge transport mode", () => {
  // 🔴 这一条是本文件存在的理由。
  //
  // 改成显式声明之前,选路是:
  //     const client = commhubClient ?? createEnvCommHubClient();
  //     if (client) return createCommHubEventHandler(...);
  // 而 createEnvCommHubClient() 只在 COMMHUB_URL / ANET_HUB_URL 都没设时返回 null。
  // 每个真实节点都设了 —— 于是「默认走 CommHub」是环境变量在场带来的副作用,
  // 没有任何人声明过,运维也看不出自己在哪条路径上。
  test("COMMHUB_URL 在场不改变模式", () => {
    expect(resolveFeishuBridgeMode(undefined, { COMMHUB_URL: "http://hub.example" } as any))
      .toBe("direct");
    expect(resolveFeishuBridgeMode(undefined, { ANET_HUB_URL: "http://hub.example" } as any))
      .toBe("direct");
  });

  test("默认是 direct", () => {
    expect(DEFAULT_FEISHU_BRIDGE_MODE).toBe("direct");
    expect(resolveFeishuBridgeMode(undefined, {} as any)).toBe("direct");
  });

  test("环境变量显式选 commhub", () => {
    expect(resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: "commhub" } as any))
      .toBe("commhub");
  });

  test("大小写和空白不敏感", () => {
    for (const raw of ["COMMHUB", " CommHub ", "commhub"]) {
      expect(resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: raw } as any))
        .toBe("commhub");
    }
  });

  test("显式入参压过环境变量", () => {
    expect(
      resolveFeishuBridgeMode("direct" as FeishuBridgeMode, {
        ANET_FEISHU_BRIDGE_MODE: "commhub",
      } as any),
    ).toBe("direct");
    expect(
      resolveFeishuBridgeMode("commhub" as FeishuBridgeMode, {
        ANET_FEISHU_BRIDGE_MODE: "direct",
      } as any),
    ).toBe("commhub");
  });

  // 非法值静默取默认,会让打错字的运维以为自己开了 commhub 而实际在 direct 上,
  // 或者反过来。抛错让它在启动时就可见。
  test("非法值抛错,不静默取默认", () => {
    expect(() =>
      resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: "banana" } as any),
    ).toThrow("不是合法模式");
    expect(() =>
      resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: "comm-hub" } as any),
    ).toThrow("不是合法模式");
  });

  test("空串按未设处理", () => {
    expect(resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: "" } as any))
      .toBe("direct");
    expect(resolveFeishuBridgeMode(undefined, { ANET_FEISHU_BRIDGE_MODE: "   " } as any))
      .toBe("direct");
  });
});
