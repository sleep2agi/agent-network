// #448 —— 每条重生路径上,CODEX_HOME 都由**本节点自己的配置/目录**算出来,不从环境继承。
//
// 现场(一个跑 ~40 台 codex 共存节点的团队):launcher 的包装 shell 带着**另一台节点**的
// CODEX_HOME,子进程是对的,只因为包装脚本里那行 `export CODEX_HOME=…` 恰好又盖了一次。
// 成因:tmux `new-session` 的初始进程环境取自 tmux **服务器**的全局环境,而不是发起命令的
// 那个进程;服务器若是在某台节点的 pane 里第一次被拉起的,之后所有新会话的外层 shell 都带着
// 那台节点的 CODEX_HOME。一旦哪条重生路径漏了那行 export,子进程就会用邻居的登录态和会话目录
// —— 而 refresh token 是一次性的(#1918),这等于两台节点抢同一份凭据。
//
// 所以这里做两件事:
//   1. resolveNodeCodexHome:只看节点自己的 config + nodeDir,给出唯一的期望值;
//   2. verifyProcessTreeCodexHome:子进程起来之后读 /proc/<pid>/environ 核对,不符就拒(fail closed)。
//
// 🔴 本文件在 agent-network/src 与 agent-node/src 各有一份,**逐字节相同**(parity 门:
//    agent-network/src/codex-home-enforce-parity.test.ts)。两个包不能互相 import。
//    所以这里只许 import node 内置模块。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type CodexHomeSource = "config.codexHome" | "node-codex-home" | "config.env" | "none";

export interface CodexHomeResolution {
  /** null = 这台节点没有专属 CODEX_HOME(普通 codex 节点用 codex 自己的默认 ~/.codex)。 */
  codexHome: string | null;
  source: CodexHomeSource;
}

export interface ResolveNodeCodexHomeInput {
  nodeDir: string;
  /** 节点 config.json 的内容(只读其中三格:codexHome / codexCopresence / env.CODEX_HOME)。 */
  config: Record<string, unknown> | null | undefined;
  exists?: (path: string) => boolean;
}

/**
 * 本节点的 CODEX_HOME,只由节点自己的配置/目录决定。优先级:
 *   ① config.codexHome(`--codex-home` 显式指定后持久化的那一格)
 *   ② <nodeDir>/codex-home(共存节点,或目录已经存在)
 *   ③ config.env.CODEX_HOME(节点 profile 自己写的,字面字符串)
 *   ④ 没有 → null
 * **进程环境从不参与**:那正是本模块要挡掉的来源。
 */
export function resolveNodeCodexHome(input: ResolveNodeCodexHomeInput): CodexHomeResolution {
  const cfg = input.config ?? {};
  const exists = input.exists ?? existsSync;
  const explicit = (cfg as { codexHome?: unknown }).codexHome;
  if (typeof explicit === "string" && explicit.trim() && isAbsolute(explicit.trim())) {
    return { codexHome: resolve(explicit.trim()), source: "config.codexHome" };
  }
  const own = join(input.nodeDir, "codex-home");
  if ((cfg as { codexCopresence?: unknown }).codexCopresence === true || exists(own)) {
    return { codexHome: resolve(own), source: "node-codex-home" };
  }
  const envBlock = (cfg as { env?: unknown }).env;
  const fromEnv = envBlock && typeof envBlock === "object" ? (envBlock as Record<string, unknown>).CODEX_HOME : undefined;
  if (typeof fromEnv === "string" && fromEnv.trim() && isAbsolute(fromEnv.trim())) {
    return { codexHome: resolve(fromEnv.trim()), source: "config.env" };
  }
  return { codexHome: null, source: "none" };
}

/** `<任意>/.anet/nodes/<id>/codex-home` —— 一看就是某台 anet 节点的专属目录。 */
const ANET_NODE_CODEX_HOME = /[\\/]\.anet[\\/]nodes[\\/][^\\/]+[\\/]codex-home[\\/]?$/;

export function looksLikeAnetNodeCodexHome(path: string): boolean {
  return ANET_NODE_CODEX_HOME.test(path);
}

export interface ApplyCodexHomeResult {
  /** 实际交给子进程的值(undefined = 不设,交给 codex 默认)。 */
  codexHome: string | undefined;
  /** 给人看的一行;没有需要说的时候为 null。 */
  note: string | null;
}

/**
 * 把解析结果写进一份**将要交给子进程**的 env(原地修改并返回结论)。
 * - 有专属值 → 强制写入,覆盖任何继承来的值。
 * - 没有专属值、而继承来的值是**别的 anet 节点**的 codex-home → 删掉(那绝不是本节点的)。
 * - 没有专属值、继承来的是运维自己 export 的普通路径 → 保留(不改变普通 codex 节点的既有行为),
 *   并说一句它来自环境。
 */
export function applyNodeCodexHome(
  env: Record<string, string | undefined>,
  resolution: CodexHomeResolution,
): ApplyCodexHomeResult {
  const inherited = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() ? env.CODEX_HOME : undefined;
  if (resolution.codexHome) {
    env.CODEX_HOME = resolution.codexHome;
    const note = inherited !== undefined && resolve(inherited) !== resolution.codexHome
      ? `CODEX_HOME from the environment (${inherited}) is not this node's; using ${resolution.codexHome} (${resolution.source})`
      : null;
    return { codexHome: resolution.codexHome, note };
  }
  if (inherited !== undefined && looksLikeAnetNodeCodexHome(inherited)) {
    delete env.CODEX_HOME;
    return {
      codexHome: undefined,
      note: `dropped CODEX_HOME=${inherited} inherited from the environment — it is another anet node's codex-home; this node has none of its own, so codex uses its default`,
    };
  }
  return {
    codexHome: inherited,
    note: inherited !== undefined ? `CODEX_HOME=${inherited} comes from the launching environment (this node has no codex-home of its own)` : null,
  };
}

// ── /proc 核对 ──────────────────────────────────────────────────────────────

export interface ProcReader {
  /** /proc/<pid>/environ 的原始内容;读不到返回 null。 */
  environ(pid: number): string | null;
  /** 所有进程的 [pid, ppid];读不到返回 []。 */
  parents(): Array<[number, number]>;
}

/**
 * 一个 /proc 里的 NUL 分隔块(environ / cmdline)的**原始字节** → JS 字符串,逐条按 UTF-8 解码。
 *
 * 🔴 #448 回归:曾经是 `readFileSync(…, "latin1")`,每个字节变成一个 U+00xx。期望值是 JS 字符串
 *    (UTF-8 路径解码来的),于是**任何非 ASCII 路径**(如 `.anet/nodes/测试节点/codex-home`)
 *    读出来都是 `æµè¯…` 这种乱码、永远不相等 → fail closed → 该节点每个任务都被拒。
 *
 * 某一条不是合法 UTF-8 时,不做有损替换(U+FFFD 可能碰巧和期望值里的 U+FFFD 相等):
 * 把 `=` 之后的部分换成 INVALID_UTF8_MARK + 原字节的 latin1 —— 以一个孤立代理项开头,
 * 而合法 UTF-8 解码出来的字符串绝不含孤立代理项,所以它**不可能**等于任何真实路径(fail closed)。
 */
export const INVALID_UTF8_MARK = "\uDFFF";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodeProcNulBlock(bytes: Uint8Array): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0) continue;
    if (i === bytes.length && start === i) break;
    const entry = bytes.subarray(start, i);
    let text: string;
    try {
      text = STRICT_UTF8.decode(entry);
    } catch {
      const raw = Buffer.from(entry).toString("latin1");
      const eq = raw.indexOf("=");
      text = eq >= 0 ? raw.slice(0, eq + 1) + INVALID_UTF8_MARK + raw.slice(eq + 1) : INVALID_UTF8_MARK + raw;
    }
    out.push(text);
    start = i + 1;
  }
  // 与 latin1 读法同形:每条后面都跟一个 NUL(内核写的块以 NUL 结尾)。
  return out.length === 0 ? "" : out.join("\0") + (bytes[bytes.length - 1] === 0 ? "\0" : "");
}

/** 合法 UTF-8 解码不出孤立代理项;含孤立代理项的值(INVALID_UTF8_MARK)不能拿来和任何东西比相等。 */
export function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** 读 /proc/<pid>/<file>(environ / cmdline)并逐条按 UTF-8 解码;读不到返回 null。 */
export function readProcNulBlock(pid: number, file: "environ" | "cmdline"): string | null {
  try { return decodeProcNulBlock(readFileSync(`/proc/${pid}/${file}`)); } catch { return null; }
}

export const linuxProcReader: ProcReader = {
  environ(pid) {
    return readProcNulBlock(pid, "environ");
  },
  parents() {
    const out: Array<[number, number]> = [];
    let names: string[] = [];
    try { names = readdirSync("/proc"); } catch { return out; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "latin1");
        // comm 可能含空格和括号,取最后一个 ')' 之后的字段:state ppid …
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(rest[1]);
        if (Number.isInteger(ppid)) out.push([Number(name), ppid]);
      } catch { /* 进程已退出 */ }
    }
    return out;
  },
};

/** 环境块里某个变量的值:undefined = 环境读不到;null = 读到了但没有这个变量。 */
export function envVarFromEnviron(environ: string | null, name: string): string | null | undefined {
  if (environ === null) return undefined;
  const prefix = `${name}=`;
  for (const kv of environ.split("\0")) if (kv.startsWith(prefix)) return kv.slice(prefix.length);
  return null;
}

export function descendantPids(rootPid: number, parents: Array<[number, number]>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const out: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

export type CodexHomeVerdict =
  | { ok: true; checked: number[]; skipped?: string }
  | { ok: false; pid: number; actual: string | null; expected: string; message: string };

/**
 * 读 rootPid 及其全部后代的 /proc/<pid>/environ:
 *   - rootPid 自己的 CODEX_HOME 必须**正好等于** expected(缺失也算不符);
 *   - 后代里凡是带 CODEX_HOME 的,也必须等于 expected(某个后代自己 unset 掉不算错)。
 * 不是 Linux、或 rootPid 的环境根本读不到(进程已退出/权限)→ ok:true + skipped,由调用方决定怎么说。
 * 🔴 读不到 ≠ 核对通过:skipped 必须被调用方打印出来,不能当绿。
 */
export function verifyProcessTreeCodexHome(opts: {
  rootPid: number;
  expected: string;
  label: string;
  platform?: string;
  reader?: ProcReader;
}): CodexHomeVerdict {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return { ok: true, checked: [], skipped: `not linux (${platform}); /proc environ check unavailable` };
  // 期望值本身含孤立代理项 → 编码成字节时已经不是它自己了,任何进程都不可能真的带着它:直接拒。
  if (hasLoneSurrogate(opts.expected)) {
    return {
      ok: false, pid: opts.rootPid, actual: null, expected: opts.expected,
      message: `${opts.label} expected CODEX_HOME is not a well-formed string; refusing`,
    };
  }
  const reader = opts.reader ?? linuxProcReader;
  const rootValue = envVarFromEnviron(reader.environ(opts.rootPid), "CODEX_HOME");
  if (rootValue === undefined) return { ok: true, checked: [], skipped: `pid ${opts.rootPid} environ unreadable` };
  if (rootValue !== opts.expected) {
    return {
      ok: false, pid: opts.rootPid, actual: rootValue, expected: opts.expected,
      message: `${opts.label} pid ${opts.rootPid} runs with CODEX_HOME=${rootValue ?? "<unset>"}, expected ${opts.expected}`,
    };
  }
  const checked = [opts.rootPid];
  for (const pid of descendantPids(opts.rootPid, reader.parents())) {
    const value = envVarFromEnviron(reader.environ(pid), "CODEX_HOME");
    if (value === undefined || value === null) continue;
    checked.push(pid);
    if (value !== opts.expected) {
      return {
        ok: false, pid, actual: value, expected: opts.expected,
        message: `${opts.label} child pid ${pid} (under ${opts.rootPid}) runs with CODEX_HOME=${value}, expected ${opts.expected}`,
      };
    }
  }
  return { ok: true, checked };
}
