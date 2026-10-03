// #516(#502 anet CLI 审计,第 1 片)—— 报错说人话 + 永不打印密钥。
//
// 两件事放在一个模块里,因为它们在同一个出口相遇:顶层 catch 打印的报错文本
// 可能就是一段带 token 的 URL / 请求头 / 配置内容。先脱敏、再分类、最后才打印。
//
// 🔴 退出码不在这里决定(见 cli-exit.ts,#2321):顶层 catch 一律退 1,这里只产文字。
// 🔴 `[anet] FATAL: Error: SOME_CODE` 这一行形状要保留:tests/lib/anet-failure-code.sh
//    靠它从日志里取错误码。所以消息本身就是全大写错误码时,第一行照旧。

// ── 密钥脱敏 ────────────────────────────────────────────────────────────────

// 认得出来的令牌前缀。顺序有意义:长的在前(sk-ant- 要先于 sk-)。
const KNOWN_PREFIXES = [
  "utok_", "ntok_", "atok_", "ptok_",
  "sk-ant-", "sk-proj-", "sk-cp-", "sk-",
  "gsk_", "ghp_", "gho_", "github_pat_", "xox", "AKIA",
];

/**
 * 把一个密钥变成 `<前缀>…<末 4 位>`。
 *   utok_abcdef…(40 字符)…wxyz  →  utok_…wxyz
 * 太短(去掉前缀后不足 12 个字符)时连末 4 位也不给:短密钥露 4 位等于露了一大半。
 */
export function maskSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "(not set)";
  const prefix = KNOWN_PREFIXES.find(p => value.startsWith(p)) ?? "";
  const rest = value.slice(prefix.length);
  if (rest.length < 12) return `${prefix}…`;
  return `${prefix}…${rest.slice(-4)}`;
}

// 文本里的令牌形状:已知前缀 + 一串令牌字符;以及 `Bearer <x>` 和 URL 里的 token= 参数。
const TOKEN_RX = /\b(?:utok_|ntok_|atok_|ptok_|sk-ant-|sk-proj-|sk-cp-|sk-|gsk_|ghp_|gho_|github_pat_)[A-Za-z0-9_\-]{8,}/g;
const BEARER_RX = /\b(Bearer\s+)([A-Za-z0-9._~+\/=\-]{8,})/gi;
const QUERY_RX = /([?&](?:token|access_token|api_key|apikey|key|secret|password)=)([^&#\s"']+)/gi;

/** 把任意文本里看得出的密钥都换成掩码。用在一切「把别处来的字符串打出来」的地方。 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return String(text)
    .replace(TOKEN_RX, m => maskSecret(m))
    .replace(BEARER_RX, (_m, head: string, tok: string) => `${head}${maskSecret(tok)}`)
    .replace(QUERY_RX, (_m, head: string, val: string) => `${head}${maskSecret(val)}`);
}

const SECRET_KEY_RX = /(^|_|-)(token|secret|password|passwd|api_?key|apikey|auth|authorization|credential|private_?key)s?$|^(token|secret|password|authorization)/i;

/** 深拷贝一个对象,键名像密钥的字符串值换成掩码,其余字符串值走 redactSecrets。 */
export function redactSecretFields<T>(value: T): T {
  const walk = (v: any, key: string | null): any => {
    if (typeof v === "string") return key && SECRET_KEY_RX.test(key) ? maskSecret(v) : redactSecrets(v);
    if (Array.isArray(v)) return v.map(x => walk(x, null));
    if (v && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null);
}

// ── 不出现 [object Object] ─────────────────────────────────────────────────

/** 任意「错误」值 → 一句可读文本。对象取 message / error.message / code,实在没有就 JSON。 */
export function errorText(x: unknown): string {
  if (x === null || x === undefined || x === "") return "unknown error";
  if (typeof x === "string") return redactSecrets(x);
  if (x instanceof Error) return redactSecrets(x.message || x.name);
  if (typeof x === "object") {
    const o = x as Record<string, any>;
    if (typeof o.message === "string" && o.message) return redactSecrets(o.message);
    if (o.error !== undefined && o.error !== x) return errorText(o.error);
    if (typeof o.code === "string" || typeof o.code === "number") return String(o.code);
    try { return redactSecrets(JSON.stringify(redactSecretFields(o))); } catch { return "unknown error"; }
  }
  return redactSecrets(String(x));
}

/**
 * Hub 的失败响应体 → 一句话。hub 的 REST 路由回 `{ ok:false, error:"<字符串>" }`,
 * 但 500 兜底(server/src/serve-error.ts)回 `{ error:{ code, message }, message }` ——
 * 直接 `${res.error}` 就是 `[object Object]`。
 */
export function hubErrorText(res: unknown): string {
  if (res && typeof res === "object") {
    const o = res as Record<string, any>;
    if (typeof o.error === "string" && o.error) return redactSecrets(o.error);
    if (o.error && typeof o.error === "object") return errorText(o.error);
    if (typeof o.message === "string" && o.message) return redactSecrets(o.message);
    if (typeof o.status === "number") return `HTTP ${o.status}`;
  }
  return errorText(res);
}

// ── 顶层报错分类 ────────────────────────────────────────────────────────────

export interface CliErrorReport {
  /** 第一行:出了什么事。 */
  summary: string;
  /** 下一步该敲的命令(每条一行)。 */
  next: string[];
  /** 为日志解析保留的 `FATAL: Error: CODE` 形状(只在消息本身是错误码时)。 */
  fatalCode?: string;
}

export function isDebugEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.ANET_DEBUG ?? "";
  return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

const NET_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
  // Bun 的 fetch 用自己的码
  "ConnectionRefused", "FailedToOpenSocket", "ConnectionClosed", "TimeoutError", "ConnectionTimeout",
]);

function errCode(err: any): string | undefined {
  return err?.cause?.code || err?.code || undefined;
}

export function isNetworkError(err: any): boolean {
  if (!err) return false;
  const code = errCode(err);
  if (code && NET_CODES.has(String(code))) return true;
  if (err instanceof TypeError && /fetch failed/i.test(err.message || "")) return true;
  if (/Unable to connect\. Is the computer able to access the url\?/i.test(err?.message || "")) return true;
  return false;
}

function httpStatusOf(err: any): number | undefined {
  const s = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof s === "number") return s;
  const m = /\b(?:HTTP|status)[ :]*([45]\d\d)\b/i.exec(err?.message || "");
  return m ? Number(m[1]) : undefined;
}

export function describeCliError(err: any, ctx: { hub?: string; configPath?: string } = {}): CliErrorReport {
  const message = errorText(err);
  const firstLine = message.split("\n")[0];
  const hub = ctx.hub ? redactSecrets(ctx.hub) : undefined;

  // ① 消息本身就是错误码(NODE_STOP_GENERATION_CHANGED 之类)—— 保留可解析的那一行
  const codeMatch = err instanceof SyntaxError ? null : /^([A-Z][A-Z0-9_]{3,})(?=:|\s*$)/.exec(firstLine);
  // errno 消息(`EACCES: permission denied, open …`)也以大写码开头 —— 那种归 ④ 处理。
  const isErrno = err?.syscall !== undefined || (err?.code !== undefined && String(err.code) === codeMatch?.[1]);
  if (codeMatch && !NET_CODES.has(codeMatch[1]) && !isErrno) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      summary: firstLine,
      fatalCode: `${name}: ${firstLine}`,
      next: ["Re-run with ANET_DEBUG=1 for the full trace, or check the node with: anet doctor"],
    };
  }

  // ② 连不上 hub
  if (isNetworkError(err)) {
    const code = String(errCode(err) || "");
    const where = hub ? ` at ${hub}` : "";
    const timeout = /TIMEOUT|Timeout/.test(code);
    const dns = code === "ENOTFOUND" || code === "EAI_AGAIN";
    return {
      summary: dns
        ? `Cannot resolve the CommHub host${where} (DNS lookup failed).`
        : timeout
          ? `The CommHub hub${where} did not answer in time.`
          : `Cannot connect to the CommHub hub${where}. It is not running or not reachable.`,
      next: [
        "Check the hub: anet hub status   (start a local one: anet hub start)",
        "Point anet at the right hub: anet init --hub <url>",
      ],
    };
  }

  // ③ HTTP 状态
  const status = httpStatusOf(err);
  if (status === 401) return { summary: "The hub rejected your login (401): the token is missing, expired or revoked.", next: ["Log in again: anet login"] };
  if (status === 403) return { summary: "The hub refused this operation (403): your account has no permission for it.", next: ["Check who you are logged in as: anet whoami"] };
  if (status === 404) return { summary: `Not found on the hub (404): ${firstLine}`, next: ["List what exists: anet node ls   (or: anet status)"] };

  // ④ 文件系统
  const code = errCode(err);
  const path = typeof err?.path === "string" ? err.path : undefined;
  if (code === "EACCES" || code === "EPERM") {
    const p = path ?? "a file anet needs";
    return {
      summary: `Permission denied on ${p}.`,
      next: [
        path ? `Check its owner and mode: ls -ld ${shellArg(path)}` : "Check file ownership under ~/.anet",
        "Files under ~/.anet must belong to you (mode 600 for files, 700 for directories), e.g.: chmod 600 ~/.anet/config.json",
      ],
    };
  }
  if (code === "ENOENT") {
    return { summary: `File or directory not found: ${path ?? firstLine}.`, next: ["Check the path; if it is a node, list nodes with: anet node ls"] };
  }
  if (code === "ENOSPC") return { summary: "The disk is full; anet could not write its files.", next: ["Free some space, then retry (check with: df -h ~)"] };
  if (code === "EROFS") return { summary: `The file system is read-only${path ? `: ${path}` : ""}.`, next: ["Run anet from a writable directory / HOME"] };
  if (code === "EADDRINUSE") return { summary: `The port is already in use: ${firstLine}`, next: ["Pick another port with --port <n>, or see what holds it: anet hub status"] };

  // ⑤ JSON 解析失败(配置文件损坏 / hub 回了 HTML)
  if (err instanceof SyntaxError && /JSON|Unexpected token|Unexpected end/i.test(firstLine)) {
    return {
      summary: `anet could not parse a JSON document (a config file is damaged, or the hub returned a non-JSON page): ${firstLine}`,
      next: [
        `Validate your login file: node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/.anet/config.json','utf8'))"`,
        "Then check the hub address: anet config",
      ],
    };
  }

  // ⑥ 其余:一句话 + 下一步
  return {
    summary: firstLine,
    next: ["Re-run with ANET_DEBUG=1 to see the stack trace; for a health check run: anet doctor"],
  };
}

function shellArg(s: string): string {
  return /^[A-Za-z0-9_./~@:+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 顶层 catch 用:产出要打到 stderr 的全部行(已脱敏)。stack 只在 ANET_DEBUG=1 时附上。 */
export function formatTopLevelError(
  err: any,
  opts: { hub?: string; env?: Record<string, string | undefined> } = {},
): string[] {
  const r = describeCliError(err, { hub: opts.hub });
  const lines: string[] = [];
  lines.push(r.fatalCode ? `[anet] FATAL: ${r.fatalCode}` : `[anet] ❌ ${r.summary}`);
  for (const n of r.next) lines.push(`[anet]    ${n}`);
  if (isDebugEnabled(opts.env ?? process.env)) {
    const stack = err?.stack ? String(err.stack) : errorText(err);
    lines.push(redactSecrets(stack));
  } else if (!r.next.some(n => n.includes("ANET_DEBUG"))) {
    lines.push(`[anet]    (set ANET_DEBUG=1 to see the stack trace)`);
  }
  return lines;
}

/** 「连 hub 失败」的原因,一句短语。用在已经写了 `Cannot reach <hub>:` 的地方。 */
export function hubReachReason(err: any): string {
  const code = String(errCode(err) || "");
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "connection refused — nothing is listening at that address";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed — check the host name";
  if (/TIMEOUT|Timeout/.test(code)) return "timed out — check the firewall / proxy";
  if (code === "ECONNRESET" || code === "ConnectionClosed") return "the connection was reset — the hub may be restarting";
  if (err instanceof SyntaxError) return "it answered, but not like a CommHub hub (the reply was not JSON) — check the URL";
  // Node's fetch hides the reason in err.cause (`fetch failed` alone says nothing).
  const cause = err?.cause?.message ? ` (${redactSecrets(String(err.cause.message))})` : "";
  return `${errorText(err)}${cause}`;
}
