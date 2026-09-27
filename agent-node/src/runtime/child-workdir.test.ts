import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertWorkdirAllowed,
  assertWorkdirAscii,
  childWorkDirFor,
  expandWorkdir,
  forgetChildWorkdir,
  otherNodeIn,
  prepareChildWorkdir,
  readChildWorkdirs,
  recordChildWorkdir,
  resolveDefaultWorkdirRoot,
  WorkdirError,
} from "./child-workdir";
import { handleStartDoorbell } from "./start-daemon";
import { _resetChildrenMapForTest, handleStopDoorbell, recordSpawnedChild } from "./stop-daemon";
import { buildConfigSnapshot } from "./config-apply";

// app「新建节点」工作目录 —— daemon 侧。见 child-workdir.ts 顶部注释。

const H = "/home/user";
const env = { home: H, platform: "linux" as const };

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof WorkdirError ? e.message : `other:${(e as Error).message}`; }
  return "no_throw";
}

describe("expandWorkdir — literal only", () => {
  test("~ and ~/x expand against the daemon HOME", () => {
    expect(expandWorkdir("~", env)).toBe(H);
    expect(expandWorkdir("~/proj", env)).toBe(`${H}/proj`);
    expect(expandWorkdir("  ~/proj/  ", env)).toBe(`${H}/proj`);
  });
  test("absolute paths are normalised (.. collapsed)", () => {
    expect(expandWorkdir("/srv/a/../b", env)).toBe("/srv/b");
  });
  test("rejects relative, ~user, control chars, empty, oversize, non-string", () => {
    for (const v of ["proj", "./p", "~bob/x", "/a\nb", "/a\u0000b", "", "  ", "/" + "a".repeat(1100), 5, null]) {
      expect(code(() => expandWorkdir(v, env))).toStartWith("workdir_invalid");
    }
  });
  test("win32: drive paths and ~\\ accepted, drive-relative rejected", () => {
    const w = { home: "C:\\Users\\alice", platform: "win32" as const };
    expect(expandWorkdir("D:\\work\\x", w)).toBe("D:\\work\\x");
    expect(expandWorkdir("~\\proj", w)).toBe("C:\\Users\\alice\\proj");
    expect(code(() => expandWorkdir("C:proj", w))).toStartWith("workdir_invalid");
    expect(code(() => expandWorkdir("\\\\server\\share", w))).toStartWith("workdir_invalid");
  });
});

describe("assertWorkdirAllowed", () => {
  test("🔴 $HOME itself is rejected", () => {
    expect(code(() => assertWorkdirAllowed(H, env))).toBe("workdir_is_home");
  });
  test("ancestors of $HOME (/, /home) are rejected — they contain home", () => {
    expect(code(() => assertWorkdirAllowed("/", env))).toStartWith("workdir_is_system_dir");
    expect(code(() => assertWorkdirAllowed("/home", env))).toStartWith("workdir_is_system_dir");
  });
  test("system dirs and anything below them are rejected", () => {
    for (const p of ["/etc", "/etc/x", "/usr/local/proj", "/var/lib/x", "/proc/1", "/bin", "/System/x", "/private/etc/x"]) {
      expect(code(() => assertWorkdirAllowed(p, env))).toStartWith("workdir_is_system_dir");
    }
  });
  test("prefix look-alikes are NOT system dirs (/etcetera, /usrdata)", () => {
    expect(code(() => assertWorkdirAllowed("/etcetera/x", env))).toBe("no_throw");
    expect(code(() => assertWorkdirAllowed("/usrdata", env))).toBe("no_throw");
  });
  test("normal project dirs pass", () => {
    for (const p of [`${H}/proj`, `${H}/work/proj`, "/srv/proj", "/tmp/x", "/opt/proj", "/data/x"]) {
      expect(code(() => assertWorkdirAllowed(p, env))).toBe("no_throw");
    }
  });
  test("win32: home / drive root / Windows dir rejected, project passes", () => {
    const w = { home: "C:\\Users\\alice", platform: "win32" as const };
    expect(code(() => assertWorkdirAllowed("C:\\Users\\alice", w))).toBe("workdir_is_home");
    expect(code(() => assertWorkdirAllowed("c:\\users\\ALICE", w))).toBe("workdir_is_home");
    expect(code(() => assertWorkdirAllowed("D:\\", w))).toStartWith("workdir_is_system_dir");
    expect(code(() => assertWorkdirAllowed("C:\\Windows\\System32", w))).toStartWith("workdir_is_system_dir");
    expect(code(() => assertWorkdirAllowed("C:\\Program Files\\x", w))).toStartWith("workdir_is_system_dir");
    expect(code(() => assertWorkdirAllowed("C:\\Users\\alice\\proj", w))).toBe("no_throw");
    expect(code(() => assertWorkdirAllowed("D:\\work\\proj", w))).toBe("no_throw");
  });
});

describe("assertWorkdirAscii — node workdirs are ASCII below $HOME", () => {
  test("🔴 a CJK directory name under $HOME is rejected", () => {
    expect(code(() => assertWorkdirAscii(`${H}/吉他大师`, env))).toBe("workdir_not_ascii");
    expect(code(() => assertWorkdirAscii(`${H}/work/café`, env))).toBe("workdir_not_ascii");
    expect(code(() => assertWorkdirAscii("/srv/节点", env))).toBe("workdir_not_ascii");
  });
  test("ASCII paths (incl. spaces, dots, dashes) pass", () => {
    for (const p of [`${H}/jitadashi`, `${H}/my proj`, `${H}/a.b_c-d`, "/srv/node-1a2b3c"]) {
      expect(code(() => assertWorkdirAscii(p, env))).toBe("no_throw");
    }
  });
  test("a non-ASCII $HOME itself is not held against the user (only the part below it counts)", () => {
    const w = { home: "C:\\Users\\张三", platform: "win32" as const };
    expect(code(() => assertWorkdirAscii("C:\\Users\\张三\\proj", w))).toBe("no_throw");
    expect(code(() => assertWorkdirAscii("C:\\Users\\张三\\项目", w))).toBe("workdir_not_ascii");
    const u = { home: "/home/张三", platform: "linux" as const };
    expect(code(() => assertWorkdirAscii("/home/张三/proj", u))).toBe("no_throw");
  });
});

let scratch = "";
let home = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "child-workdir-"));
  home = join(scratch, "home");
  mkdirSync(home, { mode: 0o755 });
  _resetChildrenMapForTest();
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

function writeNode(dir: string, alias: string, nodeId = `node_${alias.replace(/-/g, "_")}`) {
  const d = join(dir, ".anet", "nodes", alias);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(d, "config.json"), JSON.stringify({ node_id: nodeId, node_name: alias, alias, token: "ntok_x" }), { mode: 0o600 });
}

describe("prepareChildWorkdir — on disk", () => {
  test("missing dir is created 0700, including intermediate dirs", () => {
    const wd = prepareChildWorkdir("~/deep/proj", "c1", { home });
    expect(wd).toBe(join(home, "deep", "proj"));
    expect(statSync(wd).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "deep")).mode & 0o777).toBe(0o700);
  });
  test("existing dir keeps its mode (it is the user's project)", () => {
    const p = join(home, "proj");
    mkdirSync(p, { mode: 0o755 });
    chmodSync(p, 0o755);
    expect(prepareChildWorkdir(p, "c1", { home })).toBe(p);
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });
  test("🔴 a directory already hosting a DIFFERENT node is refused, naming it", () => {
    const p = join(home, "proj");
    writeNode(p, "other-node");
    expect(code(() => prepareChildWorkdir(p, "c1", { home }))).toBe("workdir_has_other_node:other-node");
  });
  test("the same node's own leftover dir is fine (retry / recreate)", () => {
    const p = join(home, "proj");
    writeNode(p, "c1");
    expect(prepareChildWorkdir(p, "c1", { home })).toBe(p);
  });
  test("a nodes/ entry without config.json is not a node", () => {
    const p = join(home, "proj");
    mkdirSync(join(p, ".anet", "nodes", "empty-shell"), { recursive: true });
    expect(otherNodeIn(p, "c1")).toBeNull();
  });
  test("a regular file at the path is refused", () => {
    const p = join(home, "afile");
    writeFileSync(p, "x");
    expect(code(() => prepareChildWorkdir(p, "c1", { home }))).toBe("workdir_invalid:not_a_directory");
  });
  test("🔴 a symlink that resolves to $HOME is refused after realpath", () => {
    const link = join(home, "sneaky");
    symlinkSync(home, link);
    expect(code(() => prepareChildWorkdir(link, "c1", { home }))).toBe("workdir_is_home");
  });
  test("🔴 a symlink that resolves into a system dir is refused after realpath", () => {
    const link = join(home, "etc-link");
    symlinkSync("/etc", link);
    expect(code(() => prepareChildWorkdir(link, "c1", { home }))).toStartWith("workdir_is_system_dir");
  });
  test("🔴 non-ASCII workdir refused BEFORE any directory is created", () => {
    expect(code(() => prepareChildWorkdir("~/吉他大师", "c1", { home }))).toBe("workdir_not_ascii");
    expect(existsSync(join(home, "吉他大师"))).toBe(false);
  });
  test("$HOME itself is refused before anything is created", () => {
    expect(code(() => prepareChildWorkdir("~", "c1", { home }))).toBe("workdir_is_home");
  });
});

describe("resolveDefaultWorkdirRoot", () => {
  test("unset → the daemon's HOME (keeps $HOME/<name>/.anet inside the boot sweep glob)", () => {
    expect(resolveDefaultWorkdirRoot({}, env)).toBe(H);
    expect(resolveDefaultWorkdirRoot(undefined, env)).toBe(H);
  });
  test("configured ~/work and absolute roots are expanded", () => {
    expect(resolveDefaultWorkdirRoot({ default_workdir_root: "~/work" }, env)).toBe(`${H}/work`);
    expect(resolveDefaultWorkdirRoot({ default_workdir_root: "/srv/nodes" }, env)).toBe("/srv/nodes");
  });
  test("configured bad / system / ancestor roots are not advertised (null)", () => {
    for (const v of ["relative", "/etc", "/", "/home", 7]) {
      expect(resolveDefaultWorkdirRoot({ default_workdir_root: v }, env)).toBeNull();
    }
  });
});

describe("child workdir registry", () => {
  test("record / read / forget round-trip; file is 0600", () => {
    const daemon = join(scratch, "daemon");
    mkdirSync(daemon);
    recordChildWorkdir(daemon, "c1", "/srv/c1");
    expect(readChildWorkdirs(daemon)).toEqual({ c1: "/srv/c1" });
    expect(statSync(join(daemon, ".anet", "child-workdirs.json")).mode & 0o777).toBe(0o600);
    forgetChildWorkdir(daemon, "c1");
    expect(readChildWorkdirs(daemon)).toEqual({});
  });
  test("a child placed in the daemon's own dir is not recorded (legacy layout)", () => {
    const daemon = join(scratch, "daemon");
    mkdirSync(daemon);
    recordChildWorkdir(daemon, "c1", daemon);
    expect(existsSync(join(daemon, ".anet", "child-workdirs.json"))).toBe(false);
  });
  test("childWorkDirFor: registered + existing → that dir; unregistered or vanished → daemon dir", () => {
    const daemon = join(scratch, "daemon");
    const wd = join(scratch, "wd");
    mkdirSync(daemon); mkdirSync(wd);
    recordChildWorkdir(daemon, "c1", wd);
    recordChildWorkdir(daemon, "gone", join(scratch, "nope"));
    expect(childWorkDirFor(daemon, "c1")).toBe(wd);
    expect(childWorkDirFor(daemon, "unknown")).toBe(daemon);
    expect(childWorkDirFor(daemon, "gone")).toBe(daemon);
  });
  test("garbage registry reads as empty (never throws)", () => {
    const daemon = join(scratch, "daemon");
    mkdirSync(join(daemon, ".anet"), { recursive: true });
    writeFileSync(join(daemon, ".anet", "child-workdirs.json"), "[1,2");
    expect(readChildWorkdirs(daemon)).toEqual({});
    writeFileSync(join(daemon, ".anet", "child-workdirs.json"), JSON.stringify({ a: "relative", b: 3, c: "/ok" }));
    expect(readChildWorkdirs(daemon)).toEqual({ c: "/ok" });
  });
});

describe("start / delete doorbells follow the registry", () => {
  test("🔴 start after stop finds a child that lives in its own workdir and spawns there", async () => {
    const daemon = join(scratch, "daemon");
    const wd = join(scratch, "wd-c1");
    mkdirSync(daemon); mkdirSync(wd);
    writeNode(wd, "c1", "node_c1");
    recordChildWorkdir(daemon, "c1", wd);
    const acks: any[] = [];
    let cwd = "";
    await handleStartDoorbell({ request_id: "str_1" }, {
      workDir: daemon,
      callCommHub: async (tool, args) => {
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_c1", child_alias: "c1" };
        acks.push({ tool, args }); return { ok: true };
      },
      anetBin: () => "/trusted/anet",
      spawnChild: ((_b: string, _a: string[], opts: any) => { cwd = opts.cwd; return { pid: 4242, unref() {} } as any; }) as any,
      signalProcess: () => {}, log: () => {}, warn: () => {},
    });
    expect(cwd).toBe(wd);
    expect(acks.at(-1)?.args.status).toBe("started");
  });

  test("legacy child (not registered) still starts from the daemon dir", async () => {
    const daemon = join(scratch, "daemon");
    mkdirSync(daemon);
    writeNode(daemon, "c1", "node_c1");
    let cwd = "";
    const acks: any[] = [];
    await handleStartDoorbell({ request_id: "str_2" }, {
      workDir: daemon,
      callCommHub: async (tool, args) => {
        if (tool === "get_start_request") return { ok: true, child_node_id: "node_c1", child_alias: "c1" };
        acks.push({ tool, args }); return { ok: true };
      },
      anetBin: () => "/trusted/anet",
      spawnChild: ((_b: string, _a: string[], opts: any) => { cwd = opts.cwd; return { pid: 4243, unref() {} } as any; }) as any,
      signalProcess: () => {}, log: () => {}, warn: () => {},
    });
    expect(cwd).toBe(daemon);
    expect(acks.at(-1)?.args.status).toBe("started");
  });

  test("🔴 delete moves the config out of the child's own workdir, trashes it there, and forgets the entry", async () => {
    const daemon = join(scratch, "daemon");
    const wd = join(scratch, "wd-c1");
    mkdirSync(daemon); mkdirSync(wd);
    writeNode(wd, "c1", "node_c1");
    recordChildWorkdir(daemon, "c1", wd);
    recordSpawnedChild("node_c1", "c1", 999_999);
    const acks: any[] = [];
    await handleStopDoorbell({ request_id: "sr_1" }, {
      workDir: daemon,
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_1", child_node_id: "node_c1", child_alias: "c1", action: "delete", delete_config: true, grace_seconds: 1 };
        }
        acks.push({ tool, args }); return { ok: true };
      },
      signalProcess: (_pid: number, sig: any) => { if (sig === 0) { const e: any = new Error("ESRCH"); e.code = "ESRCH"; throw e; } },
      readPgid: () => null,
      log: () => {}, warn: () => {},
    });
    expect(existsSync(join(wd, ".anet", "nodes", "c1"))).toBe(false);
    expect(acks.at(-1)?.args.backup_path).toStartWith(join(wd, ".anet", "deleted") + "/");
    expect(readFileSync(join(acks.at(-1).args.backup_path, "config.json"), "utf8")).toContain("node_c1");
    expect(readChildWorkdirs(daemon)).toEqual({});
    // The project dir itself is left in place — it is the user's.
    expect(existsSync(wd)).toBe(true);
  });

  test("stop (not delete) keeps the registry entry so a later start still finds the child", async () => {
    const daemon = join(scratch, "daemon");
    const wd = join(scratch, "wd-c1");
    mkdirSync(daemon); mkdirSync(wd);
    writeNode(wd, "c1", "node_c1");
    recordChildWorkdir(daemon, "c1", wd);
    await handleStopDoorbell({ request_id: "sr_2" }, {
      workDir: daemon,
      callCommHub: async (tool: string) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_2", child_node_id: "node_c1", child_alias: "c1", action: "stop", delete_config: false, grace_seconds: 1 };
        }
        return { ok: true };
      },
      signalProcess: () => {}, log: () => {}, warn: () => {},
    });
    expect(readChildWorkdirs(daemon)).toEqual({ c1: wd });
    expect(existsSync(join(wd, ".anet", "nodes", "c1", "config.json"))).toBe(true);
  });
});

describe("capability self-report", () => {
  test("daemon snapshot carries default_workdir_root when computed", () => {
    const snap = buildConfigSnapshot({ role: "host_supervisor" }, false, 0, { ok: true, defaultWorkdirRoot: H });
    expect(snap.daemon_capabilities?.default_workdir_root).toBe(H);
  });
  test("not computed / null → key absent (old-daemon shape; app hides the row)", () => {
    expect(buildConfigSnapshot({ role: "host_supervisor" }, false, 0, { ok: true }).daemon_capabilities?.default_workdir_root).toBeUndefined();
    expect(buildConfigSnapshot({ role: "host_supervisor" }, false, 0, { ok: true, defaultWorkdirRoot: null }).daemon_capabilities?.default_workdir_root).toBeUndefined();
    expect(buildConfigSnapshot({}, false, 0, undefined).daemon_capabilities).toBeUndefined();
  });
});
