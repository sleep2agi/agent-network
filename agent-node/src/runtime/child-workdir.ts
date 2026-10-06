// app「新建节点」工作目录 —— daemon 侧的解析、校验、落地,以及「这个子节点住在哪」的登记。
//
// 在此之前 create_node 不带目录:子节点永远落在 **daemon 进程的 cwd**/.anet/nodes/<name>,
// 于是它的文件工具看到的是 daemon 所在目录(常常就是 $HOME)里的一切 —— 别的项目、
// 家目录里的密钥。文档一直写「在目标项目目录里建节点,别在 $HOME 建」,但远程创建这条路
// 根本没有地方让人说「在哪」。
//
// 🔴 默认规则 = `<default_workdir_root>/<name>`,root 缺省为 daemon 的 $HOME。
//    为什么是 $HOME 而不是 `$HOME/work` 之类更「整洁」的根:DEV 的开机 sweep
//    (`deploy/fleet/anet-nodes-boot.sh`)只扫 `$HOME/*/.anet`,而这里子节点的 .anet 根
//    **就是**工作目录本身(spawn cwd = workdir,`anet node start` 按 cwd 找 .anet/nodes)。
//    `$HOME/<name>/.anet` 被那个 glob 命中;`$HOME/work/<name>/.anet` 不会 —— 开机不会被拉起。
//    舰队现有节点也都是 `$HOME/<项目>/.anet` 这个形状。改 root 的人要自己知道这一点(文档写了)。
//
// 🔴 请求**不带** workdir 时行为与改动前逐字相同(落 daemon cwd)。默认路径由客户端
//    按 daemon 自报的 `default_workdir_root` 算好、显式发过来 —— 这样老的调用方(Dashboard、
//    脚本、既有 E2E)一个字节都不变,而「默认是什么」对用户是**看得见、能改**的。

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import { atomicWriteJson } from "./config-apply.js";
import { readWorkdirRegistry } from "./adopt-registry.js";

export const MAX_WORKDIR_LEN = 1024;

/** 拒绝的系统目录(本身及其下面)。不是「危险路径」的完整清单 —— 目的是挡住手滑,
 *  真正的边界是 daemon 用户自己的文件权限。 */
const POSIX_SYSTEM_PREFIXES = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc",
  "/run", "/sbin", "/sys", "/usr", "/var",
  // macOS
  "/System", "/Library", "/Applications", "/private/etc", "/private/var",
];

export interface WorkdirEnv {
  home: string;
  platform?: NodeJS.Platform;
}

/** 与 create-node-daemon 的 resolveChildHome 同一个级联,但**不抛** —— 这里只用来算默认值,
 *  算不出就退回 os.homedir()。(不直接 import 那个函数:create-node-daemon 已 import 本文件。) */
export function daemonHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : "") || homedir();
  }
  return env.HOME || homedir();
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export class WorkdirError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "WorkdirError";
  }
}

/** 把用户给的字符串变成绝对路径。只做**字面**处理(展开 `~`、规范化 `..`),不碰磁盘。 */
export function expandWorkdir(raw: unknown, env: WorkdirEnv): string {
  const platform = env.platform ?? process.platform;
  const p = pathApi(platform);
  if (typeof raw !== "string") throw new WorkdirError("workdir_invalid", "not_a_string");
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_WORKDIR_LEN) throw new WorkdirError("workdir_invalid", "length");
  // 控制字符(含 NUL / 换行)一律拒:路径会进日志、进 JSON、进 argv 的 cwd。
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new WorkdirError("workdir_invalid", "control_char");
  let abs: string;
  if (s === "~") {
    abs = env.home;
  } else if (s.startsWith("~/") || (platform === "win32" && s.startsWith("~\\"))) {
    abs = p.join(env.home, s.slice(2));
  } else if (s.startsWith("~")) {
    // `~alice/x` —— 要查别人的家目录,不支持。
    throw new WorkdirError("workdir_invalid", "tilde_user");
  } else if (p.isAbsolute(s) && (platform !== "win32" || /^[A-Za-z]:[\\/]/.test(s))) {
    abs = s;
  } else {
    throw new WorkdirError("workdir_invalid", "not_absolute");
  }
  return p.resolve(abs);
}

function isSameOrUnder(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform);
  const norm = (x: string) => (platform === "win32" ? x.toLowerCase() : x);
  const rel = p.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** 纯字面判据:不是 $HOME、不是 $HOME 的祖先、不是根、不在系统目录下。 */
export function assertWorkdirAllowed(abs: string, env: WorkdirEnv): void {
  const platform = env.platform ?? process.platform;
  const p = pathApi(platform);
  const home = p.resolve(env.home);
  if (p.relative(home, abs) === "") throw new WorkdirError("workdir_is_home");
  // $HOME 的祖先(`/`、`/home`)会把整个家目录收进文件工具的视野,与「就是 $HOME」同罪。
  if (isSameOrUnder(home, abs, platform)) throw new WorkdirError("workdir_is_system_dir", "ancestor_of_home");
  if (platform === "win32") {
    if (/^[A-Za-z]:\\?$/.test(abs)) throw new WorkdirError("workdir_is_system_dir", "drive_root");
    const lower = abs.toLowerCase();
    for (const pre of ["\\windows", "\\program files", "\\program files (x86)", "\\programdata"]) {
      if (isSameOrUnder(lower.slice(2), pre, "win32")) throw new WorkdirError("workdir_is_system_dir");
    }
    return;
  }
  if (abs === "/") throw new WorkdirError("workdir_is_system_dir", "root");
  for (const pre of POSIX_SYSTEM_PREFIXES) {
    if (isSameOrUnder(abs, pre, platform)) throw new WorkdirError("workdir_is_system_dir");
  }
}

/** 目录里已经住着**别的**节点吗?有 `<dir>/.anet/nodes/<别名>/config.json` 就算。
 *  同名的那一格不算 —— 那是本节点自己(重建 / 重试)。 */
export function otherNodeIn(dir: string, name: string): string | null {
  const nodes = join(dir, ".anet", "nodes");
  let entries: string[];
  try { entries = readdirSync(nodes); } catch { return null; }
  for (const e of entries.sort()) {
    if (e === name) continue;
    if (existsSync(join(nodes, e, "config.json"))) return e;
  }
  return null;
}

/** 节点工作目录一律 ASCII(owner 定的规则:别再出现 `~/吉他大师` 这种目录)。
 *
 * 🔴 拒绝而不是警告:警告只会写进 daemon 日志,建节点的人在桌面端看不到;而这条规则没有
 *    例外 —— 拒绝能把原因带回确认页,用户点「改」换个名字就行。
 * 🔴 只看 **$HOME 以下**那一段:家目录本身不归用户在这里选(Windows 上 `C:\Users\<中文名>`
 *    是真实存在的),把它算进去会让那台机器上**每一个**默认路径都被拒。
 *    hub 不做这条:它不知道 daemon 的 $HOME,分不出哪一段是家目录(hub 只判形状)。 */
export function assertWorkdirAscii(abs: string, env: WorkdirEnv): void {
  const platform = env.platform ?? process.platform;
  const p = pathApi(platform);
  const home = p.resolve(env.home);
  const rel = isSameOrUnder(abs, home, platform) ? p.relative(home, abs) : abs;
  const bad = [...rel].find(ch => ch.charCodeAt(0) > 0x7e);
  if (bad !== undefined) throw new WorkdirError("workdir_not_ascii");
}

/** 解析 + 校验 + 落地一个请求里的 workdir。返回 realpath 之后的绝对路径。
 *  新建的目录(含中间层)是 0700;已存在的目录不改权限 —— 那是用户自己的项目。 */
export function prepareChildWorkdir(raw: unknown, name: string, env: WorkdirEnv): string {
  const platform = env.platform ?? process.platform;
  const abs = expandWorkdir(raw, env);
  assertWorkdirAllowed(abs, env);
  assertWorkdirAscii(abs, env);
  if (existsSync(abs)) {
    let st;
    try { st = statSync(abs); } catch (e: any) { throw new WorkdirError("workdir_create_failed", e?.code || "stat"); }
    if (!st.isDirectory()) throw new WorkdirError("workdir_invalid", "not_a_directory");
  } else {
    try { mkdirSync(abs, { recursive: true, mode: 0o700 }); }
    catch (e: any) { throw new WorkdirError("workdir_create_failed", e?.code || "mkdir"); }
  }
  // 字面判据过了之后再按 realpath 判一次:`~/proj` 可能是指向 /etc 的软链。
  let real: string;
  try { real = realpathSync(abs); } catch (e: any) { throw new WorkdirError("workdir_create_failed", e?.code || "realpath"); }
  let realHome = env.home;
  try { realHome = realpathSync(env.home); } catch { /* 家目录不存在:按字面比 */ }
  assertWorkdirAllowed(real, { home: realHome, platform });
  const other = otherNodeIn(real, name);
  if (other) throw new WorkdirError("workdir_has_other_node", other);
  return real;
}

/** daemon 自报给 hub / app 的默认根。配置了 `default_workdir_root` 就用它(可带 `~`),
 *  否则是 daemon 的 $HOME。配置坏了就**不报**(返回 null) —— 让 app 把这一行藏起来,
 *  而不是展示一个 daemon 自己都会拒的路径。 */
export function resolveDefaultWorkdirRoot(fileConfig: any, env: WorkdirEnv): string | null {
  const configured = fileConfig?.default_workdir_root;
  if (configured === undefined || configured === null || configured === "") {
    const p = pathApi(env.platform ?? process.platform);
    const h = env.home ? p.resolve(env.home) : "";
    return h && h.length <= MAX_WORKDIR_LEN ? h : null;
  }
  try {
    const abs = expandWorkdir(configured, env);
    // root 本身可以是 $HOME(默认就是);但不能是系统目录或 $HOME 的祖先。
    const platform = env.platform ?? process.platform;
    const p = pathApi(platform);
    if (p.relative(p.resolve(env.home), abs) !== "") assertWorkdirAllowed(abs, env);
    return abs;
  } catch {
    return null;
  }
}

// ── 登记:子节点不在 daemon cwd 里时,start / delete 要知道去哪找它 ─────────────
//
// start-daemon 与 stop-daemon 原来都从 `<daemon cwd>/.anet/nodes/<alias>` 找子节点。
// 子节点搬到自己的目录后,那里就空了 —— 不登记的话,「停止后再启动」报
// `local_identity: ENOENT`,删除只搬走一个不存在的目录、真正的 config 和 token 原地残留。
// 登记文件与子节点 config 同属 daemon 的 .anet,0600 原子写。

function registryPath(daemonWorkDir: string): string {
  return join(daemonWorkDir, ".anet", "child-workdirs.json");
}

export function readChildWorkdirs(daemonWorkDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(registryPath(daemonWorkDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && isAbsolute(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordChildWorkdir(daemonWorkDir: string, alias: string, workdir: string): void {
  const cur = readWorkdirRegistry(daemonWorkDir);
  if (cur[alias] && typeof cur[alias] !== "string") throw new Error("adopt_registry_conflict");
  if (resolve(workdir) === resolve(daemonWorkDir)) {
    if (!(alias in cur)) return;
    delete cur[alias];
  } else {
    cur[alias] = workdir;
  }
  try { mkdirSync(join(daemonWorkDir, ".anet"), { recursive: true, mode: 0o700 }); } catch { /* ok */ }
  atomicWriteJson(registryPath(daemonWorkDir), cur);
}

export function forgetChildWorkdir(daemonWorkDir: string, alias: string): void {
  const cur = readWorkdirRegistry(daemonWorkDir);
  if (cur[alias] && typeof cur[alias] !== "string") throw new Error("adopt_registry_conflict");
  if (!(alias in cur)) return;
  delete cur[alias];
  atomicWriteJson(registryPath(daemonWorkDir), cur);
}

/** 这个子节点的 .anet 根(= spawn cwd)。没登记 = 老布局,就是 daemon cwd。 */
export function childWorkDirFor(daemonWorkDir: string, alias: string): string {
  const w = readChildWorkdirs(daemonWorkDir)[alias];
  if (!w) return daemonWorkDir;
  // 登记指向的目录没了(被人手动删)就退回老布局,让后面的 config 校验如实报错。
  try { if (lstatSync(w).isDirectory()) return w; } catch { /* fallthrough */ }
  return daemonWorkDir;
}
