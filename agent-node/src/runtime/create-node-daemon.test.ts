import { describe, expect, test } from "bun:test";
import {
  validateFlagValueDaemon,
  buildAnetArgsDaemon,
  minimalEnv,
} from "./create-node-daemon.js";

describe("§4.2.2 daemon-side flag VALUE validator (BLOCKER #2 — defense in depth)", () => {
  test("permissionMode enum", () => {
    expect(() => validateFlagValueDaemon("permissionMode", "default")).not.toThrow();
    expect(() => validateFlagValueDaemon("permissionMode", "plan")).not.toThrow();
    expect(() => validateFlagValueDaemon("permissionMode", "bogus")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("permissionMode", 123)).toThrow(/flag_value_invalid/);
  });
  test("dangerouslySkipPermissions boolean (string 'true' must be rejected)", () => {
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", true)).not.toThrow();
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", false)).not.toThrow();
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", "true")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", 1)).toThrow(/flag_value_invalid/);
  });
  test("maxTurns integer range — 'DROP TABLE' / float / out-of-range rejected", () => {
    expect(() => validateFlagValueDaemon("maxTurns", 50)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", 1)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", 9999)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", "DROP TABLE")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 0)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 10000)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 5.5)).toThrow(/flag_value_invalid/);
  });
  test("budget number with decimals allowed; out-of-range rejected", () => {
    expect(() => validateFlagValueDaemon("budget", 0)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", 5.5)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", 1000)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", -1)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", 1001)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", "free")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", Infinity)).toThrow(/flag_value_invalid/);
  });
  test("timeout integer range", () => {
    expect(() => validateFlagValueDaemon("timeout", 600)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 1)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 86400)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 0)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("timeout", 86401)).toThrow(/flag_value_invalid/);
  });
  test("unknown key rejected", () => {
    expect(() => validateFlagValueDaemon("evilKey", true)).toThrow(/flag_key_unknown/);
  });
});

describe("buildAnetArgsDaemon now reaches flag value validation", () => {
  test("happy path with mixed flags", () => {
    const args = buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "claude-opus-4.6",
      flags: { maxTurns: 50, budget: 5.5, permissionMode: "plan" },
    });
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("50");
    expect(args[args.indexOf("--budget") + 1]).toBe("5.5");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
  test("smuggled string maxTurns rejected by daemon even if hub missed", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      flags: { maxTurns: "DROP TABLE" as any },
    })).toThrow(/flag_value_invalid/);
  });
  test("smuggled string dangerouslySkipPermissions rejected", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      flags: { dangerouslySkipPermissions: "true" as any },
    })).toThrow(/flag_value_invalid/);
  });
  test("name shell-metachar still rejected (existing validateName, F2)", () => {
    expect(() => buildAnetArgsDaemon({
      name: ";rm -rf /", runtime: "claude-agent-sdk", model: "x",
    })).toThrow(/node_name_invalid/);
  });
  test("runtime enum still enforced", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "bash", model: "x",
    })).toThrow(/runtime_invalid/);
  });
  test("channels non-empty rejected (P1 fail-closed)", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      channels: ["telegram"] as any,
    })).toThrow(/channels_not_supported_in_p1/);
  });
});

describe("minimalEnv defensive compose (BLOCKER #1+#2 lineage — kept stable)", () => {
  test("happy path: no extra → fixed PATH/HOME/LANG only", () => {
    const env = minimalEnv();
    expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.HOME).toBeDefined();
    expect(env.LANG).toBeDefined();
  });
  test("legitimate extra key passes + fixed keys still last", () => {
    const env = minimalEnv({ ANTHROPIC_API_KEY: "x" });
    expect(env.ANTHROPIC_API_KEY).toBe("x");
    expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  });
  test("THROWS on reserved key in extra (LD_PRELOAD smuggled by attacker)", () => {
    expect(() => minimalEnv({ LD_PRELOAD: "/tmp/evil.so" })).toThrow(/reserved env key/);
  });
  test("THROWS on fixed key in extra (PATH smuggled)", () => {
    expect(() => minimalEnv({ PATH: "/tmp/evil-bin" })).toThrow(/reserved env key|fixed env key/);
  });
});
