// #561 — `anet node` with no arguments: a menu for every runtime in this directory.
//
// #532 gave codex nodes a menu (`anet node codex`, src/codex-menu.ts). This is the same
// shape for ALL runtimes (claude-agent-sdk, claude-code-cli, codex-*, grok-*, opencode-cli):
//   - TTY: table (alias, runtime, state, model, + login for codex), pick a node, pick an
//     action (start / stop / restart / attach / log / change model / delete), print the
//     EXACT equivalent `anet …` command, ask y/N (delete: type the name), then run it.
//     A codex node is handed to the #532 codex actions (log in, continue, copy …) unchanged.
//   - not a TTY (piped / an agent): the same table plus a cheat sheet, exit 0.
//
// 🔴 Nothing is implemented here. Every action is the printed `anet …` command, run through
//    the same CLI entrypoint by codex-menu.ts's runner, and goes through the same confirm
//    gate (confirmAndRun). Lifecycle logic stays in cli.ts.
// 🔴 Tokens are never read into output: only alias/runtime/model/state fields are shown.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askModel,
  codexNodeActions,
  collectCodexRows,
  confirmAndRun,
  displayQuote,
  pick,
  readlineIO,
  realPidAlive,
  realRunner,
  realTmuxSessions,
  type CodexMenuNode,
  type CodexNodeRow,
  type CollectEnv,
  type MenuIO,
  type PlannedCommand,
  type Runner,
} from "./codex-menu";
import { displayWidth, padDisplayEnd } from "./display-width";
import { normalizeRuntime, type RuntimeName } from "./normalize-runtime";

export interface NodeRow {
  id: string;
  alias: string;
  runtime: RuntimeName;
  /** "running" | "stopped" (codex co-presence may say "partial 1/3"). */
  state: string;
  running: boolean;
  model: string;
  modelIsDefault: boolean;
  /** Shared human + agent TUI (grok-build-cli / opencode-cli co-presence, codex-app-server). */
  copresence: boolean;
  /** The runtime has a TUI to enter (claude-code-cli, or any co-presence node). */
  hasTui: boolean;
  /** Set for codex-sdk / codex-app-server: these go to the #532 codex actions. */
  codex: CodexNodeRow | null;
}

function grokCopresence(p: Record<string, any>, runtime: RuntimeName): boolean {
  return runtime === "grok-build-cli" && p.grokCopresence !== false;
}
function opencodeCopresence(p: Record<string, any>, runtime: RuntimeName): boolean {
  return runtime === "opencode-cli" && p.opencodeMode === "copresence";
}

export function collectNodeRows(nodes: CodexMenuNode[], env: CollectEnv): NodeRow[] {
  if (nodes.length === 0) return [];
  const sessions = (env.tmuxSessions ?? realTmuxSessions)();
  const pidAlive = env.pidAlive ?? realPidAlive;
  const codexEnv: CollectEnv = { ...env, tmuxSessions: () => sessions, pidAlive };
  const codexById = new Map(collectCodexRows(nodes, codexEnv).map((r) => [r.id, r]));
  const rows: NodeRow[] = [];
  for (const n of nodes) {
    const p = n.profile ?? {};
    const runtime = normalizeRuntime(p as any);
    const codex = codexById.get(n.id) ?? null;
    if (codex) {
      rows.push({
        id: n.id, alias: n.alias, runtime, state: codex.state, running: codex.running,
        model: codex.model, modelIsDefault: codex.modelIsDefault,
        copresence: codex.kind === "co-presence", hasTui: codex.kind === "co-presence", codex,
      });
      continue;
    }
    const copresence = grokCopresence(p, runtime) || opencodeCopresence(p, runtime);
    let alive = false;
    try {
      const pid = parseInt(readFileSync(join(env.nodesDir, n.id, ".pid"), "utf-8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) alive = pidAlive(pid);
    } catch { /* no pidfile */ }
    // `--tmux` starts use the alias; co-presence adds `<alias>-桥` (the bridge).
    const running = alive || sessions.has(n.alias) || (copresence && sessions.has(`${n.alias}-桥`));
    const modelRaw = typeof p.model === "string" ? p.model.trim() : "";
    rows.push({
      id: n.id, alias: n.alias, runtime,
      state: running ? "running" : "stopped", running,
      model: modelRaw || "-", modelIsDefault: !modelRaw,
      copresence, hasTui: copresence || runtime === "claude-code-cli", codex: null,
    });
  }
  return rows.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

const HEADERS = ["#", "NODE", "RUNTIME", "STATE", "MODEL", "LOGIN"];

export function renderNodeTable(rows: NodeRow[], cwd: string): string {
  if (rows.length === 0) {
    return [
      `No nodes in ${cwd}/.anet/nodes 当前目录没有节点`,
      `  create one 新建: anet node create my-node`,
      "",
    ].join("\n");
  }
  const cells = rows.map((r, i) => [
    String(i + 1),
    r.alias,
    r.runtime + (r.copresence && !r.codex ? " (tui)" : ""),
    r.state,
    r.modelIsDefault ? (r.codex ? `${r.model} (default)` : "(default)") : r.model,
    r.codex ? `${r.codex.loggedIn ? "logged in" : "NOT logged in"}${r.codex.loginWhere === "host" ? " (host)" : ""}` : "-",
  ]);
  const widths = HEADERS.map((h, c) => Math.max(h.length, ...cells.map((row) => displayWidth(row[c]))));
  const line = (row: string[]) => "  " + row.map((v, c) => (c === row.length - 1 ? v : padDisplayEnd(v, widths[c]))).join("  ");
  return [`Nodes in ${cwd} (${rows.length})`, "", line(HEADERS), ...cells.map(line), ""].join("\n");
}

export const NODE_CHEAT_SHEET = [
  "I want to … 我想……          type 就敲……",
  "  start 启动                anet node start my-node --tmux       (co-presence TUI: anet node start my-node --copresence)",
  "  stop 停止                 anet node stop my-node",
  "  restart 重启              anet node restart my-node --tmux",
  "  enter the TUI 进 TUI      anet attach my-node                  (detach: Ctrl-B D, the node keeps running)",
  "  recent log 看日志         anet logs my-node                    (follow: anet logs my-node --follow)",
  "  switch model 换模型       anet node edit my-node --model <id>  then restart",
  "  delete 删除               anet node delete my-node --force",
  "  codex nodes codex 节点    anet node codex                      (login / continue / copy — https://anet.sh/guide/codex-cheatsheet)",
  "Interactive menu 交互菜单: run `anet node` in a terminal.",
  "",
].join("\n");

// ── actions (non-codex nodes) ─────────────────────────────────────────────

export type NodeAction = "start" | "stop" | "restart" | "attach" | "log" | "model" | "delete";

export function nodeActions(row: NodeRow): { key: NodeAction; label: string }[] {
  return [
    { key: "start", label: "start 启动" },
    { key: "stop", label: "stop 停止" },
    { key: "restart", label: "restart 重启" },
    { key: "attach", label: row.hasTui ? "attach — enter the TUI 进入 TUI" : "attach — the node's console in tmux (this runtime has no chat TUI) 看控制台" },
    { key: "log", label: "show recent log 看最近日志" },
    { key: "model", label: "change model 换模型" },
    { key: "delete", label: "delete 删除" },
  ];
}

/** The start flags a node needs: co-presence nodes start their shared TUI, the rest in tmux. */
function startFlags(row: NodeRow): string[] {
  return row.copresence ? ["--copresence"] : ["--tmux"];
}

export function planNodeAction(row: NodeRow, action: NodeAction, input: { model?: string } = {}): PlannedCommand {
  const a = row.alias;
  switch (action) {
    case "start":
      return {
        argv: ["anet", "node", "start", a, ...startFlags(row)],
        note: row.running ? "it is already running — pick restart instead"
          : row.copresence ? "starts the shared TUI in tmux; enter it with attach" : "opens the node in tmux; detach with Ctrl-B D",
      };
    case "stop":
      return { argv: ["anet", "node", "stop", a] };
    case "restart":
      return { argv: ["anet", "node", "restart", a, ...startFlags(row)] };
    case "attach":
      return {
        argv: ["anet", "attach", a],
        note: row.running ? "detach again with Ctrl-B D (the node keeps running)" : "the node is not running — start it first",
      };
    case "log":
      return { argv: ["anet", "logs", a] };
    case "model":
      return { argv: ["anet", "node", "edit", a, "--model", String(input.model ?? "")], after: `takes effect after a restart: anet node restart ${displayQuote(a)} ${startFlags(row).join(" ")}` };
    case "delete":
      return { argv: ["anet", "node", "delete", a, "--force"], note: "stops the node, removes .anet/nodes/" + row.id + " and its Hub row — cannot be undone" };
  }
}

// ── the menu (pure: IO and the runner are injected) ───────────────────────

/** Returns the process exit code. Runs at most one command. */
export async function nodeMenu(rows: NodeRow[], io: MenuIO, run: Runner, ctx: { cwd: string }): Promise<number> {
  io.write(renderNodeTable(rows, ctx.cwd) + "\n");
  if (rows.length === 0) { io.write(NODE_CHEAT_SHEET); return 0; }

  const ni = rows.length === 1
    ? (io.write(`Only one node: ${rows[0].alias}\n`), 0)
    : await pick(io, `Pick a node 选节点 [1-${rows.length}, q=quit]: `, rows.length, false);
  if (ni === null || ni === "adopt") { io.write("Bye — nothing was run.\n"); return 0; }
  const row = rows[ni];
  // Codex nodes keep their own actions (log in / continue / copy / adopt …): #532, unchanged.
  if (row.codex) return codexNodeActions(row.codex, io, run, ctx);

  const actions = nodeActions(row);
  io.write(`\n${row.alias} (${row.runtime}, ${row.state}) — what do you want to do? 要做什么?\n`);
  actions.forEach((m, i) => io.write(`  ${i + 1}) ${m.label}\n`));
  const ai = await pick(io, `Action 操作 [1-${actions.length}, q=quit]: `, actions.length, false);
  if (ai === null || ai === "adopt") { io.write("Bye — nothing was run.\n"); return 0; }
  const action = actions[ai].key;

  const input: { model?: string } = {};
  if (action === "model") {
    const m = await askModel(io, row.modelIsDefault ? "the runtime default" : row.model);
    if (m === null) return 0;
    input.model = m;
  }
  return confirmAndRun(io, run, planNodeAction(row, action, input), row, action === "delete");
}

// ── real wiring ───────────────────────────────────────────────────────────

/** Entry from cli.ts (bare `anet node`). Returns the exit code. */
export async function runNodeMenu(
  nodes: CodexMenuNode[],
  opts: { nodesDir: string; home: string; cwd?: string; usageLine?: string },
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const rows = collectNodeRows(nodes, { nodesDir: opts.nodesDir, home: opts.home });
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    process.stdout.write(renderNodeTable(rows, cwd) + "\n" + NODE_CHEAT_SHEET + (opts.usageLine ? opts.usageLine + "\n" : ""));
    return 0;
  }
  const io = readlineIO();
  try {
    return await nodeMenu(rows, io, realRunner(() => io.close()), { cwd });
  } finally {
    io.close();
  }
}
