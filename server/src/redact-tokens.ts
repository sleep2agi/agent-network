// #1459 ③ —— 读取时的 token 形状脱敏（redact-at-read）。
//
// 为什么在**读取**侧而不是写入侧：写入方是 agent，不受信任。存储侧已经走
// normalizeMetaJson（跨主机路径脱敏，与 inbox 一致），那一层防的是"路径泄漏"；
// 这一层防的是"有人把凭据塞进消息正文或 meta"。两层管的不是同一件事。
//
// 🔴 保守优先：宁可漏脱敏一个不像凭据的串，也不要把正常内容改花。所以只匹配
//    几个**有明确前缀**的形状，不做熵检测、不猜。

/** 有明确前缀的凭据形状。
 *
 *  🔴 前缀用**捕获组显式声明**，不靠"切到第一个下划线"之类的推断 ——
 *     第一版就是那么写的，`github_pat_xxx` 被切成了 `github_`，把"这是哪一类
 *     凭据"这个唯一有用的信息也遮掉了。声明比推断短，也不会错。 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(ntok_|utok_|atok_)[A-Za-z0-9_-]{6,}/g,          // 本仓自己的 token
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g,                // GitHub fine-grained PAT（必须排在 ghp_ 之前无关，但更长的前缀先声明更清楚）
  /\b(ghp_)[A-Za-z0-9]{20,}/g,                        // GitHub classic PAT
  /\b(xox[bpoars]-)[A-Za-z0-9-]{10,}/g,               // Slack
  /\b(sk-)[A-Za-z0-9_-]{16,}/g,                       // OpenAI 风格
];

/** 对任意文本做 token 形状脱敏。非字符串原样返回。 */
export function redactTokens<T>(value: T): T {
  if (typeof value !== "string") return value;
  let out: string = value;
  // 保留捕获到的前缀（让读者知道泄漏的是哪一类），其余一律遮掉；不保留尾部 ——
  // 尾部对识别没帮助，却能帮攻击者缩小搜索空间。
  for (const re of TOKEN_PATTERNS) out = out.replace(re, (_m, prefix: string) => `${prefix}***redacted***`);
  return out as unknown as T;
}

/** 对一行消息做脱敏：只碰会承载自由文本的字段，不动 id/时间戳等结构字段。 */
export function redactMessageRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const field of ["content", "title", "meta_json"]) {
    if (typeof out[field] === "string") out[field] = redactTokens(out[field] as string);
  }
  return out as T;
}
