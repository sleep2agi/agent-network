// #3314 B 类 —— register / login 是**故意匿名**的两条路由（注册与登录本来就发生在
// 有身份之前），所以「有没有身份门」这个判据对它们不成立，它们的健康度只能从
// 「限流与锁定实际命中了几次、打到了几个不同来源」读出来。
//
// 这里钉的不是「计数器会增加」（那是平凡的），而是三件容易写错的事：
//   ① 去重集合到顶后**不再增长但也不清零**，且置 capped —— 否则「新来源不再出现」
//      与「数到上限了」同值，而后者需要人去调上限，前者需要人去查攻击。
//   ② 计数与去重数是**两个数**：命中数 ≫ 去重数 ⇒ 单点重试；两者接近 ⇒ 换 IP / 撒网。
//      只暴露命中数时，这两种完全同形。
//   ③ 快照里**不含** IP 或用户名的值 —— 去重集合只活在进程内。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DISTINCT_CAP,
  __resetAuthAbuseForTest,
  authAbuseSnapshot,
  noteLoginIpRateLimited,
  noteLoginLocked,
  noteRegisterRateLimited,
} from "./auth-abuse-counters.js";

beforeEach(() => __resetAuthAbuseForTest());

test("三条命中路径各自计数，互不串号", () => {
  noteRegisterRateLimited("1.1.1.1");
  noteLoginIpRateLimited("2.2.2.2");
  noteLoginLocked("alice");

  const s = authAbuseSnapshot();
  assert.equal(s.register_rate_limited_total, 1);
  assert.equal(s.login_ip_rate_limited_total, 1);
  assert.equal(s.login_locked_total, 1);
  assert.equal(s.distinct_register_limited_ips, 1);
  assert.equal(s.distinct_login_limited_ips, 1);
  assert.equal(s.distinct_locked_usernames, 1);
  assert.equal(s.distinct_capped, false);
  // register 与 login 的 IP 去重是**两份**：合并会让「哪个入口在被撞」变成一个数，
  // 而两者的修法相反（前者限流键是 IP，后者靠用户名失败锁定）。
});

test("同一来源重复命中：命中数涨，去重数不涨", () => {
  for (let i = 0; i < 5; i++) noteRegisterRateLimited("9.9.9.9");
  const s = authAbuseSnapshot();
  assert.equal(s.register_rate_limited_total, 5);
  assert.equal(s.distinct_register_limited_ips, 1);
  // 这个比值才是读数：5/1 ⇒ 单点重试，不是分布式。
});

test("撒网（每次换来源）：命中数与去重数同步涨", () => {
  for (let i = 0; i < 5; i++) noteRegisterRateLimited(`10.0.0.${i}`);
  const s = authAbuseSnapshot();
  assert.equal(s.register_rate_limited_total, 5);
  assert.equal(s.distinct_register_limited_ips, 5);
  // 5/5 ⇒ 限流键（IP）在这里是有效的；若换用户名做键，这一行就失效。
});

test("锁定命中按用户名去重：一个人被锁多次 = 1", () => {
  for (let i = 0; i < 7; i++) noteLoginLocked("bob");
  noteLoginLocked("carol");
  const s = authAbuseSnapshot();
  assert.equal(s.login_locked_total, 8);
  assert.equal(s.distinct_locked_usernames, 2);
});

test("缺来源（null / undefined / 空串）仍计数，但不污染去重集合", () => {
  noteRegisterRateLimited(null);
  noteRegisterRateLimited(undefined);
  noteRegisterRateLimited("");
  const s = authAbuseSnapshot();
  assert.equal(s.register_rate_limited_total, 3);
  assert.equal(s.distinct_register_limited_ips, 0);
  // 「来源不明」与「一个来源」不是同一个读数 —— 前者说明连 x-forwarded-for 都没有。
});

test("去重集合到顶：distinct 停在上限、capped 置真、命中数继续涨", () => {
  for (let i = 0; i < DISTINCT_CAP + 50; i++) noteRegisterRateLimited(`ip-${i}`);
  const s = authAbuseSnapshot();
  assert.equal(s.distinct_register_limited_ips, DISTINCT_CAP);
  assert.equal(s.distinct_capped, true);
  assert.equal(s.register_rate_limited_total, DISTINCT_CAP + 50);
  // 关键：capped 之后 distinct 是**下界**。没有这一位，「不再有新来源」与
  // 「已经数满了」会显示成同一个数，而它们要做的事相反。
});

test("上限按「有没有真的丢过一条」判，不按「集合是否已满」", () => {
  // 正好填满不是丢：distinct 仍然准确 ⇒ capped 必须是 false。
  for (let i = 0; i < DISTINCT_CAP; i++) noteLoginIpRateLimited(`ip-${i}`);
  let s = authAbuseSnapshot();
  assert.equal(s.distinct_login_limited_ips, DISTINCT_CAP);
  assert.equal(s.distinct_capped, false, "满员但没丢过 ⇒ 这些数还是真值");
  // 再塞一条才会被拒 ⇒ 从这一刻起 distinct 变成下界。
  noteLoginIpRateLimited("ip-overflow");
  s = authAbuseSnapshot();
  assert.equal(s.distinct_login_limited_ips, DISTINCT_CAP);
  assert.equal(s.distinct_capped, true);
  // 且 login 那份满员不影响 register 那份，也不影响用户名那份。
  assert.equal(s.distinct_register_limited_ips, 0);
  assert.equal(s.distinct_locked_usernames, 0);
});

test("快照形状固定（键集是契约，不是实现细节）", () => {
  const keys = Object.keys(authAbuseSnapshot()).sort();
  assert.deepEqual(keys, [
    "distinct_capped",
    "distinct_locked_usernames",
    "distinct_login_limited_ips",
    "distinct_register_limited_ips",
    "login_ip_rate_limited_total",
    "login_locked_total",
    "register_rate_limited_total",
    "since",
  ]);
  // 键集固定 ⇒ 加字段会让这条红。这是有意的：/health 的读者按名字取，
  // 静默改名会让他们读到 undefined 而当作 0。
});

test("快照里没有来源本身（IP / 用户名）", () => {
  noteRegisterRateLimited("203.0.113.7");
  noteLoginLocked("erin");
  const serialized = JSON.stringify(authAbuseSnapshot());
  assert.equal(serialized.includes("203.0.113.7"), false);
  assert.equal(serialized.includes("erin"), false);
  // 计数可以公开，来源不行 —— 与 sessions_count 同一条取舍。
});
