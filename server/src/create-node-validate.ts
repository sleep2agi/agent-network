// RFC-026 v4 §4.2.2 (F2 structured) + §4.4.7 (C1+B1 env_refs) + §4.2.6
// (B2 fork wrapper) — pure validators + arg builder. No DB access. Used
// by hub create_node MCP tool (RPC entry) AND by daemon get_create_request
// (re-check, defense in depth).
//
// All validation errors throw ValidationError with a stable `code` field
// that the MCP tool surface maps to a JSON {ok:false, error: <code>}
// payload (RFC §4.6).

import { isReservedEnvKey } from "./shared/reserved-env.js";

export class ValidationError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(`${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "ValidationError";
  }
}

// §4.2.2 — structural enums.
// #1298 —— daemon 远程创建允许的 runtime。2026-08-28 从 3 个放开到 7 个。
//
// 放开之前挡着的问题是「daemon 建出来的是**无人值守**的后台进程,而三个共存 runtime
// 的本质是人和 agent 共用一个 TUI 会话 —— 建出来给谁用?」
//
// Vincent 2026-08-28 定,理由是**兜底排错**:
//   「某个节点突然不动了,人可以进去看。在 daemon 还没那么靠谱的情况下,
//     这非常重要 —— 至少可以跟 Codex 和 Claude Code 对话。」
// 🔴 关键在于 **attach 是「建好之后」的动作,不是「建的时候」的前提**。
//
// 支撑读数(2026-08-28 实测舰队):`通信牛` 跑 codex-app-server(共存 runtime),
// **764 次成功完成任务**,当天仍在跑 —— 比两个普通 runtime 的节点(61 次 / 3 次)
// 都多一个量级。⇒ 任务链路不需要人坐在屏幕前。
//
// 🔴 这七个名字与 `agent-network/src/normalize-runtime.ts` 的 `RuntimeName` 一致。
//    那边是 CLI 侧的全集;两边分叉过一次(daemon 侧的 VALID_RUNTIMES 早就是 7 个,
//    只有这里还是 3 个,而记录此事的 #1298 正文写的是「三道闸都关着」——
//    **一份快照式的盘点,只在写下的那一刻是真的**)。
export const RUNTIMES = [
  "claude-agent-sdk",
  "claude-code-cli",
  "codex-sdk",
  "codex-app-server",
  "grok-build-acp",
  "grok-build-cli",
  "opencode-cli",
] as const;
export type Runtime = typeof RUNTIMES[number];

// #584 —— `copresence` 是**建节点时**的开关,不是 agent 的运行参数:为 true 时 daemon 把它写成子节点
// config 的 `codexCopresence: true`,之后一条 `anet node start` 就起共享 TUI(app 向导的「Codex（TUI 共存）」)。
// 🔴 故意放在 flags 里而不是 node_spec 顶层:老 hub 的 zod 会静默丢弃未知顶层字段、老 daemon 也静默忽略
//    —— 那正是 #584 的形状(用户选了共存,拿到无头节点,没有任何报错)。flags 的未知键在老 hub(这份
//    FLAG_KEYS)和老 daemon(buildAnetArgsDaemon)都**拒绝**,新 app 撞到老组件得到的是一条报错。
export const FLAG_KEYS = ["permissionMode", "dangerouslySkipPermissions", "maxTurns", "budget", "timeout", "copresence"] as const;

/** #584 —— 只有这些 runtime 认 `flags.copresence`。目前只有 codex-app-server 的共存靠 config 字段
 *  (`codexCopresence`)决定;grok-build-cli / opencode-cli 各有自己的字段,接进来之前一律拒,不静默吞。 */
export const COPRESENCE_FLAG_RUNTIMES = ["codex-app-server"] as const;
export type FlagKey = typeof FLAG_KEYS[number];

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;

// §4.4.7 — env_refs limits.
export const MAX_ENV_KEYS_PER_NODE = 32;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// §4.2.2 name + model.
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
// OpenCode 共存的模型带 provider 前缀(`opencode/mimo-v2.5-free`,agent-node parseModelRef 按第一个 `/` 切),
// 桌面向导 0.2.61 起就发这种形状 —— 允许**恰好一个**斜杠分隔的两段;每段仍是原字符集,且不能是纯点(`..`/`.`)。
const MODEL_SEGMENT = "[a-zA-Z0-9._:\\-]+";
const MODEL_RE = new RegExp(`^${MODEL_SEGMENT}(?:/${MODEL_SEGMENT})?$`);
const MODEL_DOT_ONLY_SEGMENT = /(^|\/)\.+(\/|$)/;

export function validateName(s: unknown): asserts s is string {
  if (typeof s !== "string" || !NAME_RE.test(s)) {
    throw new ValidationError("node_name_invalid", { value: typeof s === "string" ? s.slice(0, 80) : typeof s });
  }
}

export function validateRuntime(s: unknown): asserts s is Runtime {
  if (typeof s !== "string" || !(RUNTIMES as readonly string[]).includes(s)) {
    // 🔴 原来只回一个 `runtime_invalid` + 用户传进来的那个值 —— **不说允许哪些,
    //    也不说还有没有别的路**。2026-08-28 实测:从 Dashboard 建一个
    //    `codex-app-server` 节点,用户拿到的就是
    //      {"ok":false,"error":"runtime_invalid","value":"codex-app-server"}
    //    而目标机器的 daemon 日志里一行都没有(请求根本没到)。
    //    用户无从知道:①哪些是允许的 ②这个名字是不是打错了 ③有没有别的办法。
    //
    // `allowed` 直接由 RUNTIMES 展开,不是手写的第二份清单 ——
    // 🔴 手写一份会漂移,而漂移之后报错会**理直气壮地告诉用户一组错的名字**。
    throw new ValidationError("runtime_invalid", {
      value: typeof s === "string" ? s.slice(0, 80) : typeof s,
      allowed: [...RUNTIMES],
      // 这句提示的前提是查过的:`agent-network/src/normalize-runtime.ts` 的
      // `RuntimeName` / `SUPPORTED_RUNTIME_NAMES` 是 7 个,包含此处不放行的那几个,
      // 所以「在目标机器上直接建」确实是一条真实存在的路,不是安慰话。
      hint: "daemon 远程创建目前只放行以上 runtime；其余 runtime 可以在目标机器上直接 `anet node create --runtime <name>` 创建。",
    });
  }
}

export function validateModel(s: unknown): asserts s is string | undefined | null {
  if (s === undefined || s === null) return;
  if (typeof s !== "string" || s.length === 0 || s.length > 100 || !MODEL_RE.test(s) || MODEL_DOT_ONLY_SEGMENT.test(s)) {
    throw new ValidationError("model_invalid", { value: typeof s === "string" ? s.slice(0, 80) : typeof s });
  }
}

/**
 * #605 —— `flags.timeout` 的单位是**毫秒**:agent-node 就是这么读的(cli.ts currentClaudeTimeoutMs /
 * currentCodexTimeoutMs → util/timeout.ts resolveTimeoutMs、runtime/opencode-timeout.ts,默认 300000)。
 * 这里曾按「秒」收 1..86400:填 600 想要 10 分钟的人拿到 0.6 秒、每个任务都超时;真正的毫秒值被拒。
 *
 * 范围与 update_node_config(config-apply-validate.ts)/ agent-node config-apply 同一把尺子:
 * 0(不设上限)或 TIMEOUT_MS_MIN..TIMEOUT_MS_MAX。1..999 拒绝 —— 旧客户端按秒发的小值分辨不出意图,
 * 不偷偷乘 1000,但也不再让任何人悄悄拿到一个亚秒超时。
 */
export const TIMEOUT_MS_MIN = 1000;
export const TIMEOUT_MS_MAX = 3_600_000;
export const TIMEOUT_MS_REASON =
  `timeout is in milliseconds: 0 (no limit) or an integer ${TIMEOUT_MS_MIN}..${TIMEOUT_MS_MAX} (e.g. 600000 = 10 min)`;
export function isValidTimeoutMs(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= TIMEOUT_MS_MIN && v <= TIMEOUT_MS_MAX));
}

export function validateFlagValue(k: string, v: unknown): void {
  switch (k) {
    case "permissionMode":
      if (typeof v !== "string" || !(PERMISSION_MODES as readonly string[]).includes(v)) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be one of default/acceptEdits/plan/bypassPermissions" });
      }
      return;
    case "dangerouslySkipPermissions":
      if (typeof v !== "boolean") throw new ValidationError("flag_value_invalid", { field: k, reason: "must be boolean" });
      return;
    case "maxTurns":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be integer 1..9999" });
      }
      return;
    case "budget":
      if (typeof v !== "number" || !Number.isFinite(v) || (v as number) < 0 || (v as number) > 1000) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be number 0..1000 (decimals OK)" });
      }
      return;
    case "timeout":
      if (!isValidTimeoutMs(v)) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: TIMEOUT_MS_REASON });
      }
      return;
    case "copresence":
      if (typeof v !== "boolean") throw new ValidationError("flag_value_invalid", { field: k, reason: "must be boolean" });
      return;
    default:
      throw new ValidationError("flag_key_unknown", { field: k });
  }
}

/** #584 —— 逐键校验之外的跨字段一条:`copresence` 只对 COPRESENCE_FLAG_RUNTIMES 有意义。
 *  在别的 runtime 上收下它而什么都不做,就是又一个「选了共存、拿到无头」。 */
export function validateFlagsForRuntime(runtime: string, flags: Record<string, unknown> | undefined | null): void {
  if (!flags || !Object.prototype.hasOwnProperty.call(flags, "copresence")) return;
  if (!(COPRESENCE_FLAG_RUNTIMES as readonly string[]).includes(runtime)) {
    throw new ValidationError("flag_not_applicable_to_runtime", {
      field: "copresence", runtime, applicable: [...COPRESENCE_FLAG_RUNTIMES],
    });
  }
}

// §4.4.7 — env_refs 7-step gate. networkSecretsGet is injected so
// callers can supply either a real DB lookup (hub) or a fixture (tests).
// The 6th step also reports the resolved value size; we return the
// resolved-but-not-yet-used map keyed by env-key so the caller can build
// env_blob without re-querying.
export interface EnvRefsContext {
  callerNetworkId: string;
  daemonAllowList: ReadonlySet<string>;
  networkSecretsGet: (networkId: string, key: string) => string | undefined;
}
export function validateEnvRefs(
  refs: unknown,
  ctx: EnvRefsContext,
): Record<string, string> {
  if (!Array.isArray(refs)) {
    if (refs === undefined || refs === null) return {};
    throw new ValidationError("env_refs_invalid", { reason: "must be array" });
  }
  // ① regex
  for (const k of refs) {
    if (typeof k !== "string" || !ENV_KEY_RE.test(k)) {
      throw new ValidationError("env_key_invalid", { key: typeof k === "string" ? k.slice(0, 64) : typeof k });
    }
  }
  // ② reserved denylist (v4 B1)
  for (const k of refs) {
    if (isReservedEnvKey(k)) {
      throw new ValidationError("env_key_reserved", { key: k });
    }
  }
  // ③ duplicate detection (must come before ④ count gate to give a
  //    truthful error code rather than "too many" for dup-spam).
  const seen = new Set<string>();
  for (const k of refs as string[]) {
    if (seen.has(k)) throw new ValidationError("env_key_duplicate", { key: k });
    seen.add(k);
  }
  // ④ count cap
  if (seen.size > MAX_ENV_KEYS_PER_NODE) {
    throw new ValidationError("env_key_too_many", { count: seen.size, max: MAX_ENV_KEYS_PER_NODE });
  }
  const out: Record<string, string> = {};
  // ⑤ vault presence + ⑥ value size cap
  for (const k of seen) {
    const v = ctx.networkSecretsGet(ctx.callerNetworkId, k);
    if (v === undefined) throw new ValidationError("secret_not_in_vault", { key: k });
    if (Buffer.byteLength(v, "utf8") > MAX_ENV_VALUE_BYTES) {
      throw new ValidationError("secret_too_large", { key: k, max: MAX_ENV_VALUE_BYTES });
    }
    out[k] = v;
  }
  // ⑦ daemon allowlist (per-host whitelist of which secrets this
  //    machine is allowed to receive; declared in daemon config by the
  //    host operator)
  for (const k of seen) {
    if (!ctx.daemonAllowList.has(k)) {
      throw new ValidationError("secret_not_in_daemon_allowlist", { key: k });
    }
  }
  return out;
}

// §4.4.7 — safe serializer for .env.local. Dotenv-quoted with escape
// for backslash / double-quote / newline / carriage-return so that a
// value containing `\n"evil=KEY2"` cannot pollute the next line.
export function serializeEnvLocal(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => {
    const esc = String(v)
      .replace(/\\/g, "\\\\")   // 1) backslashes first (or later escapes get un-escaped)
      .replace(/"/g, '\\"')     // 2) double-quotes
      .replace(/\n/g, "\\n")    // 3) newline → literal \n
      .replace(/\r/g, "\\r");   // 4) carriage return → literal \r
    return `${k}="${esc}"`;
  }).join("\n") + "\n";
}

// app「新建节点」工作目录 —— hub 只判**形状**(daemon 才知道那台机器的 $HOME、系统目录、
// 目录里住没住别的节点,那几条在 agent-node/src/runtime/child-workdir.ts)。
// 这里挡的是「根本不像一条路径」的输入,让它在派发前就失败,而不是占一个请求行再被 daemon 拒。
export const MAX_WORKDIR_LEN = 1024;
export function validateWorkdir(s: unknown): asserts s is string | undefined | null {
  if (s === undefined || s === null) return;
  if (typeof s !== "string") throw new ValidationError("workdir_invalid", { reason: "must be string" });
  const v = s.trim();
  if (v.length === 0 || v.length > MAX_WORKDIR_LEN) {
    throw new ValidationError("workdir_invalid", { reason: `length 1..${MAX_WORKDIR_LEN}` });
  }
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new ValidationError("workdir_invalid", { reason: "control character" });
  const shapeOk = v.startsWith("/") || v === "~" || v.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(v);
  if (!shapeOk) {
    throw new ValidationError("workdir_invalid", { reason: "must be absolute (/…, ~/…, or C:\\…)", value: v.slice(0, 80) });
  }
}

/** daemon 自报的默认工作目录根(`daemon_capabilities.default_workdir_root`),消毒后返回;
 *  没报 / 形状不对 = null。**非 null 即表示该 daemon 认 `node_spec.workdir`** ——
 *  create_node 的「老 daemon 不收 workdir」门和 /api/host-supervisors 的透出共用这一个判据。 */
export function daemonDefaultWorkdirRoot(configSnapshot: unknown): string | null {
  try {
    const snap = typeof configSnapshot === "string" ? JSON.parse(configSnapshot) : configSnapshot;
    const v = (snap as any)?.daemon_capabilities?.default_workdir_root;
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_WORKDIR_LEN) return null;
    if (/[\u0000-\u001f\u007f]/.test(v)) return null;
    if (!(v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v))) return null;
    return v;
  } catch {
    return null;
  }
}

// §4.2.5 — channels fail-closed in P1.
export function validateChannelsP1(channels: unknown): void {
  if (channels === undefined || channels === null) return;
  if (!Array.isArray(channels)) {
    throw new ValidationError("channels_not_supported_in_p1", { reason: "expected array or omitted" });
  }
  if (channels.length > 0) {
    throw new ValidationError("channels_not_supported_in_p1", { received: channels.length, p3_tracker: "RFC-026 §5 P3" });
  }
}

// §4.2.2 — fully validated NodeSpec, ready to feed into buildAnetArgs.
export interface NodeSpec {
  name: string;
  runtime: Runtime;
  model?: string | null;
  flags?: Record<string, unknown>;
  channels?: unknown;
}

// kebab-case helper for flag names. permissionMode → permission-mode.
function kebab(k: string): string {
  return k.replace(/([A-Z])/g, "-$1").toLowerCase();
}

// §4.2.2 — build the argv that gets fed verbatim to execFile (no
// shell, no string concat). Each value has already passed type/enum
// validation, so String() coercion is safe.
export function buildAnetArgs(spec: NodeSpec): string[] {
  validateName(spec.name);
  validateRuntime(spec.runtime);
  validateModel(spec.model);
  validateChannelsP1(spec.channels);

  const args: string[] = ["node", "create", spec.name, "--runtime", spec.runtime];
  if (spec.model) args.push("--model", spec.model);
  if (spec.flags && typeof spec.flags === "object") {
    for (const [k, v] of Object.entries(spec.flags)) {
      if (!(FLAG_KEYS as readonly string[]).includes(k)) {
        throw new ValidationError("flag_key_unknown", { field: k });
      }
      validateFlagValue(k, v);
      // `anet node create --copresence` 是布尔开关,不吃值。
      if (k === "copresence") { if (v === true) args.push("--copresence"); continue; }
      args.push(`--${kebab(k)}`, String(v));
    }
    validateFlagsForRuntime(spec.runtime, spec.flags);
  }
  return args;
}
