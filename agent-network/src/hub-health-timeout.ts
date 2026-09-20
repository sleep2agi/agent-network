// 2026-09-16(外部团队在其云主机上起共存节点):`anet node start --copresence` 的 hub 健康探测写死 2000ms,
// 而那台机到 y.vansin.top:9300 的真实响应是 2.1–2.7s(WAN RTT)。超时被当成「hub 没起」,再因为不是
// loopback 走 fatal 分支 —— hub 明明是好的(/health 200)。他靠改 dist 里的常量才起来。
// 规则:loopback 2s 已经很宽;非 loopback 默认 10s;都可用 ANET_HUB_HEALTH_TIMEOUT_MS 覆盖(1000–60000)。
import { isLoopbackHub } from "./copresence-deps";

export const LOOPBACK_HUB_HEALTH_TIMEOUT_MS = 2_000;
export const REMOTE_HUB_HEALTH_TIMEOUT_MS = 10_000;
export const HUB_HEALTH_TIMEOUT_ENV = "ANET_HUB_HEALTH_TIMEOUT_MS";
const MIN_MS = 1_000;
const MAX_MS = 60_000;

export function hubHealthTimeoutMs(hub: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HUB_HEALTH_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_MS && n <= MAX_MS) return Math.floor(n);
  }
  return isLoopbackHub(hub) ? LOOPBACK_HUB_HEALTH_TIMEOUT_MS : REMOTE_HUB_HEALTH_TIMEOUT_MS;
}
