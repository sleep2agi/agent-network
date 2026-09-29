// 节点「运行日志」只读查看 —— 桌面端「节点页 → 运行日志」。
//
// 与 rules-file.ts 同一条门铃链路(op = logs_tail)。请求里只有过滤参数,**没有路径**:
//
//   🔴 1. 读哪个文件由节点自己定:本进程的日志目录(cli.ts LOG_DIR,默认
//         <cwd>/.anet/nodes/<alias>/logs)里的 `YYYY-MM-DD.log`(最新的两天,跨零点时不空),
//         只有在一个日期日志都没有时才退回最新的 `start-*.log`(启动器捕获的 stdout ——
//         日期日志存在时它逐行重复,混进来只会让每行出现两次)。客户端给不了任何路径成分。
//   🔴 2. 返回之前逐行脱敏(redactLogLine):ntok_/utok_、Bearer、Authorization 头、
//         键名含 TOKEN/KEY/SECRET/PASSWORD 的赋值、跟在这类键名后面的长 base64/hex、
//         常见厂商密钥形状、JWT,以及本进程 env / 配置里已知的凭据值(逐字替换)。
//   🔴 3. `grep` 在**脱敏之后**的文本上匹配。反过来的话,grep 就成了一个逐字探测
//         密钥的神谕:命中/不命中本身就泄露了被遮住的那段字符。
//
// 返回给 hub 的只有文件名(不含目录)和脱敏后的行。

import { promises as fs } from "node:fs";
import path from "node:path";
import { collectKnownCredentialValues, createCredentialRedactor, type CredentialRedactor } from "../credential-redaction";

export const LOGS_DEFAULT_LINES = 500;
export const LOGS_MAX_LINES = 2000;
export const LOGS_GREP_MAX = 200;
/** 每个文件最多从尾部读这么多字节 —— 日志可能几十 MB,tail 不需要全读。 */
export const LOGS_TAIL_READ_BYTES = 4 * 1024 * 1024;
/** 回给 hub 的 JSON 上限(hub 端 ack 上限是 1 MiB,留余量给 JSON 转义)。 */
export const LOGS_RESULT_MAX_CHARS = 768 * 1024;
/** 单行最长这么多字符,超出截断(一行 base64 图片能把整个结果挤满)。 */
export const LOGS_LINE_MAX_CHARS = 4000;
export const LOG_REDACTED = "[REDACTED]";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogLevelFilter = "info" | "warn" | "error";

export interface LogsTailParams {
  lines: number;
  level?: LogLevelFilter;
  grep?: string;
  since_ts?: number;
}

export interface LogLine {
  /** 毫秒时间戳;续行(堆栈、多行 JSON)沿用上一行的。认不出时间时为 null。 */
  ts: number | null;
  level: LogLevel | null;
  text: string;
  /** `<文件名>:<字节偏移>` —— 追加写的文件里偏移不变,客户端用它给实时跟随去重。 */
  key: string;
}

export interface LogsTailResult {
  files: string[];
  lines: LogLine[];
  /** 读的范围被字节上限截断,或结果被字符上限截断(更早的行没有带回来)。 */
  truncated: boolean;
  /** 过滤后一共匹配了多少行(可能多于返回的 lines)。 */
  matched: number;
  /** 节点本地时钟,客户端下一轮 since_ts 的兜底起点。 */
  now_ts: number;
}

/** hub 传来的 content(JSON)→ 参数;非法值收成默认,不抛。 */
export function parseLogsTailParams(raw: unknown): LogsTailParams {
  let obj: any = {};
  if (typeof raw === "string" && raw.trim()) {
    try { obj = JSON.parse(raw); } catch { obj = {}; }
  } else if (raw && typeof raw === "object") obj = raw;
  const n = Number(obj?.lines);
  const lines = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), LOGS_MAX_LINES) : LOGS_DEFAULT_LINES;
  const level = obj?.level === "info" || obj?.level === "warn" || obj?.level === "error" ? obj.level : undefined;
  const grep = typeof obj?.grep === "string" && obj.grep.length > 0 ? obj.grep.slice(0, LOGS_GREP_MAX) : undefined;
  const s = Number(obj?.since_ts);
  const since_ts = Number.isFinite(s) && s > 0 ? s : undefined;
  return { lines, ...(level ? { level } : {}), ...(grep ? { grep } : {}), ...(since_ts ? { since_ts } : {}) };
}

// ── 脱敏 ──

// 键名里带这些词就当凭据(比 credential-redaction.ts 的 `_TOKEN` 后缀更宽:日志里常见
// `accessToken` / `api_key` / `x-api-key` 这类小写、驼峰、连字符写法)。
const SECRET_KEY_WORD = "(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|key)";
const KEY_NAME = `[A-Za-z0-9_.-]*${SECRET_KEY_WORD}[A-Za-z0-9_.-]*`;

const EXTRA_PATTERNS: readonly [RegExp, string | ((...m: string[]) => string)][] = [
  // CommHub 凭据:任意长度(基础脱敏要求 ≥ 8 位,短的测试令牌也不放过)。
  [/\b(ntok|utok|atok)_[A-Za-z0-9_-]+/g, (_m, p) => `${p}_${LOG_REDACTED}`],
  // Authorization 头(JSON / HTTP / 对象打印):整段值遮住,不管是 Bearer / Basic / 裸值。
  [/(["']?authorization["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\\r\n])*\2/gi, (_m, pre, q) => `${pre}${q}${LOG_REDACTED}${q}`],
  [/(\bauthorization\s*[:=]\s*)(?!["'])(?:(?:bearer|basic|token|digest)\s+)?[^\s,;}]+/gi, (_m, pre) => `${pre}${LOG_REDACTED}`],
  // Bearer 令牌出现在任何地方。
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, (_m, b) => `${b} ${LOG_REDACTED}`],
  // JWT。
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, LOG_REDACTED],
  // 厂商密钥形状(基础脱敏的 sk- 要求 32 位,这里放宽;xai- / gsk_ / AIza 基础里没有)。
  [/\b(?:sk|xai|gsk)[-_][A-Za-z0-9_-]{16,}/g, LOG_REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, LOG_REDACTED],
  // 键名含 TOKEN/KEY/SECRET/PASSWORD 的赋值 —— 带引号的值。
  [new RegExp(`(["']?)(${KEY_NAME})\\1(\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\4)[^\\\\\\r\\n])*)\\4`, "gi"),
    (_m, kq, key, sep, vq, val) => (val === "" || val.startsWith("[REDACTED") ? _m : `${kq}${key}${kq}${sep}${vq}${LOG_REDACTED}${vq}`)],
  // 同上 —— 裸值(env 行、`key=value`、`key: value`)。
  [new RegExp(`(^|[^A-Za-z0-9_.-])(${KEY_NAME})(\\s*[:=]\\s*)(?!["'\\s])([^\\s,;}\\])"']+)`, "gi"),
    (_m, lead, key, sep, val) => (val.startsWith("[REDACTED") ? _m : `${lead}${key}${sep}${LOG_REDACTED}`)],
  // 跟在这类键名后面(空格分隔)的长 base64 / hex 串:`token abc…`、`key: <40 位 hex>` 已在上面;这里接空格形式。
  [new RegExp(`(^|[^A-Za-z0-9_.-])(${KEY_NAME})(\\s+)([A-Za-z0-9+/_=-]{20,})`, "gi"),
    (_m, lead, key, sp, val) => (val.startsWith("[REDACTED") ? _m : `${lead}${key}${sp}${LOG_REDACTED}`)],
];

export interface LogRedactor {
  redact(line: string): string;
}

/**
 * knownValues:本进程已知的凭据值(节点 token、env 里凭据键的值)——逐字替换,优先于形状规则。
 * env:额外从这张表里收集 —— 键名匹配 /TOKEN|KEY|SECRET|PASSWORD/i 且值 ≥ 8 位的都算。
 */
export function createLogRedactor(opts: { knownValues?: Iterable<string | null | undefined>; env?: Record<string, string | undefined> } = {}): LogRedactor {
  const known = new Set<string>();
  for (const v of opts.knownValues ?? []) if (typeof v === "string" && v.length >= 6) known.add(v);
  if (opts.env) {
    for (const v of collectKnownCredentialValues(opts.env)) if (v.length >= 6) known.add(v);
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === "string" && v.length >= 8 && /TOKEN|KEY|SECRET|PASSWORD/i.test(k)) known.add(v);
    }
  }
  const base: CredentialRedactor = createCredentialRedactor({ knownValues: known, placeholder: LOG_REDACTED });
  return {
    redact(line: string): string {
      let text = base.redactText(line).text;
      for (const [re, rep] of EXTRA_PATTERNS) {
        re.lastIndex = 0;
        text = text.replace(re, rep as any);
      }
      return text;
    },
  };
}

// ── 解析 ──

const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] \[(DEBUG|INFO|WARN|ERROR)\s*\]/;
const DATED_RE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
const START_RE = /^start-.*\.log$/;

/**
 * 日期日志的文件名是 UTC 日期(toISOString),行首时间是**本机时区**的 HH:MM:SS(toTimeString)。
 * 在 UTC 日期前后各一天里找那个本机时刻,取落在该 UTC 日内的那个 —— 零点前后不会差一天。
 * 纯函数(本机时区由 JS Date 决定,测试用 TZ 固定)。
 */
export function lineTimestamp(fileUtcDate: { y: number; m: number; d: number } | null, hh: number, mm: number, ss: number): number | null {
  if (!fileUtcDate) return null;
  const dayStart = Date.UTC(fileUtcDate.y, fileUtcDate.m - 1, fileUtcDate.d);
  const dayEnd = dayStart + 86_400_000;
  let best: number | null = null;
  for (const off of [0, -1, 1]) {
    const base = new Date(dayStart + off * 86_400_000);
    const t = new Date(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm, ss).getTime();
    if (t >= dayStart && t < dayEnd) return t;
    if (best === null) best = t;
  }
  return best;
}

function levelOf(tag: string): LogLevel {
  const t = tag.toLowerCase();
  return t === "warn" || t === "error" || t === "debug" ? t : "info";
}

/** 一段日志文本 → 行(带偏移)。startOffset:这段文本在文件里的起始字节(从尾部读时 > 0,首个半行丢掉)。 */
export function parseLogChunk(fileName: string, chunk: string, startOffset: number): LogLine[] {
  const m = DATED_RE.exec(fileName);
  const date = m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  const out: LogLine[] = [];
  let offset = startOffset;
  let body = chunk.replace(/\r\n/g, "\n");
  if (startOffset > 0) {
    // 从文件中间读起:第一段不完整,丢到第一个换行为止。
    const nl = body.indexOf("\n");
    if (nl < 0) return out;
    offset += Buffer.byteLength(body.slice(0, nl + 1), "utf8");
    body = body.slice(nl + 1);
  }
  let prevTs: number | null = null;
  let prevLevel: LogLevel | null = null;
  const parts = body.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  for (const raw of parts) {
    const key = `${fileName}:${offset}`;
    offset += Buffer.byteLength(raw, "utf8") + 1;
    const lm = LINE_RE.exec(raw);
    if (lm) {
      prevTs = lineTimestamp(date, +lm[1], +lm[2], +lm[3]);
      prevLevel = levelOf(lm[4]);
    }
    out.push({ ts: prevTs, level: prevLevel, text: raw, key });
  }
  return out;
}

/** 过滤 + 截尾。grep 大小写不敏感、在已脱敏文本上匹配(见文件头第 3 条)。 */
export function filterLogLines(lines: readonly LogLine[], p: LogsTailParams): { lines: LogLine[]; matched: number } {
  const needle = p.grep?.toLowerCase();
  const kept = lines.filter((l) => {
    if (p.level && l.level !== p.level) return false;
    if (p.since_ts !== undefined && (l.ts === null || l.ts < p.since_ts)) return false;
    if (needle && !l.text.toLowerCase().includes(needle)) return false;
    return true;
  });
  return { lines: kept.slice(-p.lines), matched: kept.length };
}

/** 本节点的日志文件(只含文件名),按读取顺序(旧 → 新)。 */
export async function nodeLogFiles(logDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const dated = names.filter((n) => DATED_RE.test(n)).sort();
  if (dated.length) return dated.slice(-2);
  const starts: { n: string; t: number }[] = [];
  for (const n of names.filter((x) => START_RE.test(x))) {
    try {
      const st = await fs.lstat(path.join(logDir, n));
      if (st.isFile()) starts.push({ n, t: st.mtimeMs });
    } catch {}
  }
  starts.sort((a, b) => a.t - b.t);
  return starts.length ? [starts[starts.length - 1].n] : [];
}

async function readTail(file: string, maxBytes: number): Promise<{ text: string; start: number; cut: boolean }> {
  const fh = await fs.open(file, "r");
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { text: "", start: 0, cut: false };
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    return { text: buf.subarray(0, got).toString("utf8"), start, cut: start > 0 };
  } finally {
    await fh.close();
  }
}

export async function tailNodeLogs(logDir: string, params: LogsTailParams, redactor: LogRedactor, now: number = Date.now()): Promise<LogsTailResult> {
  const files = await nodeLogFiles(logDir);
  const all: LogLine[] = [];
  let truncated = false;
  for (const name of files) {
    const full = path.join(logDir, name);
    if (path.dirname(full) !== path.resolve(logDir)) continue;
    // 软链接不跟:日志目录里的链接可能指向任何地方。
    const st = await fs.lstat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    const tail = await readTail(full, LOGS_TAIL_READ_BYTES);
    if (tail.cut) truncated = true;
    for (const l of parseLogChunk(name, tail.text, tail.start)) {
      const text = redactor.redact(l.text);
      all.push({ ...l, text: text.length > LOGS_LINE_MAX_CHARS ? `${text.slice(0, LOGS_LINE_MAX_CHARS)} …(截断)` : text });
    }
  }
  const { lines, matched } = filterLogLines(all, params);
  // 结果太大就从最早的那头丢,保证最新的行一定在。
  let size = lines.reduce((n, l) => n + l.text.length + l.key.length + 48, 0);
  let from = 0;
  while (size > LOGS_RESULT_MAX_CHARS && from < lines.length) {
    size -= lines[from].text.length + lines[from].key.length + 48;
    from++;
  }
  if (from > 0) truncated = true;
  return { files, lines: lines.slice(from), truncated: truncated || matched > lines.length, matched, now_ts: now };
}
