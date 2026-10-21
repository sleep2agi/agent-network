// #1510 —— 节点向 Hub 报告「我是怎么连到 Hub 的」。
//
// Hub 侧已经准备好了传输闸门:`report_status` 的 schema 里有 `env_transport`
// (loopback / https / plain),Hub 存进 `sessions.env_transport`;`server/src/env-transport-gate.ts`
// 在 log 模式下统计「如果闸门开着,哪些密钥写入会被拒」。
//
// 但**节点从来没报过这一格** —— 我在现网 hub 上核过:`sessions.env_transport`
// 369 行全是 NULL,`env_transport_would_refuse` 表 0 行。所以闸门既没有判据,
// 也没有数据(0 行不等于安全,只等于「transport 未知,闸门直接放行」)。
//
// 这一格是纯事实:节点自己知道它连 Hub 用的是什么链接形态。
//   * loopback —— Hub 在本机(127.0.0.1 / localhost / ::1)
//   * https   —— 加密链路
//   * plain   —— 明文 http 到别处(公网明文)
// 每次上报都带 ⇒ Hub 侧「每份 report 重新测一次」的要求自然满足。
export type EnvTransport = "loopback" | "https" | "plain";

export function envTransportFor(hubUrl: string): EnvTransport {
  let url: URL;
  try {
    url = new URL(hubUrl);
  } catch {
    return "plain";
  }
  if (url.protocol === "https:") return "https";
  if (url.protocol !== "http:") return "plain";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host)) return "loopback";
  return "plain";
}
