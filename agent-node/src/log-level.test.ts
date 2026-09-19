import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, resolveLogLevel } from "./log-level";

describe("resolveLogLevel (#1917 ③)", () => {
  test("no input at all resolves to info", () => {
    const r = resolveLogLevel();
    expect(r.name).toBe("info");
    expect(r.level).toBe(LOG_LEVELS.info);
    expect(r.source).toBe("default");
    expect(r.warning).toBeUndefined();
  });

  test("ANET_LOG_LEVEL is honoured for every level name", () => {
    for (const name of ["debug", "info", "warn", "error"] as const) {
      const r = resolveLogLevel({ anetEnvValue: name });
      expect(r.name).toBe(name);
      expect(r.level).toBe(LOG_LEVELS[name]);
      expect(r.source).toBe("ANET_LOG_LEVEL");
    }
  });

  test("warn hides info, debug shows it — the numeric contract the logger gates on", () => {
    // The logger drops a message when its levelNum < LOG_LEVEL.
    const warnLevel = resolveLogLevel({ anetEnvValue: "warn" }).level;
    const debugLevel = resolveLogLevel({ anetEnvValue: "debug" }).level;
    expect(LOG_LEVELS.info < warnLevel).toBe(true);   // info suppressed at warn
    expect(LOG_LEVELS.warn < warnLevel).toBe(false);  // warn still passes
    expect(LOG_LEVELS.info < debugLevel).toBe(false); // info shown at debug
    expect(LOG_LEVELS.debug < debugLevel).toBe(false);
  });

  test("precedence: flag > ANET_LOG_LEVEL > LOG_LEVEL > config", () => {
    expect(resolveLogLevel({
      flagValue: "error", anetEnvValue: "warn", envValue: "info", configValue: "debug",
    }).source).toBe("flag");
    expect(resolveLogLevel({
      anetEnvValue: "warn", envValue: "info", configValue: "debug",
    }).source).toBe("ANET_LOG_LEVEL");
    expect(resolveLogLevel({ envValue: "info", configValue: "debug" }).source).toBe("LOG_LEVEL");
    expect(resolveLogLevel({ configValue: "debug" }).source).toBe("config");
  });

  test("the pre-existing LOG_LEVEL env var still works unchanged", () => {
    // Regression guard: #1917 adds a name, it does not take one away.
    const r = resolveLogLevel({ envValue: "debug" });
    expect(r.name).toBe("debug");
    expect(r.level).toBe(0);
  });

  test("garbage falls back to info and says so exactly once", () => {
    const r = resolveLogLevel({ anetEnvValue: "quiet" });
    expect(r.name).toBe(DEFAULT_LOG_LEVEL);
    expect(r.level).toBe(LOG_LEVELS.info);
    expect(r.warning).toContain("ANET_LOG_LEVEL");
    expect(r.warning).toContain("quiet");
    expect(r.warning).toContain("debug | info | warn | error");
  });

  test("a bad higher-precedence value is reported, not papered over by a good lower one", () => {
    // Silently using config.logLevel here would hide the operator's typo
    // behind someone else's setting, and they would never learn.
    const r = resolveLogLevel({ anetEnvValue: "verbose", configValue: "debug" });
    expect(r.name).toBe("info");
    expect(r.warning).toContain("ANET_LOG_LEVEL");
  });

  test("whitespace and case are forgiven; empty strings are ignored", () => {
    expect(resolveLogLevel({ anetEnvValue: "  WARN \n" }).name).toBe("warn");
    expect(resolveLogLevel({ anetEnvValue: "", envValue: "debug" }).source).toBe("LOG_LEVEL");
    expect(resolveLogLevel({ anetEnvValue: "   ", envValue: "debug" }).source).toBe("LOG_LEVEL");
  });

  test("non-strings are ignored rather than crashing a starting node", () => {
    expect(resolveLogLevel({ flagValue: true as unknown as string, envValue: "warn" }).source).toBe("LOG_LEVEL");
    expect(resolveLogLevel({ anetEnvValue: 3 as unknown as string }).source).toBe("default");
  });
});

describe("wiring (#1917 ③)", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8").replace(/\r\n?/g, "\n");

  test("cli.ts resolves through the module and reads ANET_LOG_LEVEL", () => {
    expect(cli.includes("resolveLogLevel(")).toBe(true);
    expect(cli.includes("process.env.ANET_LOG_LEVEL")).toBe(true);
  });

  test("the silent `?? 1` fallback is gone", () => {
    expect(cli.includes('(LOG_LEVELS as any)[(opts["log-level"]')).toBe(false);
  });

  test("the invalid-value warning is actually emitted", () => {
    expect(cli.includes("LOG_LEVEL_RESOLUTION.warning")).toBe(true);
  });
});
