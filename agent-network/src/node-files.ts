// 节点「项目文件夹」只读查看 —— 桌面端「节点设置 → 项目文件夹」。
//
// 与 rules-file.ts 同一条门铃链路(op = files_list | file_read)。和规则文件 / 技能不同,
// 这里**有**一个客户端给的路径,所以边界全部收在这个文件里:
//
//   🔴 1. 路径只能是相对节点工作目录(与 resolveRulesFilePath 同一个根 = 进程 cwd)的相对路径:
//         拒绝绝对路径、`~`、盘符、反斜杠、NUL、任何 `..` 段(normalizeNodeRelPath)。
//   🔴 2. 解析后取 realpath,必须仍在工作目录的 realpath 之内 —— 软链接逃不出去
//         (resolveInsideWorkDir)。列目录时软链接只报类型,不跟出去。
//   🔴 3. 凭据类文件**永远不回内容**,连精确大小也不回(secretReasonFor,纯函数、有测试):
//         .env*、*.pem、*.key、id_*、auth.json、credentials*、*.p12/*.pfx、.npmrc、.netrc、
//         .git-credentials、.anet/ 下的 config.json、.git/ 内一切、各运行时会话库
//         (codex-home/ .codex/ .grok/ .claude/)以及 .ssh/ .gnupg/ .aws/。
//         判定同时看「请求的路径」和「realpath 之后的路径」,指向凭据的软链接也挡住。
//   🔴 4. node_modules / .git 只列出目录本身,不往里走(no_descend)。
//
// 返回给 hub 的只有相对路径,不含本机绝对路径。

import { promises as fs } from "node:fs";
import path from "node:path";

export const NODE_FILE_READ_MAX_BYTES = 256 * 1024;
export const NODE_FILES_LIST_MAX = 1000;
export const NODE_FILE_PATH_MAX = 1024;
/** 回给 hub 的 JSON 最长这么多字符(hub 端 ack 上限相同)。 */
export const NODE_FILES_RESULT_MAX_CHARS = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

export type NodeFileType = "dir" | "file" | "symlink" | "other";
export type HiddenReason = "secret" | "skipped";

export interface NodeFileEntry {
  name: string;
  type: NodeFileType;
  /** 普通文件的字节数;凭据文件不给。 */
  size?: number;
  /** 毫秒时间戳。 */
  mtime?: number;
  hidden_reason?: HiddenReason;
  /** 目录(或指向目录的软链接)不允许进入。 */
  no_descend?: boolean;
  /** 软链接:指向工作目录内的什么;指向外面或断链为 null(不透露目标)。 */
  link_type?: "dir" | "file" | null;
}

export interface NodeFilesListResult {
  path: string;
  entries: NodeFileEntry[];
  truncated: boolean;
  total: number;
}

export type NodeFileReadKind = "text" | "binary" | "too_large" | "secret";

export interface NodeFileReadResult {
  path: string;
  name: string;
  kind: NodeFileReadKind;
  size?: number;
  mtime?: number;
  content?: string;
  hidden_reason?: HiddenReason;
}

/** 目录名:本身及其内部一律当凭据(会话库 / 密钥库 / git 内部)。 */
const SECRET_DIRS = new Set([".git", "codex-home", ".codex", ".grok", ".claude", ".ssh", ".gnupg", ".aws"]);
/** 目录名:列出但不进入,不算凭据。 */
const SKIPPED_DIRS = new Set(["node_modules"]);
const SECRET_EXACT = new Set(["auth.json", ".npmrc", ".netrc", ".git-credentials"]);

const splitSegs = (p: string): string[] => p.split("/").filter((s) => s !== "" && s !== ".").map((s) => s.toLowerCase());

/**
 * 纯函数:一个路径是否属于凭据。
 *   relPosix —— 相对工作目录(请求的路径,或 realpath 之后相对工作目录的路径)。
 *   rootAbs  —— 工作目录自身的绝对路径(posix);只作为「祖先目录」参与判定:工作目录本身
 *               就在 .claude/ .codex/ 之类里面时,里面的一切都算凭据;在 .anet/ 里面时
 *               config.json* 算凭据。工作目录自己的名字不参与文件名规则。
 * 任一祖先段(含末段)是凭据目录 → secret;末段按文件名规则判。大小写不敏感(macOS 默认不分大小写)。
 */
export function secretReasonFor(relPosix: string, rootAbs = ""): "secret" | null {
  const rootSegs = splitSegs(rootAbs);
  const lower = splitSegs(relPosix);
  for (const s of rootSegs) if (SECRET_DIRS.has(s)) return "secret";
  if (lower.length === 0) return null;
  for (const s of lower) if (SECRET_DIRS.has(s)) return "secret";
  const base = lower[lower.length - 1]!;
  if (base.startsWith(".env")) return "secret";
  if (SECRET_EXACT.has(base)) return "secret";
  if (base.endsWith(".npmrc") || base.endsWith(".netrc")) return "secret";
  if (base.startsWith("id_")) return "secret";
  if (base.startsWith("credentials")) return "secret";
  if (/\.(pem|key|p12|pfx)$/.test(base)) return "secret";
  if (base.startsWith("config.json") && [...rootSegs, ...lower.slice(0, -1)].includes(".anet")) return "secret";
  return null;
}

/** 纯函数:这个目录能不能进入。凭据目录 → secret;node_modules → skipped;路径上任一段命中同样不行。 */
export function noDescendReasonFor(relPosix: string, rootAbs = ""): HiddenReason | null {
  if (secretReasonFor(relPosix, rootAbs)) return "secret";
  const segs = relPosix.split("/").filter((s) => s !== "" && s !== ".");
  for (const s of segs) if (SKIPPED_DIRS.has(s.toLowerCase())) return "skipped";
  return null;
}

/** 客户端给的路径 → 规范化相对路径("" = 根)。不合法抛错,错误信息不回显输入。 */
export function normalizeNodeRelPath(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new Error("invalid path: not a string");
  if (raw.length > NODE_FILE_PATH_MAX) throw new Error("invalid path: too long");
  if (raw.includes("\0") || raw.includes("\\")) throw new Error("invalid path: NUL or backslash");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) throw new Error("invalid path: must be relative to the work dir");
  const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.some((s) => s === "..")) throw new Error("invalid path: .. is not allowed");
  return segs.join("/");
}

function isInsideOrSame(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export interface ResolvedNodePath {
  rootReal: string;
  real: string;
  /** realpath 之后相对根的路径(posix)。 */
  relReal: string;
}

/**
 * 解析并收在工作目录里:realpath(根) + realpath(根/rel),后者必须在前者之内。
 * 不存在抛 `not found`;逃出去抛 `outside the work dir`。
 */
export async function resolveInsideWorkDir(workDir: string, rel: string): Promise<ResolvedNodePath> {
  const rootReal = await fs.realpath(path.resolve(workDir));
  let real: string;
  try {
    real = await fs.realpath(path.join(rootReal, rel));
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") throw new Error(`not found: ${rel || "."}`);
    throw err;
  }
  if (!isInsideOrSame(real, rootReal)) throw new Error(`refused: ${rel} resolves outside the work dir`);
  return { rootReal, real, relReal: toPosix(path.relative(rootReal, real)) };
}

function entryType(d: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): NodeFileType {
  if (d.isSymbolicLink()) return "symlink";
  if (d.isDirectory()) return "dir";
  if (d.isFile()) return "file";
  return "other";
}

export async function listNodeFiles(workDir: string, rawPath: unknown): Promise<NodeFilesListResult> {
  const rel = normalizeNodeRelPath(rawPath);
  const { rootReal, real, relReal } = await resolveInsideWorkDir(workDir, rel);
  const root = toPosix(rootReal);
  const blocked = noDescendReasonFor(rel, root);
  if (blocked) throw new Error(`refused: ${rel || "."} is not browsable (${blocked})`);
  const blockedReal = noDescendReasonFor(relReal, root);
  if (blockedReal) throw new Error(`refused: ${rel} is not browsable (${blockedReal})`);
  const st = await fs.stat(real);
  if (!st.isDirectory()) throw new Error(`not a directory: ${rel || "."}`);

  const dirents = await fs.readdir(real, { withFileTypes: true });
  const rows = dirents.map((d) => ({ name: d.name, type: entryType(d) }));
  // 目录在前(软链接按「未知」排在文件里),同组按名字(不区分大小写)。
  rows.sort((a, b) => {
    const da = a.type === "dir" ? 0 : 1;
    const db = b.type === "dir" ? 0 : 1;
    if (da !== db) return da - db;
    const x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const total = rows.length;
  const picked = rows.slice(0, NODE_FILES_LIST_MAX);
  const entries: NodeFileEntry[] = [];
  for (const r of picked) {
    const childRel = rel ? `${rel}/${r.name}` : r.name;
    const abs = path.join(real, r.name);
    const e: NodeFileEntry = { name: r.name, type: r.type };
    let lst: import("node:fs").Stats | null = null;
    try { lst = await fs.lstat(abs); } catch { lst = null; }
    if (lst) e.mtime = Math.round(lst.mtimeMs);
    let secret = secretReasonFor(childRel, root);
    if (r.type === "symlink") {
      // 跟一次,但只在工作目录之内;外面 / 断链一律 null,不泄露目标。
      e.link_type = null;
      try {
        const target = await fs.realpath(abs);
        if (isInsideOrSame(target, rootReal)) {
          const tst = await fs.stat(target);
          e.link_type = tst.isDirectory() ? "dir" : tst.isFile() ? "file" : null;
          const targetRel = toPosix(path.relative(rootReal, target));
          if (!secret) secret = secretReasonFor(targetRel, root);
          if (e.link_type === "dir" && noDescendReasonFor(targetRel, root)) e.no_descend = true;
        }
      } catch {
        e.link_type = null;
      }
    }
    if (secret) {
      e.hidden_reason = "secret";
      if (r.type === "dir" || e.link_type === "dir") e.no_descend = true;
    } else if (r.type === "dir" && noDescendReasonFor(childRel, root)) {
      e.hidden_reason = "skipped";
      e.no_descend = true;
    } else if (r.type === "file" && lst) {
      e.size = lst.size;
    }
    entries.push(e);
  }
  return { path: rel, entries, truncated: total > picked.length, total };
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

export async function readNodeFile(workDir: string, rawPath: unknown): Promise<NodeFileReadResult> {
  const rel = normalizeNodeRelPath(rawPath);
  if (rel === "") throw new Error("invalid path: a file path is required");
  const name = rel.split("/").pop()!;
  // 凭据判定在打开文件之前,且先看请求的路径(即使它不存在也不说)。
  if (secretReasonFor(rel)) return { path: rel, name, kind: "secret", hidden_reason: "secret" };
  const { rootReal, real, relReal } = await resolveInsideWorkDir(workDir, rel);
  const root = toPosix(rootReal);
  if (secretReasonFor(rel, root) || secretReasonFor(relReal, root)) return { path: rel, name, kind: "secret", hidden_reason: "secret" };
  if (noDescendReasonFor(relReal, root) || noDescendReasonFor(rel, root)) throw new Error(`refused: ${rel} is inside a directory that is not browsable`);
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`not a regular file: ${rel}`);
  const base = { path: rel, name, size: st.size, mtime: Math.round(st.mtimeMs) };
  if (st.size > NODE_FILE_READ_MAX_BYTES) return { ...base, kind: "too_large" };
  const buf = await fs.readFile(real);
  if (looksBinary(buf)) return { ...base, kind: "binary" };
  const result: NodeFileReadResult = { ...base, kind: "text", content: buf.toString("utf8") };
  if (JSON.stringify(result).length > NODE_FILES_RESULT_MAX_CHARS) return { ...base, kind: "too_large" };
  return result;
}
