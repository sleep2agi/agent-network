import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTmuxRows, TMUX_FIELD_SEP, tmuxFormat, tmuxListArgs, tmuxUtf8Args } from "./tmux-format";
import { findExactTmuxSession, parseTmuxSessions, SESSION_LIST_ARGS } from "./tmux-attach";
import { PANE_LIST_ARGS } from "./tmux-exact-target";

describe("#533 tmux format helper", () => {
  test("separator is printable ASCII (tmux never sanitizes it)", () => {
    expect(TMUX_FIELD_SEP).toMatch(/^[\x21-\x7e]+$/);
  });

  test("list args force UTF-8 output with -u and join fields with the separator", () => {
    expect(tmuxListArgs(["list-sessions"], ["#{session_id}", "#{session_name}"]))
      .toEqual(["-u", "list-sessions", "-F", `#{session_id}${TMUX_FIELD_SEP}#{session_name}`]);
    expect(tmuxUtf8Args(["display-message", "-p", "#S"])).toEqual(["-u", "display-message", "-p", "#S"]);
    expect(tmuxFormat(["a", "b", "c"])).toBe(`a${TMUX_FIELD_SEP}b${TMUX_FIELD_SEP}c`);
  });

  test("the attach and pane listings go through -u and carry no control characters", () => {
    for (const argv of [SESSION_LIST_ARGS, PANE_LIST_ARGS]) {
      expect(argv[0]).toBe("-u");
      expect(argv.join(" ")).not.toMatch(/[\x00-\x1f]/);
    }
  });

  test("parses separator rows with CJK names exactly", () => {
    const out = `$1${TMUX_FIELD_SEP}通信牛-appsrv\n$2${TMUX_FIELD_SEP}通信牛\n`;
    expect(parseTmuxRows(out, 2)).toEqual([["$1", "通信牛-appsrv"], ["$2", "通信牛"]]);
    expect(findExactTmuxSession(out, "通信牛")).toEqual({ id: "$2", name: "通信牛" });
  });

  test("legacy TAB rows still parse; CRLF tolerated", () => {
    expect(parseTmuxRows("$1\t通信牛\r\n", 2)).toEqual([["$1", "通信牛"]]);
  });

  test("rows with the wrong field count are dropped, not guessed at", () => {
    expect(parseTmuxRows(`a${TMUX_FIELD_SEP}b${TMUX_FIELD_SEP}c\nonly\n`, 2)).toEqual([]);
  });

  test("single-field rows keep the whole line, even one containing a TAB", () => {
    expect(parseTmuxRows("x\ty\nz\n", 1)).toEqual([["x\ty"], ["z"]]);
  });

  test("the LANG=C sanitized shape (what tmux prints without -u) never matches a CJK name", () => {
    // Measured tmux 3.3a, LANG=C: `$0\t通信牛` comes out as `$0_______`.
    expect(parseTmuxSessions("$0_______\n")).toEqual([]);
    expect(findExactTmuxSession("$0_______\n", "通信牛")).toBeNull();
  });
});

// Ratchet: no production tmux -F format in agent-network may use a control
// character separator, and every list-sessions/list-panes call goes through the
// helper (which adds -u). Comments are stripped so explanations may quote the old shape.
describe("#533 ratchet — production tmux listings use the helper", () => {
  const root = join(import.meta.dir, "..");
  const files = [join(root, "bin", "cli.ts")];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|tsx)$/.test(e.name) && !/\.test\.|\.real\.test\./.test(e.name)) files.push(p);
    }
  };
  walk(join(root, "src"));

  test("collects src recursively (取集 self-check)", () => {
    expect(files.some((f) => f.endsWith(join("src", "tmux-format.ts")))).toBe(true);
    expect(files.some((f) => f.includes(join("src", "im", "")))).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  test("no bare execTmux([\"list-sessions\"|\"list-panes\"|\"display-message\" ...]) and no \\t in a format", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/execTmux\(\[\s*"(list-sessions|list-panes|display-message)"/.test(code)) offenders.push(`${f}:${i + 1}`);
        if (/#\{[a-z_]+\}\\t#\{/.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
