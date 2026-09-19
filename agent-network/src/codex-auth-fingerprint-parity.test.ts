import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fingerprintRefreshToken, FINGERPRINT_LENGTH } from "./codex-auth-fingerprint";
import { shortHash } from "./codex-lifecycle-account";

// #1918 —— 这个守卫必须在**两条启动路径**上都生效:`anet node start --copresence`
// 和「自定义脚本直起 agent-node」。实测某 35 台机群里只有 4 台走前者。
// 两个包不能互相 import(agent-node 不依赖 @sleep2agi/agent-network;反向由
// grok-build-drift.test.ts 禁掉),所以照 #1727 的先例:**逐字节复制 + 这道门**。
// 任一边改了而另一边没跟上,这里先红。
const HERE = import.meta.dir;
const AGENT_NODE = join(HERE, "..", "..", "agent-node", "src");
const NAME = "codex-auth-fingerprint.ts";

describe("#1918 the shared-login guard is byte-identical across packages", () => {
  test(NAME, () => {
    const ours = readFileSync(join(HERE, NAME), "utf8");
    const theirs = readFileSync(join(AGENT_NODE, NAME), "utf8");
    expect(ours.length).toBeGreaterThan(500);
    expect(ours).toBe(theirs);
  });

  // The copy can only stay byte-identical if it imports nothing package-local.
  // 🔴 取集只看**行首的 import 语句**:第一版用 /from\s+"…"/ 扫全文,把注释里的
  //    散文 `from "different one"` 也当成了依赖 —— 判据没错,收集错了,而红得
  //    像真缺陷。下面的反控钉住这一点。
  const importSpecs = (src: string): string[] =>
    src.split("\n")
      .map((line) => /^\s*import[^"']*from\s+["']([^"']+)["']/.exec(line)?.[1])
      .filter((spec): spec is string => !!spec);

  test("depends on node builtins only — that is what makes the copy possible", () => {
    const specs = importSpecs(readFileSync(join(HERE, NAME), "utf8"));
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec.startsWith("node:")).toBe(true);
  });

  test("正控/反控:真 import 抓得到,注释里的散文抓不到", () => {
    expect(importSpecs('import { x } from "../other/pkg";')).toEqual(["../other/pkg"]);
    expect(importSpecs(' * tell "same copy" from "different one", not a credential')).toEqual([]);
  });

  // The header claims the hash is the same computation as `shortHash`. Inlining
  // it is what removes the cross-file import; this pins the claim so the two
  // cannot silently diverge.
  test("the inlined hash still equals shortHash over the refresh token", () => {
    const token = "rt-parity-fixture-8f2c";
    const auth = JSON.stringify({ tokens: { refresh_token: token } });
    expect(fingerprintRefreshToken(auth)).toBe(shortHash(token, FINGERPRINT_LENGTH));
  });
});
