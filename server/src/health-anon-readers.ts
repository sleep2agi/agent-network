/**
 * 匿名 `/health` 字段的**读者登记表**。
 *
 * 2026-10-31 —— 外部复核 ⑤ 的第 ②′ 问：
 *   「这条信息对匿名读者是**路标**还是**仪表**？路标（往哪打）⇒ 一律不给；仪表（忙不忙）⇒ 可以给聚合。」
 *
 * 本仓已有三分类（landmark / gauge / credential）回答「该不该给」，
 * 但没有回答「**谁在读**」。于是白名单可以无限增长，每一行都写着「watchdog 需要」而没人验证过。
 *
 * ⇒ 每个匿名键必须登记一个读者，且读者是可机械核对的一类：
 *
 *   cli     本仓客户端真的读它（**测试会在 agent-network/src 里逐字找这个名字**）
 *   probe   探针/自检脚本读它（同上，在 scripts/ 里找）
 *   external 仓外读者（监控、负载均衡健康检查、运维手册）—— 仓内无法验证，
 *            所以必须写明「是哪一类外部系统」，并接受「未验」这个事实
 *
 * 判据：**一个白名单条目，如果连读者都指不出来，它就不是「仪表」，而是没人看的暴露面。**
 */
export type AnonReader = "cli" | "probe" | "external";

export interface AnonReaderEntry {
  reader: AnonReader;
  /** 为什么要给匿名读者；external 的必须写清是哪一类系统 */
  why: string;
}

export const PUBLIC_HEALTH_KEY_READERS: Readonly<Record<string, AnonReaderEntry>> = {
  ok: { reader: "cli", why: "CLI/客户端判断「Hub 是否在」的第一位" },
  status: { reader: "cli", why: "客户端展示 Hub 的细分状态（ok / degraded）" },
  status_reasons: { reader: "external", why: "运维与告警规则读它做分级（仓内无消费者，未验）" },
  version: { reader: "cli", why: "版本不一致提示（anet 与 hub 的版本对齐）" },
  version_role: { reader: "external", why: "仓外 dashboard/监控用来区分 hub/cli 构建；仓内无消费者，未验" },
  api_version: { reader: "cli", why: "客户端与 Hub 协商协议版本，不匹配时给出升级提示" },
  transport: { reader: "cli", why: "协议协商（streamable-http）" },
  uptime: { reader: "cli", why: "`anet status` 展示" },
  startedAt: { reader: "cli", why: "展示启动时刻（粗粒度，不是 landmark 的 git_commit）" },
  sessions_count: { reader: "cli", why: "状态面板的连接数" },
  sse_connections: { reader: "cli", why: "状态面板展示当前 SSE 长连接数量" },
  mcp_inflight: { reader: "external", why: "负载均衡/监控判断拥塞；仓内无消费者，未验" },
  mcp_inflight_peak: { reader: "external", why: "监控读 MCP 在途峰值判断拥塞趋势；仓内无消费者，未验" },
  event_loop: { reader: "external", why: "监控读停顿指标；仓内无消费者，未验" },
  auth: { reader: "cli", why: "客户端据此决定登录方式" },
  security: { reader: "cli", why: "客户端据此提示是否需要 TLS/密钥配置" },
  tmux: { reader: "cli", why: "共存 TUI 的前置检查" },
  v3_auth: { reader: "external", why: "老客户端兼容位；仓内无消费者，未验" },
  multi_network: { reader: "cli", why: "多网络客户端据此决定是否显示网络切换" },
  license: { reader: "cli", why: "兼容字段，展示用（判据请用 license_state）" },
  license_state: { reader: "external", why: "监控/合规只读；仓内无消费者，未验" },
  limits: { reader: "cli", why: "上传代理在开流前读它决定单次上传上限" },
  capabilities: { reader: "cli", why: "客户端据此隐藏未实现的功能入口" },
  probe_nonce: { reader: "probe", why: "探针回显：只在带 X-Probe-Nonce 时出现，用于验证同一次请求" },
  served_at: { reader: "probe", why: "响应时刻：探针用它判断两次读数是不是同一次处理的产物" },
  build_identified: { reader: "external", why: "运维判断构建是否可识别；仓内无消费者，未验" },
};
