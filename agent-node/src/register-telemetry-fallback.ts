// 启动注册不该被一个**可选遥测字段**的形状分歧弄死。
//
// 由 #1225 的诊断催生。实测到的那次：一台没有非回环 IPv4 的机器上，
// `firstNonInternalIPv4()` 返回 null，而当时 hub 的 `host.ip` 只写了
// `.optional()` 没写 `.nullable()`（已由 #1498 修好）。于是
//
//   MCP error -32602: Invalid input: expected string, received null at host.ip
//
// 被抛出，而 `await register()`（cli.ts 顶层、无 catch）让**整个 agent-node
// 进程当场退出**——与 runtime 无关。
//
// #1498 修的是那一次的具体分歧。这里修的是**形状**：hub 与 agent-node 是两个
// 独立发版的包，谁先升谁后升都可能出现「新节点发了旧 hub 不认的遥测字段」或
// 反过来。一个**只用于展示**的字段，不该有能力让节点起不来。
//
// 🔴 但兜底必须窄。判据要求 -32602 **且** 被拒的路径落在可选遥测块里：
//    如果 hub 拒的是 `alias` 这种必需字段，那是这个节点自己的调用有 bug，
//    去掉遥测重试只会把它盖住，让一个真缺陷变成一条 warn 日志。

/** report_status 里纯展示用、可以整块丢掉的字段。 */
export const OPTIONAL_TELEMETRY_KEYS = ["host", "process_telemetry", "external_schedules"] as const;

const INVALID_PARAMS = -32602;

export function isTelemetrySchemaRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code !== INVALID_PARAMS && String(code) !== String(INVALID_PARAMS)) return false;
  const message = String((err as { message?: unknown }).message ?? "");
  if (!message) return false;
  // 路径形如 `at host.ip` / `at process_telemetry.rss_mb`。要求带点号，
  // 这样正文里偶然出现 "host" 这个词不会误判成遥测块被拒。
  return OPTIONAL_TELEMETRY_KEYS.some((key) => message.includes(`${key}.`));
}

/** 去掉可选遥测块之后的那份负载。原对象不改。 */
export function withoutOptionalTelemetry<T extends Record<string, unknown>>(params: T): Partial<T> {
  const out: Record<string, unknown> = { ...params };
  for (const key of OPTIONAL_TELEMETRY_KEYS) delete out[key];
  return out as Partial<T>;
}
