// #1510 — the switch for the secret-transport gate.
//
//   (unset) / "log" — record what a gate WOULD refuse; refuse nothing.
//   "enforce"       — refuse secret writes to nodes that report `plain`.
//   "off"           — do nothing at all (no recording either).
//
// Reading the env on every call (like the stale-open sweep) means an operator can
// change the mode without a code change and tests can flip it per case.
export type EnvTransportMode = "off" | "log" | "enforce";

export function getEnvTransportMode(env: Record<string, string | undefined> = process.env): EnvTransportMode {
  const raw = (env.ANET_SECRET_TRANSPORT_GATE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "enforce") return "enforce";
  return "log";
}


/**
 * #1510（补「未知」这一档）—— enforce 到底拒什么。
 *
 * 原实现是**拒绝名单**：只拒 `plain`，其余（含 `null` = 从未上报）一律放行。
 * 卡里的口径是**允许名单**：「只有 loopback 或 https 才允许把密钥转发给节点」。
 * 两者在 `null` 上分歧最大，而生产现状是（2026-10-29 只读统计，373 个会话）：
 *
 *   env_transport = NULL      332   ← 89% 从未上报
 *   plain                      33
 *   loopback                    7
 *   https                       1
 *
 * 所以「未知即拒」不能直接当成默认：一打开 enforce 就会拦掉近九成节点。
 * 它必须是一个**额外显式打开**的开关（`ANET_SECRET_TRANSPORT_GATE_STRICT=1`），
 * 让运维在看清「未知有多少」之后自己决定什么时候收紧。
 *
 * 返回值直接就是拒绝原因码，避免调用方各自拼自符串：
 *   "secret_transport_plain"   — 明确是明文公网
 *   "secret_transport_unknown" — 从未上报（仅 strict 下拒）
 *   null                       — 允许
 */
export type SecretTransportVerdict = "secret_transport_plain" | "secret_transport_unknown" | null;

/** 「未知即拒」的显式开关。默认关。 */
export function getEnvTransportStrict(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.ANET_SECRET_TRANSPORT_GATE_STRICT ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function secretTransportVerdict(
  transport: string | null,
  env: Record<string, string | undefined> = process.env,
): SecretTransportVerdict {
  if (getEnvTransportMode(env) !== "enforce") return null;
  if (transport === "plain") return "secret_transport_plain";
  if (transport === "loopback" || transport === "https") return null;
  return getEnvTransportStrict(env) ? "secret_transport_unknown" : null;
}
