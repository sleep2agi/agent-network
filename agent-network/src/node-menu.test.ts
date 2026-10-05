// #561 — bare `anet node` menu: every runtime, table, actions, confirm gate, codex hand-off, no tokens.
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine, type CodexMenuNode, type MenuIO, type PlannedCommand } from "./codex-menu";
import {
  NODE_CHEAT_SHEET,
  collectNodeRows,
  nodeActions,
  nodeMenu,
  planNodeAction,
  renderNodeTable,
  type NodeRow,
} from "./node-menu";

const NODE_TOKEN = "ntok_FIXTURE_SECRET_0123456789abcdef";
const AUTH_SECRET = "sk-FIXTURE-AUTH-SECRET-zzzz";

let root: string;
let home: string;
let nodesDir: string;
let nodes: CodexMenuNode[];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "node-menu-"));
  home = join(root, "home");
  nodesDir = join(root, "work", ".anet", "nodes");
  mkdirSync(home, { recursive: true });
  const mk = (id: string, cfg: Record<string, unknown>) => {
    mkdirSync(join(nodesDir, id), { recursive: true });
    writeFileSync(join(nodesDir, id, "config.json"), JSON.stringify({ ...cfg, token: NODE_TOKEN }));
    return { id, alias: id, profile: { ...cfg, token: NODE_TOKEN } as Record<string, any> };
  };
  nodes = [
    mk("a-sdk", { runtime: "claude-agent-sdk", model: "claude-sonnet-4-5" }),
    mk("b-cli", { runtime: "claude-code-cli" }),
    mk("c-codex", { runtime: "codex-app-server", codexCopresence: true, model: "o3" }),
    mk("d-grok", { runtime: "grok-build-cli", grokCopresence: true, model: "grok-4" }),
    mk("e-acp", { runtime: "grok-build-acp" }),
    mk("f-oc", { runtime: "opencode-cli", opencodeMode: "copresence" }),
    mk("g-ochl", { runtime: "opencode-cli", opencodeMode: "headless" }),
    mk("h-csdk", { runtime: "codex-sdk" }),
  ];
  writeFileSync(join(nodesDir, "a-sdk", ".pid"), "4242\n");
  mkdirSync(join(nodesDir, "c-codex", "codex-home"), { recursive: true });
  writeFileSync(join(nodesDir, "c-codex", "codex-home", "auth.json"), JSON.stringify({ tokens: { access_token: AUTH_SECRET } }));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function rows(sessions: string[] = ["b-cli", "d-grok-桥"]): NodeRow[] {
  return collectNodeRows(nodes, { nodesDir, home, env: {}, tmuxSessions: () => new Set(sessions), pidAlive: (pid) => pid === 4242 });
}
const byAlias = (alias: string) => rows().find((r) => r.alias === alias)!;

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
  return { ran, run: async (c: PlannedCommand) => { ran.push(c); return 0; } };
}
const idx = (alias: string) => String(rows().findIndex((r) => r.alias === alias) + 1);

describe("collectNodeRows", () => {
  it("lists every runtime, sorted, with state from pidfile / tmux", () => {
    const r = rows();
    expect(r.map((x) => `${x.alias}:${x.runtime}:${x.state}`)).toEqual([
      "a-sdk:claude-agent-sdk:running",   // pidfile alive
      "b-cli:claude-code-cli:running",    // tmux session = alias
      "c-codex:codex-app-server:stopped",
      "d-grok:grok-build-cli:running",    // co-presence bridge session
      "e-acp:grok-build-acp:stopped",
      "f-oc:opencode-cli:stopped",
      "g-ochl:opencode-cli:stopped",
      "h-csdk:codex-sdk:stopped",
    ]);
  });
  it("only co-presence nodes count a -桥 session as running", () => {
    expect(collectNodeRows(nodes, { nodesDir, home, env: {}, tmuxSessions: () => new Set(["e-acp-桥"]), pidAlive: () => false })
      .find((x) => x.alias === "e-acp")!.state).toBe("stopped");
  });
  it("codex nodes carry the #532 codex row (login column), others do not", () => {
    expect(byAlias("c-codex").codex?.loggedIn).toBe(true);
    expect(byAlias("h-csdk").codex?.kind).toBe("codex-sdk");
    expect(byAlias("a-sdk").codex).toBeNull();
  });
  it("TUI / co-presence flags", () => {
    expect(byAlias("b-cli").hasTui).toBe(true);
    expect(byAlias("d-grok").copresence).toBe(true);
    expect(byAlias("f-oc").copresence).toBe(true);
    expect(byAlias("g-ochl").copresence).toBe(false);
    expect(byAlias("a-sdk").hasTui).toBe(false);
  });
  it("no nodes: no tmux probe at all", () => {
    let probed = false;
    expect(collectNodeRows([], { nodesDir, home, tmuxSessions: () => { probed = true; return new Set(); } })).toEqual([]);
    expect(probed).toBe(false);
  });
});

describe("renderNodeTable", () => {
  it("shows alias, runtime, state, model, login — never a token", () => {
    const t = renderNodeTable(rows(), "/w");
    expect(t).toMatch(/a-sdk +claude-agent-sdk +running +claude-sonnet-4-5 +-/);
    expect(t).toMatch(/b-cli +claude-code-cli +running +\(default\) +-/);
    expect(t).toMatch(/c-codex +codex-app-server +stopped +o3 +logged in/);
    expect(t).toMatch(/d-grok +grok-build-cli \(tui\) +running +grok-4/);
    expect(t).toMatch(/h-csdk +codex-sdk +stopped +\S+ \(default\) +NOT logged in \(host\)/);
    expect(t).not.toContain(NODE_TOKEN);
    expect(t).not.toContain(AUTH_SECRET);
  });
  it("empty: says how to create one", () => {
    expect(renderNodeTable([], "/w")).toContain("anet node create my-node");
  });
  it("cheat sheet points at the codex cheat sheet", () => {
    expect(NODE_CHEAT_SHEET).toContain("anet node codex");
    expect(NODE_CHEAT_SHEET).toContain("codex-cheatsheet");
  });
});

describe("planNodeAction", () => {
  const line = (alias: string, a: Parameters<typeof planNodeAction>[1], m?: string) => commandLine(planNodeAction(byAlias(alias), a, { model: m }));
  it("headless runtimes start/restart in tmux", () => {
    expect(line("a-sdk", "start")).toBe("anet node start a-sdk --tmux");
    expect(line("e-acp", "restart")).toBe("anet node restart e-acp --tmux");
    expect(line("g-ochl", "start")).toBe("anet node start g-ochl --tmux");
  });
  it("co-presence runtimes start their shared TUI", () => {
    expect(line("d-grok", "start")).toBe("anet node start d-grok --copresence");
    expect(line("f-oc", "restart")).toBe("anet node restart f-oc --copresence");
  });
  it("stop / attach / log / model / delete", () => {
    expect(line("b-cli", "stop")).toBe("anet node stop b-cli");
    expect(line("b-cli", "attach")).toBe("anet attach b-cli");
    expect(line("b-cli", "log")).toBe("anet logs b-cli");
    expect(line("a-sdk", "model", "claude-opus-4-1")).toBe("anet node edit a-sdk --model claude-opus-4-1");
    expect(line("a-sdk", "delete")).toBe("anet node delete a-sdk --force");
  });
  it("attach on a headless runtime says it is a console, not a TUI", () => {
    expect(nodeActions(byAlias("a-sdk")).find((x) => x.key === "attach")!.label).toContain("no chat TUI");
    expect(nodeActions(byAlias("b-cli")).find((x) => x.key === "attach")!.label).toContain("enter the TUI");
  });
});

describe("nodeMenu", () => {
  it("n: prints the exact command, runs nothing", async () => {
    const io = scripted([idx("a-sdk"), "3", "n"]);
    const { ran, run } = recorder();
    expect(await nodeMenu(rows(), io, run, { cwd: "/w" })).toBe(0);
    expect(io.out()).toContain("Will run 将执行:\n  anet node restart a-sdk --tmux");
    expect(io.out()).toContain("nothing was run");
    expect(ran).toEqual([]);
  });
  it("y: runs exactly the printed command", async () => {
    const io = scripted([idx("d-grok"), "1", "y"]);
    const { ran, run } = recorder();
    await nodeMenu(rows(), io, run, { cwd: "/w" });
    expect(ran.map(commandLine)).toEqual(["anet node start d-grok --copresence"]);
  });
  it("delete: y alone / wrong name abort; the typed name runs", async () => {
    for (const ans of ["y", "e-ac"]) {
      const { ran, run } = recorder();
      await nodeMenu(rows(), scripted([idx("e-acp"), "7", ans]), run, { cwd: "/w" });
      expect(ran).toEqual([]);
    }
    const { ran, run } = recorder();
    await nodeMenu(rows(), scripted([idx("e-acp"), "7", "e-acp"]), run, { cwd: "/w" });
    expect(ran.map(commandLine)).toEqual(["anet node delete e-acp --force"]);
  });
  it("model: asks for an id, rejects junk", async () => {
    const r1 = recorder();
    await nodeMenu(rows(), scripted([idx("b-cli"), "6", "bad id"]), r1.run, { cwd: "/w" });
    expect(r1.ran).toEqual([]);
    const r2 = recorder();
    await nodeMenu(rows(), scripted([idx("b-cli"), "6", "sonnet", "y"]), r2.run, { cwd: "/w" });
    expect(r2.ran.map(commandLine)).toEqual(["anet node edit b-cli --model sonnet"]);
  });
  it("codex nodes go to the #532 codex actions (verify, log in, continue, copy …)", async () => {
    const io = scripted([idx("c-codex"), "4", "y"]);
    const { ran, run } = recorder();
    await nodeMenu(rows(), io, run, { cwd: "/w" });
    expect(io.out()).toContain("log in 登录 codex");
    expect(ran.map(commandLine)).toEqual(["anet node codex verify c-codex"]);
  });
  it("q / end of input: nothing runs", async () => {
    for (const lines of [["q"], []]) {
      const { ran, run } = recorder();
      expect(await nodeMenu(rows(), scripted(lines), run, { cwd: "/w" })).toBe(0);
      expect(ran).toEqual([]);
    }
  });
  it("no output path shows a token", async () => {
    for (let n = 1; n <= 8; n++) for (let a = 1; a <= 10; a++) {
      const io = scripted([String(n), String(a), "x-model", "x-name", "", "n"]);
      await nodeMenu(rows(), io, async () => 0, { cwd: "/w" });
      expect(io.out()).not.toContain(NODE_TOKEN);
      expect(io.out()).not.toContain(AUTH_SECRET);
    }
  });
});
