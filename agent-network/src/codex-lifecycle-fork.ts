/**
 * #1856 PR-C — `anet node codex fork <source> --name <target> --workdir <dir>` 的纯逻辑。
 *
 * fork = 继承历史,其余全新:新 node_id / CommHub 身份、新 CODEX_HOME(0700)、新 thread id、新工作目录、
 * 新 tmux 名;源节点零触碰(只读它的 auth/config 与那一个 rollout)。
 * rollout 是**复制 + 改写 id**,不是共享:同一个 thread id 若出现在两个 CODEX_HOME 里,Dashboard/hub 就分不清谁是谁。
 * 复制是流式的(真机 rollout 131 MB / 5 万行),第一行必须是 session_meta 且 session_id 等于源 thread,
 * 否则一个字节都不写(fail-closed,不猜)。
 */
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import type { ReceiptCheck } from "./codex-lifecycle-receipt.js";

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codex 的 thread id 是 UUIDv7(时间有序);fork 出的新 id 也按 v7 生成,便于按文件名/id 排序时落在源之后。 */
export function uuidV7(nowMs: number, rand: Uint8Array): string {
  if (rand.length < 10) throw new Error("uuidV7 needs 10 random bytes");
  const ts = BigInt(Math.floor(nowMs)) & ((1n << 48n) - 1n);
  const hex = (n: bigint, w: number) => n.toString(16).padStart(w, "0");
  const b = Array.from(rand.slice(0, 10));
  const p1 = hex(ts, 12);
  const p2 = ((0x7 << 12) | (((b[0] & 0x0f) << 8) | b[1])).toString(16).padStart(4, "0");
  const p3 = (((0x2 << 6) | (b[2] & 0x3f)) << 8 | b[3]).toString(16).padStart(4, "0");
  const p4 = b.slice(4, 10).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${p1.slice(0, 8)}-${p1.slice(8, 12)}-${p2}-${p3}-${p4}`;
}

/** codex 的 rollout 路径:sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl(UTC)。 */
export function forkRolloutPath(codexHome: string, now: Date, threadId: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = now.getUTCFullYear(), mo = p(now.getUTCMonth() + 1), d = p(now.getUTCDate());
  const stamp = `${y}-${mo}-${d}T${p(now.getUTCHours())}-${p(now.getUTCMinutes())}-${p(now.getUTCSeconds())}`;
  return join(codexHome, "sessions", String(y), mo, d, `rollout-${stamp}-${threadId}.jsonl`);
}

/** CODEX_HOME 里哪些文件随 fork 走。显式白名单;env 文件(含源节点 CommHub token)、历史、sqlite、缓存一律不带。 */
export const FORK_HOME_COPY: readonly { name: string; required: boolean; mode: number }[] = [
  { name: "auth.json", required: true, mode: 0o600 },
  { name: "config.toml", required: false, mode: 0o600 },
  { name: "version.json", required: false, mode: 0o600 },
  // #1951 gap 5 — the node-level rules file codex reads from CODEX_HOME. Operators were copying it by hand.
  { name: "AGENTS.md", required: false, mode: 0o600 },
];
export const FORK_HOME_NEVER_COPY: readonly string[] = [".anet-copresence.env", "history.jsonl", "sessions", "cache", "logs_2.sqlite", "goals_1.sqlite", "installation_id"];

export interface RolloutRewriteResult {
  readonly lines: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** 源 thread id 改写次数(定长,不改字节数)。 */
  readonly replacements: number;
  /** `"cwd":"<源目录>"` 改写次数(session_meta + 每个 turn_context 都带;改成新 workdir,字节数按长度差变化)。 */
  readonly cwdReplacements: number;
  /** = bytesIn + cwdReplacements × (新 cwd 编码长度 − 旧 cwd 编码长度);fork_isolation 用它核对复制没有丢字节。 */
  readonly expectedBytesOut: number;
}

/**
 * 流式复制 rollout 并把源 thread id 逐处改成新 id(两者定长 36 字符 → 字节数不变,可作 fork_isolation 的证据)。
 * 第一行校验失败时目标文件不存在(先读第一行再开写)。
 */
export async function rewriteRollout(src: string, dst: string, oldId: string, newId: string, cwd?: { from: string; to: string }): Promise<RolloutRewriteResult> {
  if (!THREAD_ID_RE.test(oldId) || !THREAD_ID_RE.test(newId)) throw new Error("rewriteRollout: thread ids must be 36-char uuids");
  if (oldId.toLowerCase() === newId.toLowerCase()) throw new Error("rewriteRollout: new id equals source id");
  if (existsSync(dst)) throw new Error(`rewriteRollout: target already exists: ${dst}`);
  const bytesIn = statSync(src).size;
  const rl = createInterface({ input: createReadStream(src, { encoding: "utf8" }), crlfDelay: Infinity });
  let out: ReturnType<typeof createWriteStream> | null = null;
  let lines = 0, replacements = 0, cwdReplacements = 0, bytesOut = 0;
  // 精确匹配 JSON 里的 "cwd":"<from>"(含引号与转义),只换目录字面量,不碰别的字段。
  const cwdFrom = cwd ? `"cwd":${JSON.stringify(cwd.from)}` : null;
  const cwdTo = cwd ? `"cwd":${JSON.stringify(cwd.to)}` : null;
  const write = (s: string) => new Promise<void>((res, rej) => { out!.write(s, (e) => (e ? rej(e) : res())); });
  try {
    for await (const line of rl) {
      if (lines === 0) {
        let meta: any;
        try { meta = JSON.parse(line); } catch { throw new Error("rewriteRollout: first line is not JSON — refusing (not a codex rollout)"); }
        if (meta?.type !== "session_meta" || meta?.payload?.session_id !== oldId) {
          throw new Error(`rewriteRollout: first line is not session_meta for ${oldId} — refusing`);
        }
        mkdirSync(join(dst, ".."), { recursive: true, mode: 0o700 });
        out = createWriteStream(dst, { mode: 0o600, flags: "wx" });
      }
      const parts = line.split(oldId);
      replacements += parts.length - 1;
      let body = parts.join(newId);
      if (cwdFrom && cwdTo && cwdFrom !== cwdTo) {
        const cparts = body.split(cwdFrom);
        cwdReplacements += cparts.length - 1;
        body = cparts.join(cwdTo);
      }
      const rewritten = body + "\n";
      bytesOut += Buffer.byteLength(rewritten);
      await write(rewritten);
      lines += 1;
    }
  } finally {
    if (out) await new Promise<void>((res) => out!.end(res));
  }
  if (lines === 0) throw new Error("rewriteRollout: source rollout is empty — refusing");
  const delta = cwdFrom && cwdTo && cwdFrom !== cwdTo ? Buffer.byteLength(cwdTo) - Buffer.byteLength(cwdFrom) : 0;
  return { lines, bytesIn, bytesOut, replacements, cwdReplacements, expectedBytesOut: bytesIn + cwdReplacements * delta };
}

export interface ForkSides {
  readonly source: { nodeId: string | null; homeReal: string | null; threadId: string | null; alias: string; rolloutInode: number | bigint | null; rolloutBytes: number | null };
  readonly target: { nodeId: string | null; homeReal: string | null; threadId: string | null; alias: string; rolloutInode: number | bigint | null; rolloutBytes: number | null; envFilePresent: boolean };
  readonly rewrite: RolloutRewriteResult | null;
}

/** fork_isolation:身份 / HOME / thread / rollout 文件 / tmux 名五处都不同,且 rollout 是等长复制、没带 token 文件。 */
export function checkForkIsolation(s: ForkSides): ReceiptCheck {
  const bad: string[] = [];
  if (!s.target.nodeId || s.target.nodeId === s.source.nodeId) bad.push("node_id not distinct");
  if (!s.target.homeReal || s.target.homeReal === s.source.homeReal) bad.push("CODEX_HOME not distinct");
  if (!s.target.threadId || s.target.threadId === s.source.threadId) bad.push("thread id not distinct");
  if (s.target.alias === s.source.alias) bad.push("alias (tmux names) not distinct");
  if (s.target.rolloutInode === null || s.target.rolloutInode === s.source.rolloutInode) bad.push("rollout not a separate file");
  if (s.rewrite === null) bad.push("rollout was not rewritten");
  else {
    if (s.rewrite.expectedBytesOut !== s.rewrite.bytesOut) bad.push(`rollout size ${s.rewrite.bytesOut} ≠ expected ${s.rewrite.expectedBytesOut} (in ${s.rewrite.bytesIn}, ${s.rewrite.cwdReplacements} cwd rewrites)`);
    if (s.rewrite.replacements < 1) bad.push("source thread id never appeared in rollout");
    if (s.target.rolloutBytes !== null && s.target.rolloutBytes !== s.rewrite.bytesOut) bad.push("written rollout size differs from stream count");
  }
  if (s.target.envFilePresent) bad.push("target CODEX_HOME carries a copresence env file (token) before first start");
  const evidence = {
    sourceNodeId: s.source.nodeId, targetNodeId: s.target.nodeId,
    sourceThread: s.source.threadId, targetThread: s.target.threadId,
    rolloutLines: s.rewrite?.lines ?? null, rolloutBytes: s.rewrite?.bytesOut ?? null, idReplacements: s.rewrite?.replacements ?? null, cwdReplacements: s.rewrite?.cwdReplacements ?? null,
  };
  if (bad.length > 0) return { key: "fork_isolation", status: "fail", detail: bad.join("; "), evidence };
  return { key: "fork_isolation", status: "pass", detail: `new node_id / CODEX_HOME / thread / rollout file / tmux names; rollout ${s.rewrite!.lines} lines copied with ${s.rewrite!.replacements} id rewrites and ${s.rewrite!.cwdReplacements} cwd rewrites (byte count as expected)`, evidence };
}

// ── #1951 —— the five CLI gaps partner operators hit with `fork` ──

/** gap 1 — `--workdir` used to have to pre-exist. Create it (recursively) when missing; still refuse a path that exists
 * but is not a directory. Returns whether this call created it, so the receipt can say so. */
export function ensureForkWorkdir(path: string): { created: boolean } {
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) throw new Error(`--workdir ${path} exists but is not a directory`);
    return { created: false };
  }
  mkdirSync(path, { recursive: true, mode: 0o755 });
  return { created: true };
}

const TOML_PROJECT_HEADER_RE = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(#.*)?$/;

function tomlProjectHeaderPath(line: string): string | null {
  const m = TOML_PROJECT_HEADER_RE.exec(line);
  if (!m) return null;
  if (m[1] !== undefined) {
    try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
  }
  return m[2] ?? null;
}

/**
 * gap 2 — codex records trust per workspace as `[projects."<abs path>"]` tables in config.toml. A copied config still
 * names the **source** workspace, so the target keeps trusting (and, in the TUI, offering) the wrong directory.
 * Rewrite only the table headers whose quoted path equals `from`, to `to`; every other line is left byte-identical.
 * If a `[projects."<to>"]` table already exists, the source table is dropped instead of duplicated (TOML forbids
 * defining a table twice). Line-aware on purpose: no global substitution of the path string elsewhere in the file.
 */
export function rewriteTrustedProjects(toml: string, from: string, to: string): { text: string; rewritten: number; dropped: number } {
  if (from === to) return { text: toml, rewritten: 0, dropped: 0 };
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const lines = toml.split(/\r?\n/);
  const hasTarget = lines.some((l) => tomlProjectHeaderPath(l) === to);
  const out: string[] = [];
  let rewritten = 0, dropped = 0, skipping = false;
  for (const line of lines) {
    const header = tomlProjectHeaderPath(line);
    const isAnyHeader = /^\s*\[/.test(line);
    if (header === from) {
      if (hasTarget) { skipping = true; dropped += 1; continue; }
      out.push(line.replace(TOML_PROJECT_HEADER_RE, (whole) => whole.replace(/\[projects\..*\]/, `[projects.${JSON.stringify(to)}]`)));
      rewritten += 1;
      continue;
    }
    if (skipping) {
      if (isAnyHeader) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return { text: out.join(eol), rewritten, dropped };
}

/**
 * gap 3 — the last `turn_context` in a rollout names the model (and provider) the source ran on; codex resumes with
 * that unless the target config says otherwise. Read it from the tail of the file (rollouts reach hundreds of MB;
 * never load the whole thing) so `fork --model` can warn when the override differs.
 */
export function readLastTurnContextModel(rolloutPath: string, tailBytes = 1 << 20): { model: string | null; provider: string | null } {
  const fd = openSync(rolloutPath, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
      const line = lines[i];
      if (!line.includes('"turn_context"')) continue;
      try {
        const j = JSON.parse(line);
        if (j?.type !== "turn_context") continue;
        const p = j.payload ?? {};
        return { model: typeof p.model === "string" ? p.model : null, provider: typeof p.model_provider === "string" ? p.model_provider : typeof p.provider === "string" ? p.provider : null };
      } catch { continue; }
    }
    return { model: null, provider: null };
  } finally {
    closeSync(fd);
  }
}

/** What the fork receipt records for the #1951 gaps, as one informational check (never blocks; `port` is the
 * loopback port pre-assigned for the app-server, first start uses it as its preferred port and re-probes if taken). */
export interface ForkGapFacts {
  readonly workdir_created: boolean;
  readonly trusted_rewritten: number;
  readonly trusted_dropped: number;
  readonly model_override: string | null;
  readonly source_last_model: string | null;
  readonly port: number | null;
  readonly agents_md_carried: boolean;
}

export function forkGapsCheck(f: ForkGapFacts): ReceiptCheck {
  const bits = [
    f.workdir_created ? "workdir created" : "workdir existed",
    `${f.trusted_rewritten} trusted-project header(s) rewritten${f.trusted_dropped ? ` (${f.trusted_dropped} dropped as duplicate)` : ""}`,
    f.model_override ? `model override ${f.model_override}${f.source_last_model && f.source_last_model !== f.model_override ? ` (source last ran ${f.source_last_model})` : ""}` : "model inherited from source",
    f.port !== null ? `app-server port ${f.port} pre-assigned (free at fork time; first start re-probes)` : "app-server port left to first start",
    f.agents_md_carried ? "AGENTS.md carried" : "no AGENTS.md in source",
  ];
  return { key: "fork_options", status: "pass", detail: bits.join("; "), evidence: { ...f } };
}
