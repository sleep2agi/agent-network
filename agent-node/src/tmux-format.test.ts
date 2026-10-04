// Board #556 — agent-node half of #533. Outside a UTF-8 locale (LANG=C/POSIX) tmux
// rewrites a TAB in -F output AND every byte of a CJK session name to `_`, so a
// co-presence node named `通信牛` was "session-missing" to codex-health and had no
// session id for the app-server relaunch veto. Every parsed listing now goes through
// tmux-format.ts (a byte-identical copy of agent-network's; parity test lives there).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTmuxRows, TMUX_FIELD_SEP, tmuxListArgs, tmuxUtf8Args } from "./tmux-format";
import { classifyTuiPane, parseTmuxPanes, TMUX_PANE_LIST_ARGS } from "./runtime/codex-health";
import { sessionIdFor, TMUX_SESSION_ID_LIST_ARGS } from "./runtime/codex-appserver-relaunch";

describe("#556 agent-node tmux listings are locale-proof", () => {
  test("pane and session listings carry -u and no control characters", () => {
    for (const argv of [TMUX_PANE_LIST_ARGS, TMUX_SESSION_ID_LIST_ARGS]) {
      expect(argv[0]).toBe("-u");
      expect(argv.join(" ")).not.toMatch(/[\x00-\x1f]/);
    }
    expect([...TMUX_PANE_LIST_ARGS]).toEqual(tmuxListArgs(["list-panes", "-a"], ["#{session_name}", "#{pane_pid}", "#{pane_dead}", "#{pane_current_command}"]));
    expect(tmuxUtf8Args(["display-message", "-p", "#S"])).toEqual(["-u", "display-message", "-p", "#S"]);
  });

  test("codex-health finds a CJK session in separator rows; legacy TAB rows still parse", () => {
    const sep = (...f: string[]) => f.join(TMUX_FIELD_SEP);
    const out = `${sep("通信牛-appsrv", "11", "0", "codex")}\n${sep("通信牛", "10", "0", "node")}\n`;
    expect(parseTmuxPanes(out)).toEqual([
      { session: "通信牛-appsrv", pid: 11, dead: false, command: "codex" },
      { session: "通信牛", pid: 10, dead: false, command: "node" },
    ]);
    expect(classifyTuiPane(parseTmuxPanes(out), "通信牛", () => "node\0")).toEqual({ ok: true, reason: "running" });
    expect(parseTmuxPanes("通信牛\t10\t1\tnode\n")).toEqual([{ session: "通信牛", pid: 10, dead: true, command: "node" }]);
  });

  test("an empty pane_current_command still yields a 4-field row", () => {
    expect(parseTmuxPanes(`a${TMUX_FIELD_SEP}1${TMUX_FIELD_SEP}0${TMUX_FIELD_SEP}\n`)).toEqual([{ session: "a", pid: 1, dead: false, command: "" }]);
  });

  test("session id lookup is exact (no prefix match onto -appsrv)", () => {
    const out = `$1${TMUX_FIELD_SEP}通信牛-appsrv\n$2${TMUX_FIELD_SEP}通信牛\n`;
    expect(sessionIdFor(out, "通信牛")).toBe("$2");
    expect(sessionIdFor(out, "通信牛-appsrv")).toBe("$1");
    expect(sessionIdFor("$3\t通信牛\n", "通信牛")).toBe("$3");
    expect(sessionIdFor(out, "通信")).toBeNull();
  });

  test("the LANG=C sanitized shape (tmux without -u) never matches a CJK name", () => {
    // Measured tmux 3.3a, LANG=C: `通信牛\t10\t0\tnode` comes out as `_________10_0_node`.
    expect(parseTmuxPanes("_________10_0_node\n")).toEqual([]);
    expect(classifyTuiPane(parseTmuxPanes("_________10_0_node\n"), "通信牛", () => null)).toEqual({ ok: false, reason: "session-missing" });
    expect(sessionIdFor("$0_______\n", "通信牛")).toBeNull();
  });

  test("rows with the wrong field count are dropped, not guessed at", () => {
    expect(parseTmuxRows(`a${TMUX_FIELD_SEP}b${TMUX_FIELD_SEP}c\n`, 4)).toEqual([]);
  });
});

// Ratchet: every tmux call in agent-node whose output is parsed goes through the
// helper (which adds -u), and no -F format uses a TAB separator. Comments are
// stripped so explanations may quote the old shape.
const TMUX_CALL = /\b(execTmux|spawnSyncTmux|spawnTmux|tmux)\(\s*\[\s*"(list-sessions|list-panes|list-windows|list-clients|display-message|show-options|show-environment)"/;
const RAW_TMUX = /\b(execFileSync|spawnSync|spawn|execFile)\(\s*"tmux"\s*,\s*\[\s*"(list-sessions|list-panes|list-windows|list-clients|display-message)"/;
const TAB_FORMAT = /#\{[a-z_]+\}\\t/;

export function tmuxBypassOffenders(files: Array<{ path: string; text: string }>): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "").replace(/\s\/\/\s.*$/, "");
      if (TMUX_CALL.test(code) || RAW_TMUX.test(code) || TAB_FORMAT.test(code)) offenders.push(`${path}:${i + 1}`);
    });
  }
  return offenders;
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") collectSources(p, out); }
    else if (/\.(ts|mts|cts|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("#556 ratchet — agent-node tmux listings use the helper", () => {
  const files = collectSources(import.meta.dir);

  test("collects src recursively (取集 self-check)", () => {
    for (const f of ["tmux-format.ts", join("runtime", "codex-health.ts"), join("runtime", "codex-appserver-relaunch.ts"), join("runtime", "opencode-copresence", "attach-tui.ts")]) {
      expect(files).toContain(join(import.meta.dir, f));
    }
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(files.length).toBeGreaterThan(50);
  });

  test("criterion self-check: each pre-#556 shape is flagged, the helper shapes are not", () => {
    const bad = [
      'execTmux(["list-panes", "-a", "-F", "#{session_name}\\t#{pane_pid}"], {',
      '    out = execTmux(["list-sessions", "-F", "#{session_id}"], { encoding: "utf-8" });',
      '    return tmux(["display-message", "-p", "-t", pane, `#{${field}}`]).trim();',
      // split so the repo-wide #505 tmux ratchet does not read this fixture as a real call
      'execFileSync("tm' + 'ux", ["list-panes", "-a"])',
      'const F = "#{session_name}\\t#{pane_pid}";',
    ];
    for (const line of bad) expect(tmuxBypassOffenders([{ path: "x.ts", text: line }])).toEqual(["x.ts:1"]);
    const good = [
      "execTmux(TMUX_PANE_LIST_ARGS, {",
      'return tmux(tmuxUtf8Args(["display-message", "-p", "-t", pane, `#{${field}}`])).trim();',
      '// execTmux(["list-sessions", "-F", "#{session_id}\\t#{session_name}"]) — old shape',
      ' * `tmux list-panes -a -F \'#{session_name}\\t#{pane_pid}\'` old doc',
      'deps.tmux(["kill-session", "-t", id]);',
    ];
    expect(tmuxBypassOffenders(good.map((text, i) => ({ path: `g${i}.ts`, text })))).toEqual([]);
  });

  test("no parsed tmux listing in agent-node/src bypasses tmux-format.ts", () => {
    expect(tmuxBypassOffenders(files.map((path) => ({ path, text: readFileSync(path, "utf8") })))).toEqual([]);
  });
});
