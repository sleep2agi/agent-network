// #214 维度 5 A6 — unit test for the grok-build-acp idle-timeout
// resolver. The startup log surfaces (valueMs, source) so an operator can
// see at a glance whether their `flags.grokAcpTimeoutMs` setting actually
// took effect; the precedence here MUST match the inline parseInt() chain
// in cli.ts so they stay coherent.
import { describe, expect, test } from "bun:test";
import { resolveGrokAcpTimeout } from "./timeout-resolve";

describe("resolveGrokAcpTimeout", () => {
  test("env wins over flags and default (mirrors cli.ts precedence)", () => {
    const r = resolveGrokAcpTimeout({
      envValue: "600000",
      flagValue: "120000",
      defaultMs: 300000,
    });
    expect(r.valueMs).toBe(600000);
    expect(r.source).toBe("env");
    expect(r.rawValue).toBe("600000");
  });

  test("flag wins over default when env is unset", () => {
    const r = resolveGrokAcpTimeout({
      envValue: undefined,
      flagValue: 120000,
      defaultMs: 300000,
    });
    expect(r.valueMs).toBe(120000);
    expect(r.source).toBe("flags");
    expect(r.rawValue).toBe("120000");
  });

  test("flag string is parsed (config.json values arrive as strings or numbers)", () => {
    const r = resolveGrokAcpTimeout({
      envValue: undefined,
      flagValue: "1800000",
      defaultMs: 300000,
    });
    expect(r.valueMs).toBe(1800000);
    expect(r.source).toBe("flags");
  });

  test("default fires when neither env nor flag is set", () => {
    const r = resolveGrokAcpTimeout({
      envValue: undefined,
      flagValue: undefined,
      defaultMs: 300000,
    });
    expect(r.valueMs).toBe(300000);
    expect(r.source).toBe("default");
    expect(r.rawValue).toBeUndefined();
  });

  test("empty string env is ignored (operator unset the var)", () => {
    const r = resolveGrokAcpTimeout({
      envValue: "",
      flagValue: 120000,
      defaultMs: 300000,
    });
    expect(r.source).toBe("flags");
    expect(r.valueMs).toBe(120000);
  });

  test("null and empty flag are ignored — falls through to default", () => {
    expect(resolveGrokAcpTimeout({ envValue: null, flagValue: null, defaultMs: 300000 }).source).toBe("default");
    expect(resolveGrokAcpTimeout({ envValue: null, flagValue: "", defaultMs: 300000 }).source).toBe("default");
  });

  test("non-numeric / negative / NaN inputs fall through (the silent-default trap)", () => {
    // The dispatch flagged that operators put obviously-wrong values
    // in config and the runtime silently fell back to default — these
    // assertions pin that behaviour so future refactors don't hide it.
    expect(resolveGrokAcpTimeout({ envValue: "abc", flagValue: undefined, defaultMs: 300000 }).source).toBe("default");
    expect(resolveGrokAcpTimeout({ envValue: undefined, flagValue: "-1", defaultMs: 300000 }).source).toBe("default");
    expect(resolveGrokAcpTimeout({ envValue: undefined, flagValue: 0, defaultMs: 300000 }).source).toBe("default");
    expect(resolveGrokAcpTimeout({ envValue: undefined, flagValue: NaN, defaultMs: 300000 }).source).toBe("default");
  });
});
