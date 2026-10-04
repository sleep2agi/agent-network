// #532 — `anet node codex` menu: table, confirm-before-run, typed-name delete, no tokens in output.
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CHEAT_SHEET,
  codexMenu,
  collectCodexRows,
  commandLine,
  planAction,
  renderCodexTable,
  type CodexMenuNode,
  type CodexNodeRow,
  type MenuIO,
  type PlannedCommand,
} from "./codex-menu";

const NODE_TOKEN = "ntok_FIXTURE_SECRET_0123456789abcdef";
const AUTH_SECRET = "sk-FIXTURE-AUTH-SECRET-zzzz";
const THREAD = "0199aa11-2222-7333-8444-555566667777";

let root: string;
let home: string;
let nodesDir: string;
let nodes: CodexMenuNode[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "codex-menu-"));
  home = join(root, "home");
  nodesDir = join(root, "work", ".anet", "nodes");
  mkdirSync(home, { recursive: true });
  const mk = (id: string, cfg: Record<string, unknown>) => {
    mkdirSync(join(nodesDir, id), { recursive: true });
    writeFileSync(join(nodesDir, id, "config.json"), JSON.stringify(cfg));
    return { id, alias: id, profile: cfg as Record<string, any> };
  };
  nodes = [
    mk("my-node", { runtime: "codex-app-server", codexCopresence: true, codexThreadId: THREAD, model: "o3", token: NODE_TOKEN }),
    mk("my-sdk", { runtime: "codex-sdk", token: NODE_TOKEN }),
    mk("my-claude", { runtime: "claude-agent-sdk", token: NODE_TOKEN }),
  ];
  mkdirSync(join(nodesDir, "my-node", "codex-home"), { recursive: true });
  writeFileSync(join(nodesDir, "my-node", "codex-home", "auth.json"), JSON.stringify({ tokens: { access_token: AUTH_SECRET } }));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function rows(sessions: string[] = ["my-node", "my-node-appsrv", "my-node-桥"]): CodexNodeRow[] {
  return collectCodexRows(nodes, { nodesDir, home, env: {}, tmuxSessions: () => new Set(sessions), pidAlive: () => false });
}

function scripted(lines: string[]): MenuIO & { out: () => string } {
  let buf = "";
  const q = [...lines];
  return {
    write: (s) => { buf += s; },
    readLine: async (prompt) => { buf += prompt; const l = q.shift(); if (l === undefined) return null; buf += l + "\n"; return l; },
    out: () => buf,
  };
}

function recorder() {
  const ran: PlannedCommand[] = [];
  let outAtRun = "";
  return { ran, outAtRun: () => outAtRun, runner: (io: { out: () => string }) => async (c: PlannedCommand) => { outAtRun = io.out(); ran.push(c); return 0; } };
}

describe("#532 collectCodexRows", () => {
  it("lists only codex nodes, with state / login / thread / model", () => {
    const r = rows();
    expect(r.map((x) => x.alias)).toEqual(["my-node", "my-sdk"]);
    expect(r[0]).toMatchObject({ kind: "co-presence", state: "running", loggedIn: true, loginWhere: "node", threadId: THREAD, model: "o3", modelIsDefault: false });
    expect(r[1]).toMatchObject({ kind: "codex-sdk", state: "stopped", loggedIn: false, loginWhere: "host", threadId: null, modelIsDefault: true });
  });
  it("co-presence with only some sessions up is partial, none is stopped", () => {
    expect(rows(["my-node-appsrv"])[0].state).toBe("partial 1/3");
    expect(rows([])[0].state).toBe("stopped");
    // a similarly named session is not ours
    expect(rows(["my-node-old"])[0].state).toBe("stopped");
  });
});

describe("#532 login column uses the #529 helper", () => {
  it("an auth.json with no tokens is not a login; the host login counts for codex-sdk", () => {
    const authPath = join(nodesDir, "my-node", "codex-home", "auth.json");
    const keep = require("node:fs").readFileSync(authPath, "utf-8");
    try {
      writeFileSync(authPath, "{}");
      expect(rows()[0].loggedIn).toBe(false);
    } finally { writeFileSync(authPath, keep); }
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-host-fixture" }));
    try {
      expect(rows()[1]).toMatchObject({ loggedIn: true, loginWhere: "host", codexHome: null });
    } finally { rmSync(join(home, ".codex"), { recursive: true, force: true }); }
  });
});

describe("#532 table", () => {
  it("renders every column; thread is short; no token or auth content", () => {
    const t = renderCodexTable(rows(), "/w");
    for (const h of ["NODE", "TYPE", "STATE", "LOGIN", "THREAD", "MODEL"]) expect(t).toContain(h);
    expect(t).toMatch(/my-node\s+co-presence\s+running\s+logged in\s+0199aa11\s+o3/);
    expect(t).toMatch(/my-sdk\s+codex-sdk\s+stopped\s+NOT logged in \(host\)\s+-\s+\S+ \(default\)/);
    expect(t).not.toContain(THREAD);
    expect(t).not.toContain("my-claude");
    expect(t).not.toContain(NODE_TOKEN);
    expect(t).not.toContain(AUTH_SECRET);
  });
  it("empty directory says so and how to create one", () => {
    expect(renderCodexTable([], "/w")).toContain("No codex nodes");
  });
  it("cheat sheet covers the nine things a human asks for", () => {
    for (const s of ["start", "stop", "restart", "verify", "codex login", "anet attach", "--model", "fork", "delete"]) expect(CODEX_CHEAT_SHEET).toContain(s);
  });
});

describe("#532 menu: confirm before run", () => {
  it("restart prints the exact command and only runs after y", async () => {
    const io = scripted(["1", "3", "y"]);
    const rec = recorder();
    const code = await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" });
    expect(code).toBe(0);
    expect(rec.ran.map(commandLine)).toEqual(["anet node codex restart my-node"]);
    // printed before it ran
    expect(rec.outAtRun()).toContain("Will run 将执行:\n  anet node codex restart my-node\n");
  });
  it("n aborts with nothing run", async () => {
    const io = scripted(["1", "3", "n"]);
    const rec = recorder();
    expect(await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" })).toBe(0);
    expect(rec.ran).toEqual([]);
    expect(io.out()).toContain("anet node codex restart my-node");
    expect(io.out()).toContain("nothing was run");
  });
  it("an empty answer (just Enter) is N", async () => {
    const io = scripted(["1", "3", ""]);
    const rec = recorder();
    await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" });
    expect(rec.ran).toEqual([]);
  });
  it("end of input at any prompt runs nothing", async () => {
    for (const lines of [[], ["1"], ["1", "3"]]) {
      const io = scripted(lines);
      const rec = recorder();
      expect(await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" })).toBe(0);
      expect(rec.ran).toEqual([]);
    }
  });
  it("a bad number re-asks instead of guessing", async () => {
    const io = scripted(["7", "1", "99", "2", "y"]);
    const rec = recorder();
    await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" });
    expect(rec.ran.map(commandLine)).toEqual(["anet node stop my-node"]);
  });
  it("a failing command's exit code is returned and the command is repeated for copy-paste", async () => {
    const io = scripted(["2", "3", "y"]);
    const code = await codexMenu(rows(), io, async () => 2, { cwd: "/w" });
    expect(code).toBe(2);
    expect(io.out()).toContain("exited 2. Same command, by hand: anet node restart my-sdk --tmux");
  });
});

describe("#532 menu: delete needs the typed name", () => {
  it("y is not enough; the wrong name aborts", async () => {
    for (const typed of ["y", "my-nod", "MY-NODE", ""]) {
      const io = scripted(["1", "9", typed]);
      const rec = recorder();
      await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" });
      expect(rec.ran).toEqual([]);
    }
  });
  it("the exact name runs delete --force", async () => {
    const io = scripted(["1", "9", "my-node"]);
    const rec = recorder();
    await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" });
    expect(rec.ran.map(commandLine)).toEqual(["anet node delete my-node --force"]);
  });
});

describe("#532 actions map to existing commands", () => {
  it("per runtime", () => {
    const [cp, sdk] = rows();
    const stopped = rows([])[0];
    const line = (r: CodexNodeRow, a: Parameters<typeof planAction>[1], i = {}) => commandLine(planAction(r, a, i));
    expect(line(cp, "start")).toBe("anet node codex start my-node");
    expect(line(sdk, "start")).toBe("anet node start my-sdk --tmux");
    expect(line(cp, "verify")).toBe("anet node codex verify my-node");
    expect(line(sdk, "verify")).toBe("anet info my-sdk");
    expect(line(cp, "login")).toBe(`CODEX_HOME=${join(nodesDir, "my-node", "codex-home")} codex login --device-auth`);
    expect(line(sdk, "login")).toBe("codex login --device-auth");
    expect(line(cp, "continue")).toBe("anet attach my-node");
    expect(line(stopped, "continue")).toBe("anet node codex start my-node");
    expect(planAction(stopped, "continue").note).toContain(THREAD);
    expect(line(cp, "model", { model: "o3-pro" })).toBe("anet node edit my-node --model o3-pro");
    expect(line(cp, "copy", { newName: "my-copy", workdir: "/w2/my-copy" })).toBe("anet node codex fork my-node --name my-copy --workdir /w2/my-copy --no-codex-login");
    expect(line(sdk, "copy", { newName: "my-copy" })).toBe("anet node clone my-sdk my-copy");
  });
  it("odd names are quoted in the printed command", () => {
    expect(commandLine({ argv: ["anet", "node", "stop", "my node's"] })).toBe(`anet node stop 'my node'\\''s'`);
  });
  it("model and copy prompts feed the command; empty answers abort", async () => {
    let io = scripted(["1", "7", "o3-pro", "y"]);
    let rec = recorder();
    await codexMenu(rows(), io, rec.runner(io), { cwd: "/w/proj" });
    expect(rec.ran.map(commandLine)).toEqual(["anet node edit my-node --model o3-pro"]);
    expect(io.out()).toContain("takes effect after a restart: anet node codex restart my-node");

    io = scripted(["1", "8", "my-copy", "", "y"]);
    rec = recorder();
    await codexMenu(rows(), io, rec.runner(io), { cwd: "/w/proj" });
    expect(rec.ran.map(commandLine)).toEqual(["anet node codex fork my-node --name my-copy --workdir /w/my-copy --no-codex-login"]);

    for (const lines of [["1", "7", ""], ["1", "7", "two words"], ["1", "8", ""], ["1", "8", "my-node"]]) {
      io = scripted(lines);
      rec = recorder();
      await codexMenu(rows(), io, rec.runner(io), { cwd: "/w/proj" });
      expect(rec.ran).toEqual([]);
    }
  });
});

describe("#528 menu: adopt an existing codex conversation", () => {
  it("a at the node prompt asks for a name, prints the command, runs after y", async () => {
    const io = scripted(["a", "my-agent", "y"]);
    const rec = recorder();
    expect(await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" })).toBe(0);
    expect(rec.ran.map(commandLine)).toEqual(["anet node codex adopt my-agent"]);
    expect(rec.outAtRun()).toContain("Will run 将执行:\n  anet node codex adopt my-agent\n");
  });
  it("a at the action prompt works too (single-node shortcut skips the node prompt)", async () => {
    const io = scripted(["a", "my-agent", "y"]);
    const rec = recorder();
    await codexMenu(rows().slice(0, 1), io, rec.runner(io), { cwd: "/w" });
    expect(rec.ran.map(commandLine)).toEqual(["anet node codex adopt my-agent"]);
  });
  it("n, an empty name or end of input runs nothing", async () => {
    for (const lines of [["a", "my-agent", "n"], ["a", ""], ["a", "two words"], ["a"]]) {
      const io = scripted(lines);
      const rec = recorder();
      expect(await codexMenu(rows(), io, rec.runner(io), { cwd: "/w" })).toBe(0);
      expect(rec.ran).toEqual([]);
    }
  });
  it("the cheat sheet has the adopt line", () => {
    expect(CODEX_CHEAT_SHEET).toContain("anet node codex adopt my-agent");
  });
});

describe("#532 nothing secret reaches the screen", () => {
  it("across every action and both nodes", async () => {
    for (let n = 1; n <= 2; n++) for (let a = 1; a <= 9; a++) {
      const io = scripted([String(n), String(a), "x", "x", "y"]);
      await codexMenu(rows(), io, async () => 0, { cwd: "/w" });
      expect(io.out()).not.toContain(NODE_TOKEN);
      expect(io.out()).not.toContain(AUTH_SECRET);
    }
  });
});
