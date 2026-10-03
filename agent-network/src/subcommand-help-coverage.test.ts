import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #516 —— 每一个顶层命令和子命令都必须回答 `--help` / `-h`:打一段**属于它自己**的
// usage、exit 0、不把 `--help` 当参数、不开始干活、不打 "unknown command"。
//
// 🔴 #502 测试报告实测:`node create/stop/restart/delete/ls/info/edit/rename/codex fork --help`
// 只打一行总 usage;`login/logout/whoami/config/upgrade/... --help` 打 139 行全局帮助;
// 更糟的是 `anet network create --help` 会把 "--help" 当网络名真去 Hub 上建一个。
//
// 所以这道门**不用手写名单**:从 bin/cli.ts 的分发表(`switch (command)` → 各命令
// 函数里的 `switch (sub)` / `sub === "x"`)反推出全部命令路径,再对每条路径真跑一次
// CLI。将来加一个子命令而没给 help,它会红。
//
// 两层分开自检(CLAUDE.md 复核纪律 ⑤):
//   取集 —— 往源码副本里注入一个假子命令,看它被收进来;并钉住几条已知的深层路径。
//   判据 —— 拿一条已知没有 help 的路径喂给判据,看它红。

const CLI_PATH = join(import.meta.dir, "..", "bin", "cli.ts");
const SRC = readFileSync(CLI_PATH, "utf-8");

// ── 取集 ────────────────────────────────────────────────────────────────

/** 从 `{` 开始做括号配对,返回块内文本(不含外层括号)。只用于这份源码,足够。 */
function blockAt(src: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(openBrace + 1, i); }
  }
  throw new Error("unbalanced braces");
}

/** `function name(` 的函数体。 */
function functionBody(src: string, name: string): string | null {
  const m = new RegExp(`^(?:async\\s+)?function ${name}\\(`, "m").exec(src);
  if (!m) return null;
  const brace = src.indexOf("{", src.indexOf(")", m.index));
  return blockAt(src, brace);
}

/**
 * switch 块里的 case 组:同一缩进层的连续 `case "x":` 归成一组(别名),组体到下一组为止。
 * 只看最浅那一层,嵌套 switch 的 case 缩进更深、留在组体里。
 */
function caseGroups(switchBody: string): { labels: string[]; body: string }[] {
  const lines = switchBody.split("\n");
  const first = lines.find((l) => /^\s*case "/.test(l));
  if (!first) return [];
  const indent = first.match(/^\s*/)![0];
  const groups: { labels: string[]; body: string[] }[] = [];
  let cur: { labels: string[]; body: string[] } | null = null;
  let lastWasLabelOnly = false;
  for (const line of lines) {
    const atLevel = line.startsWith(indent) && !/^\s/.test(line.slice(indent.length));
    if (atLevel && line.slice(indent.length).startsWith("case ")) {
      const labels = [...line.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
      const rest = line.replace(/case "[^"]+":/g, "").trim();
      if (cur && lastWasLabelOnly) cur.labels.push(...labels);
      else { cur = { labels, body: [] }; groups.push(cur); }
      if (rest) cur.body.push(rest);
      lastWasLabelOnly = rest === "";
      continue;
    }
    if (atLevel && line.slice(indent.length).startsWith("default")) { cur = null; lastWasLabelOnly = false; continue; }
    if (cur) cur.body.push(line);
    lastWasLabelOnly = false;
  }
  return groups.map((g) => ({ labels: g.labels, body: g.body.join("\n") }));
}

/** 一段代码里 `switch (<expr>) {` 的块,expr ∈ exprs。 */
function switchesOn(code: string, exprs: string[]): string[] {
  const out: string[] = [];
  const re = /switch\s*\(\s*([^)]+?)\s*\)\s*\{/g;
  for (const m of code.matchAll(re)) {
    if (exprs.includes(m[1]!)) out.push(blockAt(code, m.index! + m[0].length - 1));
  }
  return out;
}

const SUB_EXPRS = ["sub", "verb", "args[1]"];
// `!==` 也算:`if (args[1] !== "attach") { usage; exit }` 说明 attach 是子命令(grok)。
const SUB_LITERAL = /(?:\bsub|\bverb|args\[1\])\s*[!=]==\s*"([a-z][a-z0-9-]*)"/g;

/** `const validVerbs = ["start", …]; … validVerbs.includes(verb)` 这种白名单数组(batch / node codex)。 */
function verbArrays(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/const (\w+) = \[([^\]]*)\](?: as const)?;/g)) {
    const name = m[1]!;
    if (!new RegExp(`\\b${name}\\b[^;\\n]*\\.includes\\((?:sub|verb)\\)`).test(code)) continue;
    for (const v of m[2]!.matchAll(/"([a-z][a-z0-9-]*)"/g)) out.push(v[1]!);
  }
  return out;
}
/** 不算子命令:help 词本身。 */
const NOT_A_SUB = new Set(["help"]);

function stripComments(code: string): string {
  return code.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
}

/** `sub === "ls" || sub === "list"` → list 是 ls 的别名。 */
const ALIAS_PAIR = /(?:\bsub|\bverb|args\[1\])\s*===\s*"([a-z][a-z0-9-]*)"\s*\|\|\s*(?:\bsub|\bverb|args\[1\])\s*===\s*"([a-z][a-z0-9-]*)"/g;

/** path → 规范路径(别名指向同组第一个标签;非别名指向自己)。 */
type Paths = Map<string, string>;

/**
 * 某个分发点(一段 case 组体)能到达的子命令:组体里内联的 `args[1] === "x"`、
 * 组体里的 `switch (args[1])`(node 那种)、以及组体调用的 *Command 函数里的
 * `switch (sub|verb)` / `sub === "x"`。switch 的 case 组体会递归下去(node codex fork)。
 */
function collectFrom(src: string, path: string[], body: string, out: Paths, seenFns: Set<string>) {
  if (path.length > 3) return;
  const put = (labels: string[], subBody: string | null, fns: Set<string>) => {
    const primary = labels[0]!;
    if (NOT_A_SUB.has(primary) || !/^[a-z]/.test(primary)) return;
    const p = [...path, primary];
    const key = p.join(" ");
    if (!out.has(key)) out.set(key, key);
    for (const alias of labels.slice(1)) if (!out.has([...path, alias].join(" "))) out.set([...path, alias].join(" "), key);
    if (subBody !== null) collectFrom(src, p, subBody, out, fns);
  };
  const literals = (code: string, re: RegExp, fns: Set<string>) => {
    const alias = new Map<string, string>();
    for (const m of code.matchAll(ALIAS_PAIR)) alias.set(m[2]!, m[1]!);
    for (const m of code.matchAll(re)) {
      const sub = m[1]!;
      const primary = alias.get(sub);
      put(primary ? [primary, sub] : [sub], null, fns);
    }
  };
  // 内联 switch (args[1]) —— node 那种。函数调用都在 case 组体里,交给递归,本层不再扫。
  const inline = switchesOn(body, ["args[1]"]);
  if (inline.length) {
    for (const sw of inline) for (const g of caseGroups(sw)) put(g.labels, g.body, seenFns);
    return;
  }
  // 内联 args[1] === "x"(init project / init profile)
  literals(body, /args\[1\]\s*[!=]==\s*"([a-z][a-z0-9-]*)"/g, seenFns);
  // 调用的命令函数
  for (const m of body.matchAll(/\b(\w+Command)\(/g)) {
    const fn = m[1]!;
    if (seenFns.has(fn)) continue;
    const fbody = functionBody(src, fn);
    if (!fbody) continue;
    const code = stripComments(fbody);
    const next = new Set(seenFns).add(fn);
    for (const sw of switchesOn(code, SUB_EXPRS)) for (const g of caseGroups(sw)) put(g.labels, g.body, next);
    literals(code, SUB_LITERAL, next);
    for (const v of verbArrays(code)) put([v], null, next);
  }
}

/** 全部命令路径 → 规范路径。顶层 + 能反推到的子命令。 */
export function collectCommandPaths(src: string): Paths {
  const code = stripComments(src);
  const anchor = code.lastIndexOf("\nswitch (command) {");
  if (anchor < 0) throw new Error("找不到顶层 `switch (command) {` —— 分发表被改写了");
  const top = blockAt(code, code.indexOf("{", anchor));
  const out: Paths = new Map();
  for (const g of caseGroups(top)) {
    const labels = g.labels.filter((l) => !l.startsWith("-") && l !== "help");   // anet --help / -v 本身就是帮助/版本
    if (!labels.length) continue;
    for (const l of labels) out.set(l, labels[0]!);
    collectFrom(code, [labels[0]!], g.body, out, new Set());
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

// ── 判据 ────────────────────────────────────────────────────────────────

const GLOBAL_HELP_MARK = "AI Agent Network CLI (V2)";

type HelpRun = { path: string; canonical?: string; flag: string; code: number | null; out: string };

async function runHelp(path: string, flag: string, home: string): Promise<HelpRun> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(ANET_|COMMHUB_|AGENT_NETWORK_)/.test(k)) continue;   // 绝不借调用方的 hub/token
    env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.NO_COLOR = "1";
  const proc = Bun.spawn(["bun", CLI_PATH, ...path.split(" "), flag], {
    cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { path, flag, code, out: stdout + stderr };
}

/** 一次 `--help` 运行是否合格;不合格返回原因。 */
export function judgeHelp(r: HelpRun): string | null {
  if (r.code !== 0) return `exit ${r.code}`;
  if (!/usage/i.test(r.out)) return "no 'Usage' block";
  if (r.out.includes(GLOBAL_HELP_MARK)) return "printed the global help instead of its own";
  if (/unknown (command|node subcommand|subcommand)|^Unknown:/im.test(r.out)) return "said unknown";
  // 别名(`ls`/`list`、`dash`/`dashboard`)提到规范名也算 —— 别名关系同样是从分发表读出来的。
  const names = [r.path, r.canonical].filter(Boolean).map((p) => `anet ${p}`);
  if (!names.some((n) => new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`).test(r.out))) {
    return `help never mentions "anet ${r.path}"`;
  }
  return null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

// ── 测试 ────────────────────────────────────────────────────────────────

describe("#516 --help everywhere", () => {
  const collected = collectCommandPaths(SRC);
  const paths = [...collected.keys()];

  it("取集正控:顶层和子命令都真的收进来了", () => {
    expect(paths.filter((p) => !p.includes(" ")).length).toBeGreaterThanOrEqual(40);
    expect(paths.filter((p) => p.includes(" ")).length).toBeGreaterThanOrEqual(60);
    for (const known of [
      "login", "node", "node delete", "node create", "node codex", "node codex fork",
      "hub start", "hub dashboard", "daemon init", "project up", "network create",
      "token create", "goal show", "channel add", "opencode auth-login", "init project",
    ]) expect(paths).toContain(known);
  });

  it("取集负控:注入一个假子命令/假顶层命令,收集器能看到它", () => {
    const mutated = SRC
      .replace('      case "rename": args.splice(0, 1); await renameCommand(); break;',
        '      case "rename": args.splice(0, 1); await renameCommand(); break;\n      case "zz-nohelp": args.splice(0, 1); await renameCommand(); break;')
      .replace('  case "whoami": await whoamiCommand(); break;',
        '  case "whoami": await whoamiCommand(); break;\n  case "zz-top": await whoamiCommand(); break;');
    expect(mutated).not.toBe(SRC);
    const got = [...collectCommandPaths(mutated).keys()];
    expect(got).toContain("node zz-nohelp");
    expect(got).toContain("zz-top");
  });

  it("判据负控:一条已知没有 help 的路径会被判红", async () => {
    const home = mkdtempSync(join(tmpdir(), "anet-help-neg-"));
    try {
      const r = await runHelp("node zz-nohelp", "--help", home);
      expect(judgeHelp(r)).not.toBeNull();
      // 也不能靠"打一页全局帮助"蒙混
      expect(judgeHelp({ path: "login", flag: "--help", code: 0, out: `Usage: anet login\n${GLOBAL_HELP_MARK}` })).not.toBeNull();
      expect(judgeHelp({ path: "login", flag: "--help", code: 1, out: "Usage: anet login" })).not.toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);

  it("每一条命令路径的 --help 和 -h 都打自己的 usage、exit 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "anet-help-all-"));
    try {
      const jobs = paths.flatMap((p) => [{ p, f: "--help" }, { p, f: "-h" }]);
      const runs = await pool(jobs, 12, async (j) => ({ ...(await runHelp(j.p, j.f, home)), canonical: collected.get(j.p) }));
      const bad = runs.map((r) => ({ r, why: judgeHelp(r) })).filter((x) => x.why)
        .map((x) => `anet ${x.r.path} ${x.r.flag}: ${x.why}`);
      expect(bad).toEqual([]);
      expect(runs.length).toBe(paths.length * 2);
      // 「不开始干活」:HOME 和 cwd 是同一个空目录,任何一条 --help 都不该在里面留下东西
      // (旧行为:`anet daemon up --help` 会建 daemon 配置,`anet network create --help` 会去 Hub 建网)。
      // `.bun` 是 bun 运行时自己的缓存目录,不是 anet 写的。
      expect(readdirSync(home).filter((n) => n !== ".bun")).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 300_000);
});
