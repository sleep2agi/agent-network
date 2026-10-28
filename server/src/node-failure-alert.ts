// #2840 —— 节点「假活」告警：连续确定性失败 → 一条人类可见的通知。
//
// 现场（2026-10-28 只读统计）：TMA客户端鲸 因为缺 `DEEPSEEK_KEY`，在 **9 天里失败 1433 次**，
// 期间没有任何告警。节点在线、进程在、版本正常、`get_session_status` 返回 idle，
// 失败只写在任务回执的 result 文本里 —— 巡检若只看状态就会判「没回复 = 没在做」。
//
// 设计约束（用近 7 天生产数据回放校准过，见 #2840）：
//   · **只对确定性错误告警**：缺环境变量 / 二进制缺失 / 登录失效 —— 这类不会自愈，必须人处理。
//     把 `timeout` 也算进去会让 7 天出现 35 条告警（其中 29 条是 timeout），等于制造新噪音源。
//   · 阈值 5 次连续（同节点 + 同类别）。校准结果：只算确定性错误时 7 天 6 条（0.9/天），
//     而 TMA客户端鲸 那 1433 次会被压缩成 5 条 —— 压缩比 287:1。
//   · 同一次故障只告一次：按 (节点, 类别, 首现时刻) 去重；彻底恢复（出现一条成功）后才重新武装。
//   · 走已有 user_inbox 通道（与 schedule_stuck 同一套），不新造通知面。
import { db } from "./db.js";
import { sendAgentNotice } from "./agent-notice.js";

export const NODE_FAILURE_ALERT_KIND = "node_failure_alert";
/** 连续多少次确定性失败才告警。 */
export const ALERT_STREAK_THRESHOLD = 5;
/** 只看这么久以内的任务（更早的失败已经不可操作）。 */
export const SCAN_WINDOW_HOURS = 24;

type Category = "missing_env" | "binary_missing" | "login_required" | "quota_exhausted";

const PATTERNS: Array<{ category: Category; re: RegExp; label: string; hint: string }> = [
  { category: "missing_env", re: /Missing environment variable/i, label: "缺环境变量",
    hint: "在节点所在机器补上该变量后重启节点（anet node start <alias>）" },
  { category: "binary_missing", re: /ENOENT|No such file or directory/i, label: "二进制/文件缺失",
    hint: "检查该节点的运行时是否安装完整，必要时重装后重启节点" },
  { category: "login_required", re: /login required|Unauthorized|\b401\b/i, label: "凭据/登录失效",
    hint: "重新登录该节点（anet node codex login-status 可先自检）" },
  // #2891 —— 额度耗尽：与前三类同性质（不会自愈、必须人处理），但**必须与「限流」分开**。
  //
  // 校准（2026-10-28，近 7 天 2825 条失败）：
  //   provider.quota / usage limit has been reached  → 507 条（占全部失败 18%）
  //   限流类文案（rate limit / 429 / too many requests） → 2 条
  //   ⇒ 宽泛匹配「额度|limit|quota」会到 513，多出来的 6 条是**任务正文在讨论额度**（假阳性），
  //     所以这里只认 provider.quota / usage limit has been reached 这两句原文。
  //
  // 为什么不能把限流并进来：限流会自愈（等几秒重试即可），额度不会。
  // 混成一类会让告警失去「必须人处理」这个唯一有用的性质。
  { category: "quota_exhausted", re: /provider\.quota:\s|usage limit has been reached/i, label: "模型额度耗尽",
    hint: "该节点的上游额度已用完：换 key / 充值 / 换 provider 后重启节点；限流（rate limit）不属此类，会自愈" },
];

/** 只认确定性错误；timeout / 任务内容错误一律返回 null（那类会自愈或与节点无关）。 */
export function classifyDeterministicFailure(result: string | null | undefined): Category | null {
  if (!result) return null;
  for (const p of PATTERNS) if (p.re.test(result)) return p.category;
  return null;
}

export type AlertScanResult = { alerts: number; nodes: string[] };

/**
 * 扫一遍最近的失败，给「连续确定性失败」的节点发一次性告警。
 * 纯读 + 发通知；不改任何任务/排程状态。
 */
export function scanNodeFailureAlerts(now = new Date()): AlertScanResult {
  const since = new Date(now.getTime() - SCAN_WINDOW_HOURS * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const rows = db.all<{ to_name: string; network_id: string | null; created_at: string; status: string; result: string | null }>(
    `SELECT to_name, network_id, created_at, status, result FROM tasks
      WHERE created_at >= ?1 AND to_name IS NOT NULL
      ORDER BY to_name, created_at`,
    since,
  );
  // 按节点切段：streak 只数「连续」——中间出现任何非该类失败的成功/失败都要断开。
  const streaks = new Map<string, { category: Category; count: number; firstAt: string; networkId: string | null; sample: string }>();
  const cur = new Map<string, { category: Category; count: number; firstAt: string }>();
  for (const r of rows) {
    const cat = r.status === "failed" ? classifyDeterministicFailure(r.result) : null;
    const node = r.to_name;
    const prev = cur.get(node);
    if (!cat) {
      // 序列断了：连续计数和「已完成段落」都要清，否则一条成功之后旧段落仍会被告警。
      cur.delete(node);
      streaks.delete(node);
      continue;
    }
    if (prev && prev.category === cat) {
      prev.count += 1;
      streaks.set(node, { category: cat, count: prev.count, firstAt: prev.firstAt, networkId: r.network_id, sample: String(r.result ?? "").slice(0, 200) });
    } else {
      cur.set(node, { category: cat, count: 1, firstAt: r.created_at });
      streaks.delete(node);
    }
  }
  const out: string[] = [];
  for (const [node, s] of streaks) {
    if (s.count < ALERT_STREAK_THRESHOLD) continue;
    const meta = { node, category: s.category, first_seen: s.firstAt };
    const dup = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_inbox WHERE kind = ?1 AND from_session = ?2
        AND json_extract(meta_json, '$.node_failure_alert.category') = ?3
        AND json_extract(meta_json, '$.node_failure_alert.first_seen') = ?4`,
      NODE_FAILURE_ALERT_KIND, node, s.category, s.firstAt,
    )?.n ?? 0;
    if (dup > 0) continue;
    const owner = db.get<{ owner_user_id: string | null }>("SELECT owner_user_id FROM nodes WHERE alias = ?1 AND network_id = ?2", node, s.networkId)?.owner_user_id;
    if (!owner || !s.networkId) continue;
    const label = PATTERNS.find((p) => p.category === s.category)!;
    const sent = sendAgentNotice({
      networkId: s.networkId,
      userId: owner,
      fromAlias: node,
      kind: NODE_FAILURE_ALERT_KIND,
      title: `节点连续失败：${label.label}`,
      text: `${node} 连续 ${s.count} 次以「${label.label}」失败（自 ${s.firstAt} 起）。\n\n最近一次回执节选：\n${s.sample}\n\n处理建议：${label.hint}`,
      severity: "error",
      meta: { node_failure_alert: meta },
      idPrefix: "dm_nfa_",
    });
    if (sent) out.push(node);
  }
  return { alerts: out.length, nodes: out };
}
