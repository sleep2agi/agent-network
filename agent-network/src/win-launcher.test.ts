import { describe, expect, test } from "bun:test";
import { launcherArgv, launcherNeedsShell, quoteForCmd, runLauncherSync } from "./win-launcher";

describe("which platform needs the interpreter", () => {
  test("only windows", () => {
    expect(launcherNeedsShell("win32")).toBe(true);
    for (const p of ["linux", "darwin", "freebsd"] as const) expect(launcherNeedsShell(p)).toBe(false);
  });
});

describe("argv construction", () => {
  test("posix runs the file directly — unchanged from before", () => {
    expect(launcherArgv("npm", ["ls", "-g", "--json"], "linux"))
      .toEqual({ file: "npm", argv: ["ls", "-g", "--json"] });
  });

  test("windows goes through the interpreter with an argv, never shell:true", () => {
    // shell:true would concatenate the caller's args into one string (DEP0190)
    // and hand quoting to every call site. One place, one test, instead.
    const got = launcherArgv("npm", ["view", "@sleep2agi/agent-network", "version"], "win32", "C:\\Windows\\system32\\cmd.exe");
    expect(got.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(got.argv.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(got.argv[3]).toBe("npm view @sleep2agi/agent-network version");
  });

  test("falls back to cmd.exe when ComSpec is unset", () => {
    expect(launcherArgv("npm", [], "win32", undefined).file).toBe("cmd.exe");
  });

  test("/d is present — AutoRun must not run inside our launcher calls", () => {
    // Without /d, a machine-local AutoRun registry entry executes on every
    // single npm/npx/bunx call this process makes.
    expect(launcherArgv("bunx", ["x"], "win32").argv).toContain("/d");
  });
});

describe("cmd quoting", () => {
  test("leaves ordinary arguments bare so process listings stay readable", () => {
    for (const a of ["npm", "ls", "-g", "--json", "@sleep2agi/agent-node", "2.5.0-preview.32"]) {
      expect(quoteForCmd(a)).toBe(a);
    }
  });

  test("quotes whitespace and cmd metacharacters", () => {
    expect(quoteForCmd("a b")).toBe('"a b"');
    for (const meta of ["&", "|", "<", ">", "^", "(", ")", "%", "!"]) {
      expect(quoteForCmd(`x${meta}y`)).toBe(`"x${meta}y"`);
    }
  });

  test("🔴 a quote inside an argument is doubled, not backslash-escaped", () => {
    // cmd does not use backslash escaping. Getting this wrong ends the quoted
    // region early and hands the rest of the argument to cmd as commands.
    expect(quoteForCmd('a"b')).toBe('"a""b"');
  });

  test("an empty argument survives as an empty argument", () => {
    expect(quoteForCmd("")).toBe('""');
  });

  test("a package spec carrying a separator cannot escape its own argument", () => {
    const evil = "pkg& calc.exe";
    const line = launcherArgv("npm", ["view", evil], "win32").argv[3];
    expect(line).toBe('npm view "pkg& calc.exe"');
    expect(line.indexOf("& calc")).toBeGreaterThan(line.indexOf('"'));
  });
});

describe("it actually runs something on this platform", () => {
  test("round-trips a real command", () => {
    // Guards against the helper being syntactically fine but producing an argv
    // the current platform cannot execute.
    const out = runLauncherSync(process.execPath, ["-e", "process.stdout.write('ok')"], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    expect(String(out)).toContain("ok");
  });
});
