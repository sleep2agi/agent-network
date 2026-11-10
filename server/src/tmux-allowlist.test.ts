// 2026-10-31 —— tmux 端点允许清单的方向钉点。
//
// 为什么单独钉：这是本仓少见的「不匹配 ⇒ 拒绝」路径，判据错了不会报错，
// 只会**静默锁死**（fail-closed），而锁死的成因里有一类是字符串形态不一致：
//   allowlist 人手写 IPv4（1.2.3.4），socket 在双栈监听下给 IPv4-mapped IPv6（::ffff:1.2.3.4）
// ⇒ 同一台机器在两个字符串下被判成两回事。
//
// 反向也要钉（must-fire）：清单里有的公网 IP **必须**被放行——
// 否则「一律拒绝」的实现也能通过所有「拒绝」断言，而那是另一种坏法。
import { describe, expect, test } from "bun:test";
import { ipAllowedBy, normalizeRequestIp } from "./server.js";

const NONE: ReadonlySet<string> = new Set();

describe("tmux allowlist: 空清单的落点与两个方向的判别力", () => {
  test("空清单 = 只允许本机（最严侧），而不是「谁都行」", () => {
    expect(ipAllowedBy("127.0.0.1", NONE)).toBe(true);
    expect(ipAllowedBy("::1", NONE)).toBe(true);
    expect(ipAllowedBy("::ffff:127.0.0.1", NONE)).toBe(true);
    expect(ipAllowedBy("8.8.8.8", NONE)).toBe(false);
    // 拿不到地址时（无 X-Forwarded-For / 无 socket 信息）也是拒绝，不是放行
    expect(ipAllowedBy("unknown", NONE)).toBe(false);
    expect(ipAllowedBy("", NONE)).toBe(false);
  });

  test("清单里有的必须被放行（否则「一律拒绝」也能骗过上面那条）", () => {
    const set = new Set(["1.2.3.4"]);
    expect(ipAllowedBy("1.2.3.4", set)).toBe(true);
    expect(ipAllowedBy("1.2.3.5", set)).toBe(false);
    expect(ipAllowedBy("1.2.3.40", set)).toBe(false); // 前缀不算命中
  });

  test("IPv4-mapped IPv6 与 IPv4 是同一个主机（这一条就是那个静默锁死的补丁）", () => {
    const set = new Set(["1.2.3.4"]);
    expect(ipAllowedBy("::ffff:1.2.3.4", set)).toBe(true);
    expect(normalizeRequestIp("::FFFF:1.2.3.4")).toBe("1.2.3.4");
    // 对称：人手写成 mapped 形式，普通 IPv4 请求也要命中
    const mapped = new Set([normalizeRequestIp("::ffff:5.6.7.8")]);
    expect(ipAllowedBy("5.6.7.8", mapped)).toBe(true);
  });

  test("不做子串/前缀匹配：只有整串相等才算", () => {
    const set = new Set(["10.0.0.1"]);
    expect(ipAllowedBy("10.0.0.10", set)).toBe(false);
    expect(ipAllowedBy("110.0.0.1", set)).toBe(false);
    expect(normalizeRequestIp("  10.0.0.1  ")).toBe("10.0.0.1");
  });
});
