// 2026-11-01 —— #3314 B 类的读数：**故意匿名**的两条路由（register / login）没有身份门，
// 所以它们的健康度只能从「限流与锁定实际命中了几次」看出来。
//
// 为什么要有这个文件，而不是复用 logAudit：
//   logAudit 写的是**事件**，一条一行，回答「刚才谁被拦了」；
//   这里记的是**计数与去重数**，回答的是两个结构性问题：
//     ① register 的限流键是 IP ⇒ 命中数远大于去重 IP 数时，是同一个 IP 在撞；
//        去重 IP 数逼近命中数时，是「换 IP 绕过」在发生（即限流键选错了单位）。
//     ② login 的失败锁定键是**用户名** ⇒ 命中数远大于去重用户名数时，是有人在锁死
//        某一个账号（针对单人的 DoS）；去重用户名数远大于命中数则是撒网。
//   这两个问题都不是「有没有异常」，而是「键选得对不对」——只能用**比值**读出来。
//
// 隐私边界：只暴露计数与去重数，**永不暴露 IP 或用户名的值**。去重集合本身也不导出，
// 只在进程内存在；`distinct_*` 到顶后计数停止增长并置 capped=true，
// 这样「去重数不再涨」这件事本身不会被读成「没有新来源」。
//
// 已知偏差（写在读数旁边，不写在文档里）：
//   · 进程内计数，重启归零 ⇒ 与 /health 的 counters_since 同源，读之前先看 since。
//   · 去重集合有上限（512）⇒ capped=true 时 distinct_* 是**下界**，不是真值。

export const DISTINCT_CAP = 512;

export interface AuthAbuseSnapshot {
  since: string;
  /** register 被 IP 限流拦截的次数 */
  register_rate_limited_total: number;
  /** login 被 IP 速率限制拦截的次数 */
  login_ip_rate_limited_total: number;
  /** login 被「用户名失败锁定」拦截的次数 */
  login_locked_total: number;
  /** 撞过 register 限流的**不同** IP 数（capped 时为下界） */
  distinct_register_limited_ips: number;
  /** 撞过 login IP 限流的**不同** IP 数（capped 时为下界） */
  distinct_login_limited_ips: number;
  /** 被失败锁定拦过的**不同**用户名数（capped 时为下界） */
  distinct_locked_usernames: number;
  /** 任一去重集合是否已到上限 ⇒ distinct_* 只是下界 */
  distinct_capped: boolean;
}

interface State {
  since: string;
  registerRateLimited: number;
  loginIpRateLimited: number;
  loginLocked: number;
  // 两份 IP 集合不是一个：register 的窗口与阈值（30/窗口）与 login 的双速率不同，
  // 合并会让「哪个入口在被撞」变成一个数，而这两个入口的修法相反
  // （register：键是 IP ⇒ 分布式刷注册有效；login：键是 IP + 用户名失败锁定）。
  registerIps: Set<string>;
  loginIps: Set<string>;
  usernames: Set<string>;
  capped: boolean;
}

function fresh(): State {
  return {
    since: new Date().toISOString(),
    registerRateLimited: 0,
    loginIpRateLimited: 0,
    loginLocked: 0,
    registerIps: new Set<string>(),
    loginIps: new Set<string>(),
    usernames: new Set<string>(),
    capped: false,
  };
}

let state: State = fresh();

function addBounded(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  if (set.size >= DISTINCT_CAP) {
    // 到顶不是「没有了」，是「不再数了」—— 所以必须留下 capped 这个痕迹。
    state.capped = true;
    return;
  }
  set.add(value);
}

export function noteRegisterRateLimited(ip: string | null | undefined): void {
  state.registerRateLimited += 1;
  if (ip) addBounded(state.registerIps, ip);
}

export function noteLoginIpRateLimited(ip: string | null | undefined): void {
  state.loginIpRateLimited += 1;
  if (ip) addBounded(state.loginIps, ip);
}

export function noteLoginLocked(username: string | null | undefined): void {
  state.loginLocked += 1;
  if (username) addBounded(state.usernames, username);
}

export function authAbuseSnapshot(): AuthAbuseSnapshot {
  return {
    since: state.since,
    register_rate_limited_total: state.registerRateLimited,
    login_ip_rate_limited_total: state.loginIpRateLimited,
    login_locked_total: state.loginLocked,
    distinct_register_limited_ips: state.registerIps.size,
    distinct_login_limited_ips: state.loginIps.size,
    distinct_locked_usernames: state.usernames.size,
    distinct_capped: state.capped,
  };
}

/** 只在测试里用：把计数清回起点。生产路径不调用。 */
export function __resetAuthAbuseForTest(): void {
  state = fresh();
}
