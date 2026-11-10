// 2026-10-31 —— 「缺失必须拒绝启动，而不是加兜底」。
//
// 外部复核（原话）：「`FEISHU_REDIRECT_URI` 一词两义 ⇒ 样例部署走兜底、四者一致；
// 修法应是『提成独立字段 + 缺失拒绝启动』，不是加兜底。」
//
// 抽成独立模块的理由是**可测**：启动文件在 import 时就会 process.exit(2)，
// 任何 import 它的测试都会把测试进程自己杀掉（实测过）。判据必须住在能被单独 import 的地方。
export type RequiredEnvResult =
  | { ok: true; hub: string; token: string }
  | { ok: false; missing: string[] };

/**
 * 必填：COMMHUB_URL 与 COMMHUB_TOKEN（兼容名 AUTH_TOKEN）。
 *
 * 空字符串算「没配」——`export COMMHUB_TOKEN=` 是最常见的半配置形态，
 * 它和完全没设一样会让第一次调用失败，但读起来像「配过了」。
 */
export function requireEnv(env: Record<string, string | undefined>): RequiredEnvResult {
  const hub = (env.COMMHUB_URL || "").replace(/\/+$/, "");
  const token = env.COMMHUB_TOKEN || env.AUTH_TOKEN || "";
  const missing: string[] = [];
  if (!hub) missing.push("COMMHUB_URL");
  if (!token) missing.push("COMMHUB_TOKEN（或兼容名 AUTH_TOKEN）");
  if (missing.length) return { ok: false, missing };
  return { ok: true, hub, token };
}
