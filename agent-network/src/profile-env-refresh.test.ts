import { describe, expect, test } from "bun:test";
import { refreshProfileEnvOverlay, resolveProfileEnvLenient } from "./profile-env-refresh";

// exit-75 原地重启重读配置 env(节点环境变量「保存并重启」要真的生效)。
describe("refreshProfileEnvOverlay", () => {
  const launcher = { PATH: "/usr/bin", SHELL_KEY: "from-shell" };
  const base = { ...launcher, API_KEY: "old", GONE: "was-set", SHELL_KEY: "profile-shadowed", COMMHUB_TOKEN: "ntok_launcher" };
  const prev = { API_KEY: "old", GONE: "was-set", SHELL_KEY: "profile-shadowed" };

  test("changed keys take the new value, removed keys disappear or fall back to the launcher's own value, new keys arrive", () => {
    const next = { API_KEY: "new", NEW_KEY: "n" };
    const out = refreshProfileEnvOverlay(base, prev, next, launcher);
    expect(out.API_KEY).toBe("new");
    expect(out.NEW_KEY).toBe("n");
    expect("GONE" in out).toBe(false);
    expect(out.SHELL_KEY).toBe("from-shell");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.COMMHUB_TOKEN).toBe("ntok_launcher");
  });

  test("reserved keys are never touched by a config edit (launcher decides them)", () => {
    const out = refreshProfileEnvOverlay(base, { ...prev, PATH: "/evil" }, { PATH: "/evil2", COMMHUB_TOKEN: "forged", NODE_OPTIONS: "--require x", LD_PRELOAD: "x.so" }, launcher);
    expect(out.PATH).toBe("/usr/bin");
    expect(out.COMMHUB_TOKEN).toBe("ntok_launcher");
    expect("NODE_OPTIONS" in out).toBe(false);
    expect("LD_PRELOAD" in out).toBe(false);
  });

  test("onlyKeys limits the refresh to the grok parent's inherited allowlist", () => {
    const out = refreshProfileEnvOverlay({ TZ: "UTC" }, { TZ: "UTC" }, { TZ: "Asia/Shanghai", API_KEY: "k" }, {}, new Set(["TZ"]));
    expect(out).toEqual({ TZ: "Asia/Shanghai" });
  });

  test("base is not mutated", () => {
    const b = { A_KEY: "1" };
    refreshProfileEnvOverlay(b, { A_KEY: "1" }, {}, {});
    expect(b).toEqual({ A_KEY: "1" });
  });
});

describe("resolveProfileEnvLenient", () => {
  test("strings with ~ expansion, envRef from shell then dotenv, missing refs reported not fatal", () => {
    const r = resolveProfileEnvLenient(
      { A: "~/x", B: { _envRef: "B_REF" }, C: { _envRef: "C_REF" }, D: { _envRef: "NOPE" }, E: 5 },
      "/home/user",
      { C_REF: "from-dotenv", B_REF: "dotenv-loses" },
      { B_REF: "from-shell" },
    );
    expect(r.env).toEqual({ A: "/home/user/x", B: "from-shell", C: "from-dotenv" });
    expect(r.missing).toEqual(["D"]);
  });
});
