// 节点「环境变量」—— 桌面端「节点设置 → 环境变量」(Vincent 2026-09-25:每个节点的环境变量
// 和 token 都在客户端设置里管,节点上其它东西都从这里读)。
//
// 与 rules-file.ts 同一条门铃链路(op = env_list | env_set | env_unset)。存储位置就是节点
// 自己的 config.json 的 `env` 块 —— agent-node 启动时把它注入 process.env(cli.ts),
// `anet node start` 在拉起子进程 / claude 之前也读它(resolveProfileEnv)。所以写进这里的
// 值在**下一次启动**生效,且不依赖任何人手敲的 shell 命令。
//
// 这个文件的边界:
//
//   🔴 1. 值**只写不读**。list 只回 {key, set, length, in_effect, kind};任何函数都不把值
//         放进返回、日志或错误文本。错误一律是本文件自己拼的固定文案(EnvOpError),
//         config.json 解析失败也不带原文(V8 的 JSON 报错会引用一段原文)。
//   🔴 2. 键必须匹配 ENV_KEY_RE,且不在保留名单里(envKeyProblem,纯函数、有测试):
//         会让节点起不来或被劫持的变量(PATH / HOME / NODE_OPTIONS / LD_* / DYLD_* /
//         ANET_* / COMMHUB_* / *_BINARY …)一律拒绝。hub 用同一份规则先挡一遍
//         (server/src/node-env.ts,parity 测试钉住 ENV-KEY-RULES 块逐字节相同)。
//   🔴 3. 写:临时文件(O_EXCL|O_NOFOLLOW, 0600)→ write → fsync → rename → fsync 目录;
//         写之前把旧文件备份成 `.prev`(同 update_node_config)。权限 0600,原文件更严
//         (比如 0400)就保留更严的。拒绝软链接 / 硬链接 / 非本用户的 config.json。
//
// 纯 node: 内建依赖 —— 这份文件在 agent-network/src/node-env.ts 有逐字节相同的副本
// (claude-code 会话的通道进程用),rules-file-parity.test.ts 钉住。

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

// ─── BEGIN ENV-KEY-RULES (byte-identical in server/src/node-env.ts) ───
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const ENV_VALUE_MAX_BYTES = 8 * 1024;

/** 精确名:改了会让节点起不来、换身份,或把别的程序注入进节点进程。 */
const ENV_DENY_EXACT: ReadonlySet<string> = new Set([
  "_",
  // 进程基本面
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "PWD",
  "TMPDIR", "TMP", "TEMP", "HOSTNAME", "IFS",
  // shell / 解释器启动注入
  "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "PERLLIB",
  "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  // TLS 信任根:改了等于允许中间人
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  // agent-node / anet 自己读的身份与运行时选择(cli.ts 在选 runtime 之前合并 config env)
  "ALIAS", "RUNTIME", "MODEL", "CURRENT_TASK_ID",
  // 各运行时的凭据 / 会话目录:改了等于换账号或读别处的 auth.json
  "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR", "TELEGRAM_STATE_DIR",
  // 测试钩子
  "MOCK_LLM_REPLIES_FILE",
]);

/** 前缀:加载器、运行时自有变量、节点身份与 hub 凭据。 */
const ENV_DENY_PREFIXES: readonly string[] = [
  "LD_", "DYLD_", "NODE_", "BUN_", "NPM_CONFIG_", "XDG_", "ANET_", "COMMHUB_",
];

/** 后缀:指向可执行文件的变量(GROK_BINARY、FLOCK_BINARY …)= 换掉节点要执行的程序。 */
const ENV_DENY_SUFFIXES: readonly string[] = ["_BINARY"];

export type EnvKeyProblem = { error: "invalid_env_key" | "reserved_env_key"; reason: string };

/** null = 可以设置;否则说清楚为什么不行。唯一的键规则,hub 与节点共用。 */
export function envKeyProblem(key: unknown): EnvKeyProblem | null {
  if (typeof key !== "string" || !ENV_KEY_RE.test(key)) {
    return { error: "invalid_env_key", reason: "key must match ^[A-Z_][A-Z0-9_]{0,127}$ (upper-case letters, digits, underscore; not starting with a digit)" };
  }
  if (ENV_DENY_EXACT.has(key)) {
    return { error: "reserved_env_key", reason: `${key} is reserved: the node relies on it (changing it could stop the node from starting or hijack it)` };
  }
  for (const p of ENV_DENY_PREFIXES) {
    if (key.startsWith(p)) return { error: "reserved_env_key", reason: `${p}* variables are reserved for the node runtime and its loader` };
  }
  for (const s of ENV_DENY_SUFFIXES) {
    if (key.endsWith(s)) return { error: "reserved_env_key", reason: `*${s} variables choose which program the node runs and are reserved` };
  }
  return null;
}

export type EnvValueProblem = { error: "invalid_env_value"; reason: string };

/** 值:非空字符串,UTF-8 不超过 8 KiB,不含 NUL。报错文案里不含值本身。 */
export function envValueProblem(value: unknown): EnvValueProblem | null {
  if (typeof value !== "string") return { error: "invalid_env_value", reason: "value must be a string" };
  if (value.length === 0) return { error: "invalid_env_value", reason: "value must not be empty (use unset to remove a variable)" };
  if (value.includes("\0")) return { error: "invalid_env_value", reason: "value must not contain NUL" };
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > ENV_VALUE_MAX_BYTES) return { error: "invalid_env_value", reason: `value is ${bytes} bytes, over the ${ENV_VALUE_MAX_BYTES} byte limit` };
  return null;
}
// ─── END ENV-KEY-RULES ───

/** 本文件抛的唯一错误类型;message 全是固定文案,不含值、不含 config 原文。 */
export class EnvOpError extends Error {
  constructor(message: string) { super(message); this.name = "EnvOpError"; }
}

/**
 * 给日志 / ack 用的安全错误文案:本文件自己的错误原样;其它(fs 等)只留 code / name,
 * 不透传 message —— 系统错误文案会带路径,解析错误会带原文。
 */
export function safeEnvErrorMessage(err: unknown): string {
  if (err instanceof EnvOpError) return err.message;
  const code = (err as any)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)) return `config write failed (${code})`;
  return "config write failed";
}

/** 读 / 备份 / 写 config.json 的三个动作,opencode 节点换成它自己的私有写入器。 */
export interface NodeEnvStore {
  read(): string;
  backup(): void;
  write(body: string): void;
}

const O_NOFOLLOW = constants.O_NOFOLLOW || 0;

function checkedConfigStat(file: string) {
  let st;
  try { st = lstatSync(file); } catch (e: any) {
    if (e?.code === "ENOENT") throw new EnvOpError("this node has no config.json to hold environment variables");
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw new EnvOpError("config.json is a link or not a regular file; refusing to write it");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new EnvOpError("config.json is not owned by the node's user; refusing to write it");
  return st;
}

/** 0600,原文件更严就保留更严的(mode & 0600)。 */
export function envConfigMode(existingMode: number | undefined): number {
  if (typeof existingMode !== "number") return 0o600;
  return (existingMode & 0o777) & 0o600;
}

/** 临时文件(O_EXCL|O_NOFOLLOW, 0600)→ write → fchmod → fsync → rename → fsync 目录。 */
export function atomicWritePrivate(file: string, body: string, mode: number): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    const buf = Buffer.from(body, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (process.platform !== "win32") fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  if (process.platform !== "win32") {
    try { const dfd = openSync(dir, constants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch {}
  }
}

/** 默认存储:节点自己的 config.json(拒绝软链接 / 硬链接 / 非本用户)。 */
export function fileEnvStore(configPath: string): NodeEnvStore {
  return {
    read() {
      checkedConfigStat(configPath);
      const fd = openSync(configPath, constants.O_RDONLY | O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) throw new EnvOpError("config.json changed while reading; refusing");
        return readFileSync(fd, "utf8");
      } finally { closeSync(fd); }
    },
    backup() {
      const st = checkedConfigStat(configPath);
      const body = this.read();
      atomicWritePrivate(`${configPath}.prev`, body, envConfigMode(st.mode));
    },
    write(body: string) {
      const st = checkedConfigStat(configPath);
      atomicWritePrivate(configPath, body, envConfigMode(st.mode));
    },
  };
}

function parseConfig(store: NodeEnvStore): Record<string, any> {
  let raw: string;
  raw = store.read();
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { throw new EnvOpError("config.json is not valid JSON; not touching it"); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new EnvOpError("config.json is not a JSON object; not touching it");
  return cfg as Record<string, any>;
}

function envBlock(cfg: Record<string, any>): Record<string, unknown> {
  const e = cfg.env;
  return e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
}

export type EnvRestartMode = "remote" | "manual";

export interface NodeEnvEntry {
  key: string;
  set: true;
  /** 值的字符数(码点);不是值。 */
  length: number;
  /** 这个进程现在的环境里就是这个值(= 上次启动后没改过);false = 要重启才生效,或被启动命令里的同名变量盖住。 */
  in_effect: boolean;
  /** plain = config 里直接存的值;ref = {_envRef} 间接引用(值在别处)。 */
  kind: "plain" | "ref";
  /** 键在保留名单里(手写进 config 的):能看见、不能在这里改。 */
  reserved?: true;
}

export interface NodeEnvListResult {
  keys: NodeEnvEntry[];
  restart: EnvRestartMode;
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function valueInEffect(v: string, current: string | undefined, home: string | undefined): boolean {
  if (current === undefined) return false;
  if (current === v) return true;
  if (home && v.startsWith("~")) {
    // agent-node 的 expandHome(`~` 后面是 / 或结尾)与 anet 启动器的 /^~/ 两种写法都认。
    if (/^~(?=\/|$)/.test(v) && current === v.replace(/^~(?=\/|$)/, home)) return true;
    if (current === v.replace(/^~/, home)) return true;
  }
  return false;
}

/** 只回键和元数据;值不出这个函数。 */
export function listNodeEnv(
  store: NodeEnvStore,
  opts: { processEnv: Record<string, string | undefined>; home?: string; restart: EnvRestartMode },
): NodeEnvListResult {
  const env = envBlock(parseConfig(store));
  const keys: NodeEnvEntry[] = [];
  for (const [key, v] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) continue;
    const reserved = envKeyProblem(key)?.error === "reserved_env_key";
    if (typeof v === "string") {
      keys.push({ key, set: true, length: codePoints(v), in_effect: valueInEffect(v, opts.processEnv[key], opts.home), kind: "plain", ...(reserved ? { reserved: true as const } : {}) });
    } else if (v && typeof v === "object" && typeof (v as any)._envRef === "string") {
      const cur = opts.processEnv[key];
      keys.push({ key, set: true, length: typeof cur === "string" ? codePoints(cur) : 0, in_effect: typeof cur === "string" && cur !== "", kind: "ref", ...(reserved ? { reserved: true as const } : {}) });
    }
  }
  keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { keys, restart: opts.restart };
}

export interface NodeEnvSetResult {
  key: string;
  set: true;
  length: number;
  requires_restart: true;
  restart: EnvRestartMode;
}

export interface NodeEnvUnsetResult {
  key: string;
  set: false;
  existed: boolean;
  requires_restart: boolean;
  restart: EnvRestartMode;
}

/** 写入一个变量:校验 → 备份 .prev → 原子写。返回新的 env 块(给调用方同步内存里的配置)。 */
export function setNodeEnv(
  store: NodeEnvStore,
  key: unknown,
  value: unknown,
  restart: EnvRestartMode,
): { result: NodeEnvSetResult; env: Record<string, unknown> } {
  const kp = envKeyProblem(key);
  if (kp) throw new EnvOpError(`${kp.error}: ${kp.reason}`);
  const vp = envValueProblem(value);
  if (vp) throw new EnvOpError(`${vp.error}: ${vp.reason}`);
  const k = key as string;
  const v = value as string;
  const cfg = parseConfig(store);
  const env = { ...envBlock(cfg), [k]: v };
  cfg.env = env;
  store.backup();
  store.write(JSON.stringify(cfg, null, 2) + "\n");
  return { result: { key: k, set: true, length: codePoints(v), requires_restart: true, restart }, env };
}

/** 删除一个变量;不存在也算成功(existed=false,不写文件)。 */
export function unsetNodeEnv(
  store: NodeEnvStore,
  key: unknown,
  restart: EnvRestartMode,
): { result: NodeEnvUnsetResult; env: Record<string, unknown> | null } {
  const kp = envKeyProblem(key);
  if (kp) throw new EnvOpError(`${kp.error}: ${kp.reason}`);
  const k = key as string;
  const cfg = parseConfig(store);
  const current = envBlock(cfg);
  if (!Object.prototype.hasOwnProperty.call(current, k)) {
    return { result: { key: k, set: false, existed: false, requires_restart: false, restart }, env: null };
  }
  const env = { ...current };
  delete env[k];
  cfg.env = env;
  store.backup();
  store.write(JSON.stringify(cfg, null, 2) + "\n");
  return { result: { key: k, set: false, existed: true, requires_restart: true, restart }, env };
}

/** hub 发来的 env_set / env_unset 请求体:JSON {key, value?}。解析失败不带原文。 */
export function parseEnvRequestContent(content: unknown): { key: unknown; value?: unknown } {
  if (typeof content !== "string") throw new EnvOpError("env request has no body");
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { throw new EnvOpError("env request body is not valid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new EnvOpError("env request body is not an object");
  return { key: parsed.key, ...("value" in parsed ? { value: parsed.value } : {}) };
}
