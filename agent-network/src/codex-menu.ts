// #532 — `anet node codex` with no arguments: a menu for humans.
//
// The owner (2026-10-04): "Codex 的那个 anet cli 我不太会去用它去操作 Codex 这些东西，
// 我现在都是纯靠 AI 去管理那个节点". The lifecycle verbs exist
// (`anet node codex start|restart|verify|fork`, `anet node stop|delete|edit`),
// but a human has to know which verb, which runtime, which flags.
//
// What this module does:
//   - TTY: list the codex nodes in this directory, pick one, pick an action,
//     print the EXACT equivalent command, ask y/N (delete: type the name),
//     then run that command.
//   - not a TTY (piped / an agent): print the same table plus a cheat sheet,
//     exit 0. Agents and humans see the same facts.
//
// 🔴 It never implements an action itself. Every action is the printed
//    `anet …` command, run as a child of this same CLI entrypoint
//    (process.execPath + execArgv + argv[1]) — the same way the lifecycle
//    controller already re-invokes `anet node start`. What the human reads is
//    what runs; stop/start/delete logic stays in one place.
// 🔴 Tokens are never read into output: the node token is not touched, and
//    login state is "auth.json exists and is non-empty", nothing more.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_CODEX_MODEL } from "./codex-model-default";
import { codexLoginFactsOfHome, effectiveCodexHome } from "./codex-node-login";
import { displayWidth, padDisplayEnd } from "./display-width";
import { normalizeRuntime } from "./normalize-runtime";
import { execTmux } from "./tmux";

export type CodexKind = "co-presence" | "codex-sdk";

export interface CodexMenuNode {
  id: string;
  alias: string;
  profile: Record<string, any> | null;
}

export interface CodexNodeRow {
  id: string;
  alias: string;
  kind: CodexKind;
  /** "running" | "stopped" | "partial 1/3" … */
  state: string;
  running: boolean;
  loggedIn: boolean;
  /** Where the login lives: the node's own CODEX_HOME, or the host's ~/.codex. */
  loginWhere: "node" | "host";
  /** Absolute CODEX_HOME for `codex login`; null = codex's own default (~/.codex). */
  codexHome: string | null;
  threadId: string | null;
  model: string;
  modelIsDefault: boolean;
}

export interface CollectEnv {
  nodesDir: string;
  /** $HOME — only used to locate the host's ~/.codex/auth.json. */
  home: string;
  /** The environment a start would inherit (CODEX_HOME); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Exact tmux session names on the server anet uses (empty when none). */
  tmuxSessions?: () => Set<string>;
  pidAlive?: (pid: number) => boolean;
}

function realTmuxSessions(): Set<string> {
  try {
    // One name per line, no separator: tmux outside a UTF-8 locale rewrites a tab in -F to "_".
    const out = execTmux(["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set();
  }
}

function realPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}


/** Only codex nodes: co-presence (codex-app-server) and codex-sdk. */
export function collectCodexRows(nodes: CodexMenuNode[], env: CollectEnv): CodexNodeRow[] {
  const sessions = (env.tmuxSessions ?? realTmuxSessions)();
  const pidAlive = env.pidAlive ?? realPidAlive;
  const rows: CodexNodeRow[] = [];
  for (const n of nodes) {
    const p = n.profile ?? {};
    const runtime = normalizeRuntime(p as any);
    if (runtime !== "codex-app-server" && runtime !== "codex-sdk") continue;
    const kind: CodexKind = runtime === "codex-app-server" ? "co-presence" : "codex-sdk";
    const nodeDir = join(env.nodesDir, n.id);

    let state: string;
    let running: boolean;
    if (kind === "co-presence") {
      // The three sessions the launcher creates (cli.ts copresenceTmuxSessions).
      const names = [`${n.alias}-appsrv`, `${n.alias}-桥`, n.alias];
      const up = names.filter((s) => sessions.has(s)).length;
      running = up > 0;
      state = up === 3 ? "running" : up === 0 ? "stopped" : `partial ${up}/3`;
    } else {
      let alive = false;
      try {
        const pid = parseInt(readFileSync(join(nodeDir, ".pid"), "utf-8").trim(), 10);
        if (Number.isFinite(pid) && pid > 0) alive = pidAlive(pid);
      } catch { /* no pidfile */ }
      running = alive || sessions.has(n.alias);
      state = running ? "running" : "stopped";
    }

    // #529 helper: the CODEX_HOME a start would use, and what its auth.json says (never a token).
    const eff = effectiveCodexHome(nodeDir, p, env.env ?? process.env, env.home);
    const ownHome = eff.source === "config.codexHome" || eff.source === "node-codex-home" || eff.source === "config.env";
    const loginWhere: "node" | "host" = ownHome ? "node" : "host";
    const home = ownHome ? eff.codexHome : null;

    const threadRaw = kind === "co-presence" ? p.codexThreadId : p.session;
    const threadId = typeof threadRaw === "string" && threadRaw.trim() ? threadRaw.trim() : null;
    const modelRaw = typeof p.model === "string" ? p.model.trim() : "";

    rows.push({
      id: n.id,
      alias: n.alias,
      kind,
      state,
      running,
      loggedIn: codexLoginFactsOfHome(eff.codexHome).loggedIn,
      loginWhere,
      codexHome: home,
      threadId,
      model: modelRaw || DEFAULT_CODEX_MODEL,
      modelIsDefault: !modelRaw,
    });
  }
  return rows.sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
}

const HEADERS = ["#", "NODE", "TYPE", "STATE", "LOGIN", "THREAD", "MODEL"];

export function renderCodexTable(rows: CodexNodeRow[], cwd: string): string {
  if (rows.length === 0) {
    return [
      `No codex nodes in ${cwd}/.anet/nodes 当前目录没有 codex 节点`,
      `  create one 新建: anet node create my-node --runtime codex-app-server`,
      "",
    ].join("\n");
  }
  const cells = rows.map((r, i) => [
    String(i + 1),
    r.alias,
    r.kind,
    r.state,
    `${r.loggedIn ? "logged in" : "NOT logged in"}${r.loginWhere === "host" ? " (host)" : ""}`,
    r.threadId ? r.threadId.slice(0, 8) : "-",
    `${r.model}${r.modelIsDefault ? " (default)" : ""}`,
  ]);
  const widths = HEADERS.map((h, c) => Math.max(h.length, ...cells.map((row) => displayWidth(row[c]))));
  const line = (row: string[]) => "  " + row.map((v, c) => (c === row.length - 1 ? v : padDisplayEnd(v, widths[c]))).join("  ");
  return [
    `Codex nodes in ${cwd} (${rows.length})`,
    "",
    line(HEADERS),
    ...cells.map(line),
    "",
  ].join("\n");
}

export const CODEX_CHEAT_SHEET = [
  "I want to … 我想……          type 就敲……",
  "  start 启动                anet node codex start my-node        (codex-sdk: anet node start my-node --tmux)",
  "  stop 停止                 anet node stop my-node",
  "  restart 重启              anet node codex restart my-node      (codex-sdk: anet node restart my-node --tmux)",
  "  check health 自检         anet node codex verify my-node       (codex-sdk: anet info my-node)",
  "  log in 登录               CODEX_HOME=<node>/codex-home codex login --device-auth   (the menu prints the exact path)",
  "  continue 接着聊上一次     anet attach my-node                  (stopped: start it — the recorded thread resumes)",
  "  resume an older one 选历史 anet resume my-node --pick          (lists the node's threads; --thread <id> picks one directly)",
  "  switch model 换模型       anet node edit my-node --model <id>  then restart",
  "  copy 复制节点             anet node codex fork my-node --name my-copy --workdir ../my-copy --no-codex-login",
  "                            (codex-sdk: anet node clone my-node my-copy)",
  "  adopt 收编已有 codex 对话  anet node codex adopt my-agent       (lists ~/.codex conversations; --thread <id> skips the list)",
  "  delete 删除               anet node delete my-node --force",
  "  who is logged in 登录状态  anet node codex login-status",
  "Interactive menu 交互菜单: run `anet node codex` in a terminal.",
  "Full reference 完整说明: anet node codex --help · https://anet.sh/guide/codex-cheatsheet",
  "",
].join("\n");

// ── actions ──────────────────────────────────────────────────────────────

export type MenuAction = "start" | "stop" | "restart" | "verify" | "login" | "continue" | "pick" | "model" | "copy" | "delete";

export const MENU_ACTIONS: { key: MenuAction; label: string }[] = [
  { key: "start", label: "start 启动" },
  { key: "stop", label: "stop 停止" },
  { key: "restart", label: "restart 重启" },
  { key: "verify", label: "verify 自检" },
  { key: "login", label: "log in 登录 codex" },
  { key: "continue", label: "continue the last conversation 接着聊上一次" },
  { key: "pick", label: "resume an earlier conversation (pick one) 选一段历史对话恢复" },
  { key: "model", label: "change model 换模型" },
  { key: "copy", label: "copy (fork) to a new node 复制节点" },
  { key: "delete", label: "delete 删除" },
];

export interface PlannedCommand {
  /** argv[0] is "anet" (re-invoke this CLI) or "codex". */
  argv: string[];
  /** Extra env for the child (only CODEX_HOME for login). */
  env?: Record<string, string>;
  /** Shown before the confirm prompt, after the command. */
  note?: string;
  /** Shown after the command succeeded. */
  after?: string;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function displayQuote(v: string): string {
  return SAFE_WORD.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(cmd: PlannedCommand): string {
  const envPart = Object.entries(cmd.env ?? {}).map(([k, v]) => `${k}=${displayQuote(v)} `).join("");
  return envPart + cmd.argv.map(displayQuote).join(" ");
}

export interface ActionInput { model?: string; newName?: string; workdir?: string }

/** #528 — not about an existing node: turn a codex conversation started outside anet into a new one. */
export const ADOPT_KEY = "a";
export function planAdopt(newName: string): PlannedCommand {
  return {
    argv: ["anet", "node", "codex", "adopt", newName],
    note: "lists the conversations in ~/.codex and asks which one; ~/.codex is only read and its login is not copied",
  };
}

export function planAction(row: CodexNodeRow, action: MenuAction, input: ActionInput = {}): PlannedCommand {
  const a = row.alias;
  const cp = row.kind === "co-presence";
  switch (action) {
    case "start":
      return cp
        ? { argv: ["anet", "node", "codex", "start", a], note: row.state.startsWith("partial") ? "part of it is still running — start refuses that; pick restart instead" : undefined }
        : { argv: ["anet", "node", "start", a, "--tmux"], note: "opens the node in tmux; detach with Ctrl-B D" };
    case "stop":
      return { argv: ["anet", "node", "stop", a] };
    case "restart":
      return cp ? { argv: ["anet", "node", "codex", "restart", a] } : { argv: ["anet", "node", "restart", a, "--tmux"] };
    case "verify":
      return cp ? { argv: ["anet", "node", "codex", "verify", a] } : { argv: ["anet", "info", a] };
    case "login":
      return row.codexHome
        ? { argv: ["codex", "login", "--device-auth"], env: { CODEX_HOME: row.codexHome }, after: `restart to use the new login: anet node ${cp ? "codex restart" : "restart"} ${displayQuote(a)}` }
        : { argv: ["codex", "login", "--device-auth"], note: "this node uses the host login (~/.codex), shared with other codex-sdk nodes on this machine" };
    case "continue":
      if (row.running) return { argv: ["anet", "attach", a], note: "detach again with Ctrl-B D (the node keeps running)" };
      return cp
        ? { argv: ["anet", "node", "codex", "start", a], note: row.threadId ? `resumes thread ${row.threadId}` : "no thread recorded yet — a fresh conversation starts" }
        : { argv: ["anet", "node", "start", a, "--tmux"], note: row.threadId ? `resumes session ${row.threadId}` : "no session recorded yet — a fresh conversation starts" };
    case "pick":
      // #536 — the picker lists this node's threads (CODEX_HOME/sessions) and asks; it refuses while the node runs.
      return {
        argv: ["anet", "resume", a, "--pick"],
        note: row.running ? "the node is running — stop it first (anet node stop); the picker only lists then" : "lists this node's codex conversations and asks which one; nothing starts until you choose",
      };
    case "model":
      return { argv: ["anet", "node", "edit", a, "--model", String(input.model ?? "")], after: `takes effect after a restart: anet node ${cp ? "codex restart" : "restart"} ${displayQuote(a)}` };
    case "copy":
      return cp
        ? {
          argv: ["anet", "node", "codex", "fork", a, "--name", String(input.newName ?? ""), "--workdir", String(input.workdir ?? ""), "--no-codex-login"],
          note: "the copy gets its own login (one codex login cannot serve two nodes)",
          after: `next: log the copy in, then start it from its workdir:\n  cd ${displayQuote(String(input.workdir ?? ""))} && anet node codex`,
        }
        : { argv: ["anet", "node", "clone", a, String(input.newName ?? "")] };
    case "delete":
      return { argv: ["anet", "node", "delete", a, "--force"], note: "stops the node, removes .anet/nodes/" + row.id + " and its Hub row — cannot be undone" };
  }
}

// ── the menu (pure: IO and the runner are injected) ───────────────────────

export interface MenuIO {
  write(s: string): void;
  /** Resolves to the next line, or null at end of input. */
  readLine(prompt: string): Promise<string | null>;
}

export type Runner = (cmd: PlannedCommand) => Promise<number>;

async function pick(io: MenuIO, prompt: string, max: number): Promise<number | "adopt" | null> {
  for (;;) {
    const ans = await io.readLine(prompt);
    if (ans === null) return null;
    const t = ans.trim().toLowerCase();
    if (t === "q" || t === "quit" || t === "exit") return null;
    if (t === ADOPT_KEY) return "adopt";
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n - 1;
    io.write(`  please type a number 1-${max}, ${ADOPT_KEY} to adopt a codex conversation, or q to quit\n`);
  }
}

/** Returns the process exit code. Runs at most one command. */
export async function codexMenu(rows: CodexNodeRow[], io: MenuIO, run: Runner, ctx: { cwd: string }): Promise<number> {
  io.write(renderCodexTable(rows, ctx.cwd) + "\n");
  if (rows.length === 0) { io.write(CODEX_CHEAT_SHEET); return 0; }

  const ni = rows.length === 1
    ? (io.write(`Only one codex node: ${rows[0].alias}\n`), 0)
    : await pick(io, `Pick a node 选节点 [1-${rows.length}, ${ADOPT_KEY}=adopt a codex conversation 收编已有对话, q=quit]: `, rows.length);
  if (ni === null) { io.write("Bye — nothing was run.\n"); return 0; }
  if (ni === "adopt") return adoptFromMenu(io, run);
  const row = rows[ni];

  io.write(`\n${row.alias} (${row.kind}, ${row.state}) — what do you want to do? 要做什么?\n`);
  MENU_ACTIONS.forEach((m, i) => io.write(`  ${i + 1}) ${m.label}\n`));
  io.write(`  ${ADOPT_KEY}) adopt a codex conversation as a new node 收编已有 codex 对话\n`);
  const ai = await pick(io, `Action 操作 [1-${MENU_ACTIONS.length}, ${ADOPT_KEY}, q=quit]: `, MENU_ACTIONS.length);
  if (ai === null) { io.write("Bye — nothing was run.\n"); return 0; }
  if (ai === "adopt") return adoptFromMenu(io, run);
  const action = MENU_ACTIONS[ai].key;

  const input: ActionInput = {};
  if (action === "model") {
    const m = ((await io.readLine(`New model id 新模型 (now ${row.model}): `)) ?? "").trim();
    if (!m || /\s/.test(m) || m.startsWith("-")) { io.write("Aborted — no valid model id given; nothing was run.\n"); return 0; }
    input.model = m;
  }
  if (action === "copy") {
    const name = ((await io.readLine("Name of the copy 新节点名: ")) ?? "").trim();
    if (!name || /\s/.test(name) || name.startsWith("-") || name === row.alias) {
      io.write("Aborted — the copy needs a new name (no spaces, not the same name); nothing was run.\n");
      return 0;
    }
    input.newName = name;
    if (row.kind === "co-presence") {
      const def = resolve(dirname(ctx.cwd), name);
      const wd = ((await io.readLine(`Workdir for the copy 副本工作目录 [${def}]: `)) ?? "").trim();
      input.workdir = wd ? resolve(ctx.cwd, wd) : def;
    }
  }

  const cmd = planAction(row, action, input);
  io.write(`\nWill run 将执行:\n  ${commandLine(cmd)}\n`);
  if (cmd.note) io.write(`  (${cmd.note})\n`);

  if (action === "delete") {
    const typed = await io.readLine(`Type the node name to delete it 输入节点名确认删除 (${row.alias}): `);
    if ((typed ?? "").trim() !== row.alias) { io.write("Name did not match — aborted, nothing was run. 名字不符,已取消。\n"); return 0; }
  } else {
    const yn = await io.readLine("Run it? 执行? [y/N]: ");
    if (!/^(y|yes)$/i.test((yn ?? "").trim())) { io.write("Aborted — nothing was run. 已取消,未执行。\n"); return 0; }
  }

  const code = await run(cmd);
  if (code === 0 && cmd.after) io.write(`\n${cmd.after}\n`);
  if (code !== 0) io.write(`\n[anet] that command exited ${code}. Same command, by hand: ${commandLine(cmd)}\n`);
  return code;
}

/** #528 — ask for the new node's name, print the command, run only after y. adopt itself asks which conversation. */
async function adoptFromMenu(io: MenuIO, run: Runner): Promise<number> {
  const name = ((await io.readLine("Name of the new node 新节点名: ")) ?? "").trim();
  if (!name || /\s/.test(name) || name.startsWith("-")) { io.write("Aborted — the new node needs a name (no spaces); nothing was run.\n"); return 0; }
  const cmd = planAdopt(name);
  io.write(`\nWill run 将执行:\n  ${commandLine(cmd)}\n  (${cmd.note})\n`);
  const confirmed = /^(y|yes)$/i.test(((await io.readLine("Run it? 执行? [y/N]: ")) ?? "").trim());
  if (!confirmed) { io.write("Aborted — nothing was run. 已取消,未执行。\n"); return 0; }
  const code = await run(cmd);
  if (code !== 0) io.write(`\n[anet] that command exited ${code}. Same command, by hand: ${commandLine(cmd)}\n`);
  return code;
}

// ── real wiring ───────────────────────────────────────────────────────────

/** A line queue over one readline: scripted input that arrives in one chunk is not lost between prompts. */
function readlineIO(): MenuIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines: string[] = [];
  const waiters: ((s: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); });
  rl.on("close", () => { ended = true; while (waiters.length) waiters.shift()!(null); });
  return {
    write: (s) => { process.stdout.write(s); },
    readLine: (prompt) => {
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (ended) return Promise.resolve(null);
      return new Promise((r) => waiters.push(r));
    },
    close: () => rl.close(),
  };
}

function realRunner(beforeRun: () => void): Runner {
  return async (cmd) => {
    beforeRun();
    const env = { ...process.env, ...(cmd.env ?? {}) };
    let r;
    if (cmd.argv[0] === "anet") {
      // Same entrypoint, same loader flags (tsx/bun in dev, dist/bin/cli.js published).
      r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], ...cmd.argv.slice(1)], { stdio: "inherit", env });
    } else {
      r = spawnSync(cmd.argv[0], cmd.argv.slice(1), { stdio: "inherit", env });
    }
    if (r.error) { process.stderr.write(`[anet] could not run ${cmd.argv[0]}: ${r.error.message}\n`); return 1; }
    return r.status ?? 1;
  };
}

/** Entry from cli.ts (`anet node codex` with no arguments). Returns the exit code. */
export async function runCodexMenu(nodes: CodexMenuNode[], opts: { nodesDir: string; home: string; cwd?: string }): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const rows = collectCodexRows(nodes, { nodesDir: opts.nodesDir, home: opts.home });
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    process.stdout.write(renderCodexTable(rows, cwd) + "\n" + CODEX_CHEAT_SHEET);
    return 0;
  }
  const io = readlineIO();
  try {
    return await codexMenu(rows, io, realRunner(() => io.close()), { cwd });
  } finally {
    io.close();
  }
}
