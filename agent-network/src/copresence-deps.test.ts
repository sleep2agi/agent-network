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
    expect(missing).toEqual(["tmux", "codex", "bunx"]);
  });

  test("a complete machine reports nothing", () => {
    expect(missingCopresenceDeps(has("tmux", "codex", "bunx"), "linux")).toEqual([]);
  });

  test("🔴 bun without bunx is a gap, not a pass", () => {
    // The guard in `anet hub start` is `if (!commandExists("bunx"))` — tightened
    // from OR to bunx-only in #766, because the OR let a bun-only machine pass
    // preflight and then fail at `spawn("bunx", …)`. Three comments in cli.ts
    // still describe the old OR; this test is here so this module cannot drift
    // back to them. Verified in a container: bun present, bunx absent, hub
    // auto-start fired and `anet hub start` exited 1.
    expect(missingCopresenceDeps(has("tmux", "codex", "bun"), "linux").map((d) => d.name)).toEqual(["bunx"]);
  });

  test("and the fix it names is the symlink, not 'install bun'", () => {
    // Telling someone who HAS bun to install bun is wrong twice: it does not
    // fix it, and it makes them doubt everything else the tool says.
    const dep = missingCopresenceDeps(has("tmux", "codex", "bun"), "linux")[0];
    expect(dep.install).toContain("ln -s");
    expect(dep.install).toContain("bunx");
    // With no bun at all, installing it IS the answer.
    expect(missingCopresenceDeps(has("tmux", "codex"), "linux").find((d) => d.name === "bunx")!.install)
      .toBe("npm i -g bun");
  });
});

describe("the hint is a command, not advice", () => {
  test("names a runnable line per platform", () => {
    const linux = copresenceDeps(has(), "linux");
    expect(linux.find((d) => d.name === "tmux")!.install).toContain("apt-get install");
    expect(copresenceDeps(has(), "darwin").find((d) => d.name === "tmux")!.install).toBe("brew install tmux");
    expect(linux.find((d) => d.name === "codex")!.install).toBe("npm install -g @openai/codex");
  });

  test("Windows uses its native console backend and does not require tmux", () => {
    const windows = copresenceDeps(has(), "win32");
    expect(windows.map((d) => d.name)).toEqual(["codex", "bunx"]);
    expect(windows.some((d) => d.name === "tmux")).toBe(false);
  });

  test("the block names every gap and what each is for", () => {
    const msg = describeMissingDeps(missingCopresenceDeps(has(), "linux"), "通信牛");
    for (const needle of ["通信牛", "tmux", "codex", "bunx", "apt-get install", "npm install -g @openai/codex"]) {
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
