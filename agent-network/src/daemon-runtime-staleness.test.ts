import { describe, expect, test } from "bun:test";
import { describeStaleRuntimeSupport } from "./daemon-runtime-staleness";
import { SUPPORTED_RUNTIME_NAMES } from "./normalize-runtime";

const ALL = [...SUPPORTED_RUNTIME_NAMES];

describe("describeStaleRuntimeSupport", () => {
  test("声明了全集 → 不报", () => {
    expect(describeStaleRuntimeSupport(ALL, ALL)).toBeNull();
  });

  test("🔴 #1298 之前写的那三个 → 报，且点名缺的是谁", () => {
    const old = ["claude-agent-sdk", "codex-sdk", "grok-build-acp"];
    const msg = describeStaleRuntimeSupport(old, ALL);
    expect(msg).not.toBeNull();
    for (const r of ALL.filter((x) => !old.includes(x))) {
      expect(msg).toContain(r);
    }
    // 已有的那三个不该出现在「缺」的名单里
    expect(msg).toContain(`少 ${ALL.length - old.length} 个`);
  });

  test("没声明（undefined / 空数组）→ 不报：那是「用默认」，不是「少了」", () => {
    expect(describeStaleRuntimeSupport(undefined, ALL)).toBeNull();
    expect(describeStaleRuntimeSupport([], ALL)).toBeNull();
    expect(describeStaleRuntimeSupport(null, ALL)).toBeNull();
  });

  test("声明里有支持集之外的名字 → 不影响判定（只看「缺不缺」）", () => {
    expect(describeStaleRuntimeSupport([...ALL, "some-future-runtime"], ALL)).toBeNull();
  });

  test("判据取自 SUPPORTED_RUNTIME_NAMES 而非写死的数字", () => {
    // 反推：拿一个人造的支持集，缺口数必须跟着它变，而不是固定 4
    const msg = describeStaleRuntimeSupport(["a"], ["a", "b", "c"]);
    expect(msg).toContain("少 2 个");
    expect(msg).toContain("b, c");
  });
});

describe("建议动作的后果必须写在文案里（#1298 存量 daemon）", () => {
  test("🔴 提示里必须同时出现 --force、token 重新签发、要重启", () => {
    const msg = describeStaleRuntimeSupport(["claude-agent-sdk"], ALL, "daemon-vanisn")!;
    expect(msg).toContain("--force");
    expect(msg).toContain("重新签发 token");
    expect(msg).toContain("重启");
  });

  test("🔴 daemon 名要出现在命令里，用户能直接复制（不是 <name> 占位）", () => {
    const msg = describeStaleRuntimeSupport(["claude-agent-sdk"], ALL, "daemon-vanisn")!;
    expect(msg).toContain("anet daemon init daemon-vanisn --force");
    expect(msg).not.toContain("<name>");
  });

  test("不传名字时退回占位符（不编一个假名字）", () => {
    const msg = describeStaleRuntimeSupport(["claude-agent-sdk"], ALL)!;
    expect(msg).toContain("anet daemon init <name> --force");
  });
});
