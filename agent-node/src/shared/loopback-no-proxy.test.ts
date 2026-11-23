import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const env: NodeJS.ProcessEnv = { no_proxy: "corp.example", HTTPS_PROXY: "http://127.0.0.1:7890" };
    exemptLoopbackFromProxy(env);
    expect(env.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
  test("with no proxy configured the environment is left exactly as it was", () => {
    for (const before of [{}, { PATH: "/usr/bin" }, { NO_PROXY: "corp.example" }, { HTTP_PROXY: "" }]) {
      const env: NodeJS.ProcessEnv = { ...before };
      exemptLoopbackFromProxy(env);
      expect(env).toEqual(before);
    }
  });
  test("any spelling of a proxy variable counts", () => {
    for (const name of ["HTTP_PROXY", "https_proxy", "ALL_PROXY"]) {
      const env: NodeJS.ProcessEnv = { [name]: "http://proxy:8080" };
      exemptLoopbackFromProxy(env);
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    }
  });
  test("a proxy that arrives later (from the node profile) is covered by calling it again", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    exemptLoopbackFromProxy(env);
    expect(env.NO_PROXY).toBeUndefined();
    env.HTTPS_PROXY = "http://proxy:8080";
    exemptLoopbackFromProxy(env);
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
  });
  test("the node applies it once more after merging the profile's variables", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "cli.ts"), "utf8");
    const merged = cli.indexOf("if (fileConfig.env && typeof fileConfig.env === \"object\")");
    expect(merged).toBeGreaterThan(0);
    expect(cli.indexOf("exemptLoopbackFromProxy();", merged)).toBeGreaterThan(merged);
  });
});
