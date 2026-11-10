import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VENDOR_HOST_ALLOWLIST as HUB_ALLOW,
  FORBIDDEN_IPV4_RE as HUB_V4,
  FORBIDDEN_IPV6_RE as HUB_V6,
} from "./probe-host-allowlist.js";

// RFC-028 P1 fold-in #1 — hub-and-daemon probe-host-allowlist drift
// guard. Mirrors the G9 reserved-env drift test (RFC-026 §4.4.7).
// Two enforcement modes:
//   1. byte-identical source files
//   2. runtime set-equality of the imported constants (vendor regex
//      source strings + private-IP regex source strings)
// If a future contributor edits one side without the other, this test
// breaks the merge — the daemon-side compromised-hub defense depends
// on the two lists being identical.

const HUB_PATH = join(import.meta.dir, "probe-host-allowlist.ts");
const DAEMON_PATH = join(
  import.meta.dir,
  "..", "..", "..", "agent-node", "src", "shared", "probe-host-allowlist.ts",
);

describe("RFC-028 P1 — hub/daemon probe-host-allowlist drift guard", () => {
  test("byte-identical source files", () => {
    const hub = readFileSync(HUB_PATH, "utf-8");
    const daemon = readFileSync(DAEMON_PATH, "utf-8");
    expect(daemon).toBe(hub);
  });

  test("VENDOR_HOST_ALLOWLIST regex sources equal at runtime", async () => {
    const daemonMod = await import(DAEMON_PATH);
    const daemonAllow = daemonMod.VENDOR_HOST_ALLOWLIST as Record<string, ReadonlyArray<RegExp>>;
    // vendor set equality
    expect(new Set(Object.keys(daemonAllow))).toEqual(new Set(Object.keys(HUB_ALLOW)));
    // per-vendor regex source array equality (order matters — both should
    // be authored in identical order to keep diffs minimal)
    for (const vendor of Object.keys(HUB_ALLOW)) {
      const hubSources = HUB_ALLOW[vendor].map(r => r.source);
      const daemonSources = daemonAllow[vendor].map(r => r.source);
      expect(daemonSources).toEqual(hubSources);
    }
  });

  // 2026-10-31 —— **跨源相等不是内容锁定**（外部复核：「两个 vantage 都得到同一个数不能当成同一读数」）。
  // 下面那条 drift 断言比的是 hub 与 daemon 两份副本：
  // 两边一起改 ⇒ 仍然相等 ⇒ 它绿着，而 SSRF 防线已经变了。
  // ⇒ 再加一层「对着字面量」的身份锁 + 「每条都必须真的能命中」的阳性对照。
  test("private-IP block lists are pinned by identity against literals", () => {
    // ① 身份：逐条 source 相等（不是数量相等）
    expect(HUB_V4.map((r) => r.source)).toEqual([
      "^10\\.",
      "^127\\.",
      "^172\\.(1[6-9]|2[0-9]|3[0-1])\\.",
      "^192\\.168\\.",
      "^169\\.254\\.",
      "^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.",
      "^0\\.",
      "^22[4-9]\\.",
      "^23[0-9]\\.",
      "^24[0-9]\\.",
      "^25[0-5]\\.",
    ]);
    expect(HUB_V6.map((r) => r.source)).toEqual([
      "^::1$",
      "^::$",
      "^fe80:",
      "^fc00:",
      "^fd00:",
    ]);
  });

  test("every private-IP pattern actually fires (a never-matching entry is an empty slot)", () => {
    // ② 阳性对照：清单里每一条都必须能命中至少一个代表地址。
    // 一个永远匹配不到的模式，与「没有这一条」在行为上完全相同 —— 而清单会让人以为它有。
    const v4Samples = ["10.1.2.3", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255"];
    expect(v4Samples).toHaveLength(HUB_V4.length);
    HUB_V4.forEach((re, i) => {
      expect(re.test(v4Samples[i])).toBe(true);
      expect(re.test("8.8.8.8")).toBe(false);   // 每一条都必须**不**命中公网地址
    });
    const v6Samples = ["::1", "::", "fe80::1", "fc00::1", "fd00::1"];
    expect(v6Samples).toHaveLength(HUB_V6.length);
    HUB_V6.forEach((re, i) => {
      expect(re.test(v6Samples[i])).toBe(true);
      expect(re.test("2001:4860:4860::8888")).toBe(false);
    });
  });

  test("FORBIDDEN_IPV4_RE + FORBIDDEN_IPV6_RE sources equal at runtime", async () => {
    const daemonMod = await import(DAEMON_PATH);
    const daemonV4 = (daemonMod.FORBIDDEN_IPV4_RE as ReadonlyArray<RegExp>).map(r => r.source);
    const daemonV6 = (daemonMod.FORBIDDEN_IPV6_RE as ReadonlyArray<RegExp>).map(r => r.source);
    expect(daemonV4).toEqual(HUB_V4.map(r => r.source));
    expect(daemonV6).toEqual(HUB_V6.map(r => r.source));
  });
});
