import { describe, expect, test } from "bun:test";
import {
  copresenceDeps,
  describeMissingDeps,
  isLoopbackHub,
  missingCopresenceDeps,
} from "./copresence-deps";

const has = (...present: string[]) => (cmd: string) => present.includes(cmd);

describe("all gaps at once, not one per run", () => {
  test("a bare machine reports every missing dependency in one pass", () => {
    // The point of this module. The guards it replaces exited at the first gap,
    // so a box missing tmux AND codex needed two runs to learn both.
    const missing = missingCopresenceDeps(has(), "linux").map((d) => d.name);
    expect(missing).toEqual(["tmux", "codex", "bun"]);
  });

  test("a complete machine reports nothing", () => {
    expect(missingCopresenceDeps(has("tmux", "codex", "bunx"), "linux")).toEqual([]);
  });

  test("bunx alone satisfies the bun dependency", () => {
    // `anet hub start` accepts either; probing only `bun` would reject a PATH
    // that carries just `bunx` — a false failure on a working machine.
    expect(missingCopresenceDeps(has("tmux", "codex", "bunx"), "linux").map((d) => d.name)).toEqual([]);
    expect(missingCopresenceDeps(has("tmux", "codex", "bun"), "linux").map((d) => d.name)).toEqual([]);
  });
});

describe("the hint is a command, not advice", () => {
  test("names a runnable line per platform", () => {
    const linux = copresenceDeps(has(), "linux");
    expect(linux.find((d) => d.name === "tmux")!.install).toContain("apt-get install");
    expect(copresenceDeps(has(), "darwin").find((d) => d.name === "tmux")!.install).toBe("brew install tmux");
    expect(linux.find((d) => d.name === "codex")!.install).toBe("npm install -g @openai/codex");
  });

  test("says so honestly when there is no one-liner", () => {
    // Better than printing a linux command on windows and having it fail.
    expect(copresenceDeps(has(), "win32").find((d) => d.name === "tmux")!.install).toBeNull();
    expect(describeMissingDeps(copresenceDeps(has(), "win32").filter((d) => d.name === "tmux"), "n"))
      .toContain("no install command for this platform");
  });

  test("the block names every gap and what each is for", () => {
    const msg = describeMissingDeps(missingCopresenceDeps(has(), "linux"), "通信牛");
    for (const needle of ["通信牛", "tmux", "codex", "bun", "apt-get install", "npm install -g @openai/codex"]) {
      expect(msg).toContain(needle);
    }
    expect(msg).toContain("3 thing(s)");
  });
});

describe("which hub we may start ourselves", () => {
  test("loopback is ours to start", () => {
    for (const u of ["http://127.0.0.1:9200", "http://localhost:9200", "http://[::1]:9200"]) {
      expect(isLoopbackHub(u)).toBe(true);
    }
  });

  test("🔴 a remote hub is never ours to start", () => {
    // Spawning a local hub when a remote one refuses would point the node at a
    // DIFFERENT hub than its profile names — it would come up "working" and be
    // invisible to everyone who expects it on the real one.
    for (const u of ["http://10.0.0.5:9200", "https://hub.example.com", "http://192.168.1.9:9200"]) {
      expect(isLoopbackHub(u)).toBe(false);
    }
  });

  test("an unparseable url is not loopback", () => {
    expect(isLoopbackHub("")).toBe(false);
    expect(isLoopbackHub("not a url")).toBe(false);
  });
});
