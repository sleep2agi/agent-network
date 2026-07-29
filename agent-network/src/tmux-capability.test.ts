// RFC-030 P3-A blocker 12 — tmux capability preflight.

import { describe, expect, test } from "bun:test";
import {
  parseTmuxVersion,
  tmuxSupportsSessionEnv,
  checkTmuxCapability,
  assertTmuxSupportsSessionEnv,
} from "./tmux-capability";

describe("parseTmuxVersion", () => {
  test("parses the shapes real tmux builds print", () => {
    expect(parseTmuxVersion("tmux 3.2a")).toMatchObject({ major: 3, minor: 2, suffix: "a" });
    expect(parseTmuxVersion("tmux 3.0a\n")).toMatchObject({ major: 3, minor: 0, suffix: "a" });
    expect(parseTmuxVersion("tmux 3.4")).toMatchObject({ major: 3, minor: 4, suffix: "" });
    expect(parseTmuxVersion("tmux next-3.4")).toMatchObject({ major: 3, minor: 4 });
    expect(parseTmuxVersion("tmux 2.9")).toMatchObject({ major: 2, minor: 9 });
    expect(parseTmuxVersion("tmux 1.10")).toMatchObject({ major: 1, minor: 10 });
  });

  test("returns null when there is no version to find", () => {
    expect(parseTmuxVersion("tmux master")).toBeNull();
    expect(parseTmuxVersion("")).toBeNull();
    expect(parseTmuxVersion(undefined as unknown as string)).toBeNull();
  });
});

describe("tmuxSupportsSessionEnv", () => {
  test("3.2 is the floor; the letter suffix is a patch marker and never lifts a version over it", () => {
    // Ubuntu 20.04 LTS ships 3.0a and Debian bullseye 3.1c. Both LOOK like
    // "3.x with a letter" and both reject `new-session -e`.
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 3.0a")!)).toBe(false);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 3.1c")!)).toBe(false);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 3.2")!)).toBe(true);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 3.2a")!)).toBe(true);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 3.5a")!)).toBe(true);
  });

  test("major version dominates the minor comparison", () => {
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 2.9")!)).toBe(false);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 2.99")!)).toBe(false);
    expect(tmuxSupportsSessionEnv(parseTmuxVersion("tmux 4.0")!)).toBe(true);
  });
});

describe("checkTmuxCapability", () => {
  test("too old → actionable verdict naming the required version", () => {
    const v = checkTmuxCapability(() => "tmux 3.0a");
    expect(v.kind).toBe("too_old");
    if (v.kind === "too_old") {
      expect(v.detail).toContain("3.2");
      expect(v.remedy.join(" ")).toContain("Upgrade tmux");
    }
  });

  test("tmux absent → missing verdict, not a crash", () => {
    const v = checkTmuxCapability(() => { throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }); });
    expect(v.kind).toBe("missing");
  });

  test("unparseable version → unknown (permissive: never refuse a tmux that may be fine)", () => {
    expect(checkTmuxCapability(() => "tmux master").kind).toBe("unknown");
  });

  test("modern tmux → ok", () => {
    expect(checkTmuxCapability(() => "tmux 3.4").kind).toBe("ok");
  });
});

describe("assertTmuxSupportsSessionEnv (cli wrapper)", () => {
  function run(out: string | (() => never)) {
    const logs: string[] = [];
    let failed: string | null = null;
    const fail = ((m: string) => { failed = m; throw new Error("__exit__"); }) as (m: string) => never;
    try {
      assertTmuxSupportsSessionEnv(
        typeof out === "string" ? () => out : out,
        (m) => logs.push(m),
        fail,
      );
    } catch (e: any) {
      if (e?.message !== "__exit__") throw e;
    }
    return { logs, failed: failed as string | null };
  }

  test("old tmux aborts the start with an explanation", () => {
    const r = run("tmux 3.0a");
    expect(r.failed).not.toBeNull();
    expect(r.failed).toContain("3.2");
    expect(r.failed).toContain("Upgrade tmux");
  });

  test("missing tmux aborts the start", () => {
    const r = run((() => { throw new Error("ENOENT"); }) as () => never);
    expect(r.failed).not.toBeNull();
  });

  test("modern tmux is silent and does not abort", () => {
    const r = run("tmux 3.4");
    expect(r.failed).toBeNull();
    expect(r.logs).toEqual([]);
  });

  test("unknown version warns but does NOT abort", () => {
    const r = run("tmux master");
    expect(r.failed).toBeNull();
    expect(r.logs.length).toBe(1);
    expect(r.logs[0]).toContain("3.2");
  });
});
