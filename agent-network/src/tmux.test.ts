import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTmuxInvocation,
  execTmux,
  isKillServer,
  resolveTmuxIsolation,
  socketOfTmuxVar,
  spawnSyncTmux,
  spawnTmux,
  TmuxKillServerRefused,
} from "./tmux";

// #505 — the parent pane's $TMUX, exactly the shape that killed 71 nodes.
const PARENT_TMUX = "/tmp/tmux-1000/default,4242,0";

describe("#505 resolveTmuxIsolation", () => {
  test("no isolation variables ⇒ null (production default server, unchanged)", () => {
    expect(resolveTmuxIsolation({ TMUX: PARENT_TMUX, TMUX_PANE: "%3" }, 1000)).toBeNull();
  });

  test("TMUX_TMPDIR resolves the way tmux does: <dir>/tmux-<uid>/default", () => {
    expect(resolveTmuxIsolation({ TMUX_TMPDIR: "/tmp/x" }, 1000)).toEqual({
      socket: "/tmp/x/tmux-1000/default",
      source: "TMUX_TMPDIR",
    });
  });

  test("ANET_TMUX_SOCKET wins over TMUX_TMPDIR", () => {
    expect(resolveTmuxIsolation({ ANET_TMUX_SOCKET: "/s/sock", TMUX_TMPDIR: "/tmp/x" }, 1000)).toEqual({
      socket: "/s/sock",
      source: "ANET_TMUX_SOCKET",
    });
  });

  test("blank values do not count as isolation", () => {
    expect(resolveTmuxIsolation({ ANET_TMUX_SOCKET: "  ", TMUX_TMPDIR: "" }, 1000)).toBeNull();
  });
});

describe("#505 buildTmuxInvocation", () => {
  test("default: argv untouched, env left undefined so the child inherits exactly as before", () => {
    const env = { TMUX: PARENT_TMUX, TMUX_PANE: "%3", PATH: "/bin" };
    const inv = buildTmuxInvocation(["list-sessions"], env, 1000);
    expect(inv.file).toBe("tmux");
    expect(inv.args).toEqual(["list-sessions"]);
    expect(inv.isolation).toBeNull();
    // the caller's env object is passed through by identity, not copied/stripped
    expect(inv.env).toBe(env);
  });

  test("default with no caller env: env stays undefined (execFileSync inherits process.env)", () => {
    const saved = { s: process.env.ANET_TMUX_SOCKET, t: process.env.TMUX_TMPDIR };
    delete process.env.ANET_TMUX_SOCKET; delete process.env.TMUX_TMPDIR;
    try {
      expect(buildTmuxInvocation(["-V"]).env).toBeUndefined();
    } finally {
      if (saved.s !== undefined) process.env.ANET_TMUX_SOCKET = saved.s;
      if (saved.t !== undefined) process.env.TMUX_TMPDIR = saved.t;
    }
  });

  test("TMUX_TMPDIR set inside a parent pane: explicit -S, inherited TMUX/TMUX_PANE stripped", () => {
    const env = { TMUX: PARENT_TMUX, TMUX_PANE: "%3", TMUX_TMPDIR: "/tmp/x", PATH: "/bin" };
    const inv = buildTmuxInvocation(["new-session", "-d", "-s", "probe"], env, 1000);
    expect(inv.args).toEqual(["-S", "/tmp/x/tmux-1000/default", "new-session", "-d", "-s", "probe"]);
    expect(inv.env).not.toBe(env);
    expect(inv.env!.TMUX).toBeUndefined();
    expect(inv.env!.TMUX_PANE).toBeUndefined();
    expect(inv.env!.TMUX_TMPDIR).toBe("/tmp/x");
    expect(inv.env!.PATH).toBe("/bin");
    // the caller's object is not mutated
    expect(env.TMUX).toBe(PARENT_TMUX);
  });

  test("ANET_TMUX_SOCKET: -S <socket>, TMUX stripped", () => {
    const inv = buildTmuxInvocation(["has-session", "-t", "=a"], { TMUX: PARENT_TMUX, ANET_TMUX_SOCKET: "/s/sock" }, 1000);
    expect(inv.args).toEqual(["-S", "/s/sock", "has-session", "-t", "=a"]);
    expect("TMUX" in inv.env!).toBe(false);
  });

  test("already inside the isolated server: TMUX/TMUX_PANE kept (display-message -p '#S' still works)", () => {
    const env = { TMUX: "/s/sock,99,1", TMUX_PANE: "%7", ANET_TMUX_SOCKET: "/s/sock" };
    const inv = buildTmuxInvocation(["display-message", "-p", "#S"], env, 1000);
    expect(inv.args).toEqual(["-S", "/s/sock", "display-message", "-p", "#S"]);
    expect(inv.env!.TMUX).toBe("/s/sock,99,1");
    expect(inv.env!.TMUX_PANE).toBe("%7");
  });

  test("argv is copied, never aliased", () => {
    const args = ["-V"];
    const inv = buildTmuxInvocation(args, {}, 1000);
    expect(inv.args).not.toBe(args);
  });
});

describe("#505 kill-server is refused", () => {
  for (const args of [
    ["kill-server"],
    ["-L", "private", "kill-server"],
    ["kill-session", "-t", "=x", ";", "kill-server"],
    ["kill-ser"],
    ["kill-serve"],
  ]) {
    test(`refuses: tmux ${args.join(" ")}`, () => {
      expect(isKillServer(args)).toBe(true);
      expect(() => buildTmuxInvocation(args, {}, 1000)).toThrow(TmuxKillServerRefused);
      // isolated mode refuses too
      expect(() => buildTmuxInvocation(args, { TMUX_TMPDIR: "/tmp/x" }, 1000)).toThrow(TmuxKillServerRefused);
    });
  }

  test("kill-session / kill-pane / the ambiguous `kill-s` are not mistaken for kill-server", () => {
    expect(isKillServer(["kill-session", "-t", "=x"])).toBe(false);
    expect(isKillServer(["kill-pane", "-t", "%1"])).toBe(false);
    expect(isKillServer(["kill-s"])).toBe(false);
    expect(isKillServer(["kill-se"])).toBe(false);
  });

  // The runners must refuse BEFORE spawning. Even so, point them at a socket
  // that does not exist and strip TMUX, so a broken refusal could only ever
  // reach an empty private path — never a real server on this host.
  const sandboxEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-tmux-refuse-"));
    return { dir, env: { PATH: process.env.PATH, ANET_TMUX_SOCKET: join(dir, "nope.sock") } as NodeJS.ProcessEnv };
  };

  test("execTmux / spawnSyncTmux / spawnTmux throw before spawning", () => {
    const { dir, env } = sandboxEnv();
    try {
      expect(() => execTmux(["kill-server"], { env, stdio: "ignore" })).toThrow(TmuxKillServerRefused);
      expect(() => spawnSyncTmux(["kill-server"], { env, stdio: "ignore" })).toThrow(TmuxKillServerRefused);
      expect(() => spawnTmux(["kill-server"], { env, stdio: "ignore" })).toThrow(TmuxKillServerRefused);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#505 socketOfTmuxVar", () => {
  test("parses `<socket>,<pid>,<idx>`", () => {
    expect(socketOfTmuxVar(PARENT_TMUX)).toBe("/tmp/tmux-1000/default");
    expect(socketOfTmuxVar("/only/path")).toBe("/only/path");
    expect(socketOfTmuxVar(undefined)).toBeNull();
    expect(socketOfTmuxVar("")).toBeNull();
  });
});
