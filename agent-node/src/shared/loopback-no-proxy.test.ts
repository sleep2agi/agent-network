import { describe, expect, test } from "bun:test";
import { exemptLoopbackFromProxy, withLoopbackNoProxy } from "./loopback-no-proxy";

describe("loopback is never proxied", () => {
  test("adds the loopback names and keeps what was there", () => {
    expect(withLoopbackNoProxy(undefined)).toBe("127.0.0.1,localhost,::1");
    expect(withLoopbackNoProxy("")).toBe("127.0.0.1,localhost,::1");
    // The value measured on the Windows machine.
    expect(withLoopbackNoProxy("agent.tianma.cn,.tianma.cn,y.vansin.top,.vansin.top"))
      .toBe("agent.tianma.cn,.tianma.cn,y.vansin.top,.vansin.top,127.0.0.1,localhost,::1");
  });
  test("does not duplicate, whatever the case or spacing", () => {
    expect(withLoopbackNoProxy("LOCALHOST, 127.0.0.1 ,corp.example")).toBe("LOCALHOST,127.0.0.1,corp.example,::1");
    expect(withLoopbackNoProxy("127.0.0.1,localhost,::1")).toBe("127.0.0.1,localhost,::1");
  });
  test("a wildcard already exempts everything", () => {
    expect(withLoopbackNoProxy("*")).toBe("*");
  });
  test("sets both spellings, from whichever one existed", () => {
    const env: NodeJS.ProcessEnv = { no_proxy: "corp.example" };
    exemptLoopbackFromProxy(env);
    expect(env.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
});
