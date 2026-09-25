// 节点「环境变量」—— hub 侧(桌面端「节点设置 → 环境变量」,list_node_env / set_node_env /
// unset_node_env 三个 MCP 工具,见 tools.ts)。
//
// 这个文件放 hub 侧所有的纯规则,每一条都有测试(node-env-transport.test.ts):
//
//   🔴 1. 键 / 值规则(ENV-KEY-RULES 块)与节点侧 agent-node/src/runtime/node-env.ts
//         逐字节相同 —— agent-network/src/rules-file-parity.test.ts 钉住。hub 先挡一遍,
//         节点再挡一遍。
//   🔴 2. 传输闸(classifyRequestTransport):密钥只在两段都不是明文时才转发 ——
//         调用方 → hub 这一段,和 hub → 节点这一段。见 docs-site 的「节点环境变量」一节。
//   🔴 3. 值只写不读:节点的 ack 由 sanitizeEnvAckContent 重建(只留白名单字段),
//         行里的值在 ack 的那一刻清掉(purgeEnvRequestValues 兜底所有其它终态)。

import type { DbAdapter } from "./db-adapter";

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

export type EnvOp = "env_list" | "env_set" | "env_unset";
export const isEnvOp = (op: unknown): op is EnvOp => op === "env_list" || op === "env_set" || op === "env_unset";

// ─── 传输闸 ───────────────────────────────────────────────────────────────
//
// 一段连接只有三种:
//   loopback = 对端 socket 地址是回环 **且** 对方拨的是回环地址(Host 头)—— 同一台机器上直连。
//              只看对端地址不够:frpc 把中继过来的明文连接也从 127.0.0.1 送进来。
//              Host 头就是对方的 hubUrl 里的主机名,中继过来的连接带的是中继的地址。
//   https    = 这条请求本身是 TLS(hub 自己起了 TLS),或者对端是回环、且带
//              `X-Forwarded-Proto: https` —— 本机上的反向代理 / 隧道端点替它终止了 TLS。
//   plain    = 其它一切。
//
// 为什么在回环对端上信 X-Forwarded-Proto(而不是完全不信):hub 目前没有「受信代理」配置,
// 而中继一旦加上 TLS,能告诉 hub「这一段是加密的」的只有这个头。能伪造它的只有两种人:
// 持有有效 token 的调用方自己(他本来就把值明文发出来了,伪造只能坑自己),和明文链路上的
// 主动中间人(他本来就看得见值和 token)。被动窃听者伪造不了。所以这道闸防的是
// 「无意中把密钥走明文」,不是一道授权边界 —— 授权边界是 token + canWrite。
// 不在非回环对端上信这个头:直接连上来的远端说自己是 https,那是在说谎。

export type TransportKind = "loopback" | "https" | "plain";

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim().toLowerCase();
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  const v4 = v.startsWith("::ffff:") ? v.slice(7) : v;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Host 头(可能带端口、IPv6 带方括号)是不是回环地址。 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end < 0) return false;
    h = h.slice(1, end);
  } else {
    const colon = h.lastIndexOf(":");
    if (colon >= 0 && h.indexOf(":") === colon) h = h.slice(0, colon);
  }
  if (h === "localhost") return true;
  return isLoopbackIp(h);
}

export function classifyRequestTransport(input: {
  peerIp?: string | null;
  url?: string | null;
  host?: string | null;
  forwardedProto?: string | null;
}): TransportKind {
  try {
    if (input.url && new URL(input.url).protocol === "https:") return "https";
  } catch {}
  if (!isLoopbackIp(input.peerIp)) return "plain";
  const xfp = (input.forwardedProto || "").split(",")[0].trim().toLowerCase();
  if (xfp === "https") return "https";
  return isLoopbackHost(input.host) ? "loopback" : "plain";
}

export const isSecureTransport = (t: string | null | undefined): boolean => t === "loopback" || t === "https";

export type InsecureTransport = { ok: false; error: "insecure_transport"; leg: "client" | "node"; message: string };

/**
 * 写密钥之前两段都要过:client = 这次调用自己走的那段;node = 目标节点最近一次上报时
 * 走的那段(sessions.env_transport),拉取时 hub 还会按拉取请求本身再判一次。
 */
export function envWriteBlock(clientTransport: string | null | undefined, nodeTransport: string | null | undefined): InsecureTransport | null {
  if (!isSecureTransport(clientTransport)) {
    return {
      ok: false, error: "insecure_transport", leg: "client",
      message: "this request reached the hub over an unencrypted connection; secret values are accepted only over HTTPS or from the hub's own machine",
    };
  }
  if (!isSecureTransport(nodeTransport)) {
    return {
      ok: false, error: "insecure_transport", leg: "node",
      message: "this node reaches the hub over an unencrypted connection (for example a plain-HTTP relay); writing secrets to it is refused until that connection uses HTTPS or the node runs on the hub's machine",
    };
  }
  return null;
}

// ─── 节点回报的清洗 ────────────────────────────────────────────────────────

const ENV_LENGTH_MAX = 1_000_000;
const okLength = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= ENV_LENGTH_MAX;
const restartOf = (r: unknown): "remote" | "manual" => (r === "remote" ? "remote" : "manual");

/**
 * 重建节点的 ack 内容,只留白名单字段;不认识的字段(包括一个出了 bug 的节点可能带回的值)
 * 一律丢掉。null = 形状不对(按失败处理)。
 */
export function sanitizeEnvAckContent(op: EnvOp, content: unknown, expectedKey?: string | null): string | null {
  if (typeof content !== "string") return null;
  let p: any;
  try { p = JSON.parse(content); } catch { return null; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (op === "env_list") {
    if (!Array.isArray(p.keys) || p.keys.length > 1000) return null;
    const keys: Array<Record<string, unknown>> = [];
    for (const k of p.keys) {
      if (!k || typeof k !== "object" || typeof k.key !== "string" || !ENV_KEY_RE.test(k.key) || !okLength(k.length)) continue;
      keys.push({
        key: k.key,
        set: true,
        length: k.length,
        in_effect: k.in_effect === true,
        kind: k.kind === "ref" ? "ref" : "plain",
        ...(k.reserved === true || envKeyProblem(k.key)?.error === "reserved_env_key" ? { reserved: true } : {}),
      });
    }
    return JSON.stringify({ keys, restart: restartOf(p.restart) });
  }
  if (typeof p.key !== "string" || !ENV_KEY_RE.test(p.key)) return null;
  if (expectedKey && p.key !== expectedKey) return null;
  if (op === "env_set") {
    if (!okLength(p.length)) return null;
    return JSON.stringify({ key: p.key, set: true, length: p.length, requires_restart: true, restart: restartOf(p.restart) });
  }
  return JSON.stringify({ key: p.key, set: false, existed: p.existed === true, requires_restart: p.requires_restart === true, restart: restartOf(p.restart) });
}

/** 节点的失败文案里只要出现了值(任何长度),整句换成固定文案。 */
export function withholdIfContainsValue(text: string | null | undefined, value: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  if (value && text.includes(value)) return "env operation failed on the node (message withheld: it contained the value)";
  return text;
}

/** env_set 行 content 里存的是 JSON {key, value};取出来只给 hub 内部用(拉取 / 清洗)。 */
export function envRequestParts(content: string | null | undefined): { key: string | null; value: string | null } {
  if (!content) return { key: null, value: null };
  try {
    const p = JSON.parse(content);
    return { key: typeof p?.key === "string" ? p.key : null, value: typeof p?.value === "string" ? p.value : null };
  } catch { return { key: null, value: null }; }
}

/** 值清掉之后行里留下的内容:只有键(审计 / 排查用)。 */
export const envKeyOnlyContent = (key: string | null): string | null => (key ? JSON.stringify({ key }) : null);

// ─── 行上的值:清除 ────────────────────────────────────────────────────────

export const ENV_REQUEST_STALE_MS = 60_000;

/**
 * 兜底:
 *  (1) 60 s 还没做完的 env 请求 → timeout(节点离线 / 旧版本),
 *  (2) 任何终态的 env_set 行里还留着值 → 只留键。
 * ack / 拉取拒绝 / 超时判定各自当场清;这个函数在入队、拉取、查结果、一次性定时器、
 * 以及 5 分钟的后台定时器里都会跑,所以哪条路径漏了也不会让值在库里过夜。
 */
export function purgeEnvRequestValues(database: DbAdapter, now = Date.now(), staleMs = ENV_REQUEST_STALE_MS): { timedOut: number; purged: number } {
  const t = database.run(
    `UPDATE node_rules_requests SET status = 'timeout', acked_at = ?1,
       error = 'node did not answer within ' || ?2 || 'ms (offline, or its agent-node / channel server is too old for environment variables)'
     WHERE op IN ('env_list', 'env_set', 'env_unset') AND status IN ('pending', 'in_progress')
       AND COALESCE(pulled_at, created_at) < ?3`,
    [now, staleMs, now - staleMs],
  );
  const rows = database.all<{ request_id: string; content: string | null }>(
    `SELECT request_id, content FROM node_rules_requests
     WHERE op = 'env_set' AND status IN ('done', 'failed', 'timeout') AND content LIKE '%"value"%'`,
  );
  for (const r of rows) {
    database.run("UPDATE node_rules_requests SET content = ?1 WHERE request_id = ?2", [envKeyOnlyContent(envRequestParts(r.content).key), r.request_id]);
  }
  return { timedOut: Number(t.changes || 0), purged: rows.length };
}

let envPurgeTimer: ReturnType<typeof setInterval> | null = null;
/** 后台兜底(5 分钟一次,unref);幂等,registerTools 每次调用都可以叫。 */
export function startEnvPurgeTimer(database: DbAdapter): void {
  if (envPurgeTimer) return;
  envPurgeTimer = setInterval(() => { try { purgeEnvRequestValues(database); } catch {} }, 5 * 60_000);
  (envPurgeTimer as any).unref?.();
}
