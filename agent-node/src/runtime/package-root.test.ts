import { describe, expect, it } from "bun:test";
import { packageRootFrom } from "./package-root";

describe("packageRootFrom", () => {
  it("源码布局:src/cli.ts 的上一级就是包根", () => {
    expect(packageRootFrom("file:///opt/x/node_modules/@sleep2agi/agent-node/src/cli.ts"))
      .toBe("/opt/x/node_modules/@sleep2agi/agent-node/");
  });

  it("🔴 产物布局:dist/cli.js 的上一级也是包根 —— 两种布局必须给出同一个答案", () => {
    const src = packageRootFrom("file:///opt/x/agent-node/src/cli.ts");
    const dist = packageRootFrom("file:///opt/x/agent-node/dist/cli.js");
    expect(src).toBe("/opt/x/agent-node/");
    expect(dist).toBe(src);
  });

  it("拿不到 import.meta.url 时退到 argv[1]", () => {
    expect(packageRootFrom(undefined, "/usr/lib/node_modules/agent-node/dist/cli.js"))
      .toBe("/usr/lib/node_modules/agent-node/");
  });

  it("两者都拿不到时返回 null —— 不编一个看起来合理的路径", () => {
    expect(packageRootFrom(undefined)).toBeNull();
    expect(packageRootFrom("", "")).toBeNull();
    expect(packageRootFrom("not-a-url")).toBeNull();
  });

  it("路径里有空格/中文(URL 编码)也要还原", () => {
    expect(packageRootFrom("file:///opt/my%20apps/%E8%8A%82%E7%82%B9/agent-node/dist/cli.js"))
      .toBe("/opt/my apps/节点/agent-node/");
  });

  it("🔴 结果绝不能是构建期常量 —— 拿两个不同的 moduleUrl 必须得到不同答案", () => {
    const a = packageRootFrom("file:///home/builder/agent-node/src/cli.ts");
    const b = packageRootFrom("file:///usr/lib/node_modules/agent-node/dist/cli.js");
    expect(a).not.toBe(b);
  });
});

// ── 与 resolveAgentNodeDir 的组合 ──
// cli.ts 传的是 `<包根>/dist`,而 resolveAgentNodeDir 取它的 dirname ⇒ 得到包根。
// 那个 `/dist` 只是为了满足既有契约(它从不被当成真实路径去访问),
// 所以源码布局和产物布局都得到同一个答案 —— 这一点必须钉住。
import { resolveAgentNodeDir } from "./codex-dep-loader";

describe("packageRootFrom + resolveAgentNodeDir 的组合", () => {
  const compose = (moduleUrl: string) => {
    const root = packageRootFrom(moduleUrl);
    return resolveAgentNodeDir(root!.replace(/\/+$/, "") + "/dist");
  };

  it("源码布局与产物布局给出同一个包根", () => {
    const fromSrc = compose("file:///opt/x/agent-node/src/cli.ts");
    const fromDist = compose("file:///opt/x/agent-node/dist/cli.js");
    expect(fromSrc).toBe("/opt/x/agent-node");
    expect(fromDist).toBe(fromSrc);
  });

  it("🔴 换一台机器的路径必须得到不同答案 —— 证明它不是构建期常量", () => {
    expect(compose("file:///home/builder/agent-node/src/cli.ts"))
      .not.toBe(compose("file:///usr/lib/node_modules/@sleep2agi/agent-node/dist/cli.js"));
  });
});
