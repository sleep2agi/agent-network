// #1615 —— 四种现实必须给出四句不同的话；drift 那句必须说清「现在没坏，重启才坏」。
import { describe, expect, test } from "bun:test";
import {
  describeGrokBuildDrift,
  parseGrokBuildFromLog,
  parseGrokBuildFromVersionOutput,
} from "./grok-build-drift.js";

const V105 = "grok 1.0.5 (5115b46bc9)";
const V1013 = "grok 1.0.13 (5e9a58528b76)";

describe("#1615 从日志里取版本串", () => {
  // 🔴 这一行取自本机真实节点日志（grok-v1，08-20 启动），不是我编的形状。
  test("认得真实日志里的横幅", () => {
    expect(parseGrokBuildFromLog(`[grok-copresence] using ${V105} ok`)).toBe(V105);
  });
  test("认得 [stable] 后缀（验证清单里那半数键都带它）", () => {
    expect(parseGrokBuildFromLog(`${V105} [stable]`)).toBe(`${V105} [stable]`);
  });
  test("🔴 取**最后一次**，不是第一次 —— 日志追加，最后一次才是最近一次启动", () => {
    expect(parseGrokBuildFromLog(`old ${V105}\nlater ${V1013}\n`)).toBe(V1013);
  });
  test("没有横幅就是 undefined，不编一个", () => {
    expect(parseGrokBuildFromLog("nothing here\n")).toBeUndefined();
    expect(parseGrokBuildFromLog("")).toBeUndefined();
  });
  test("形状不对的不认（防止把别的数字读成版本）", () => {
    expect(parseGrokBuildFromLog("grok 1.0.5")).toBeUndefined();          // 缺 hash
    expect(parseGrokBuildFromLog("grok 1.0.5 (zz)")).toBeUndefined();      // hash 太短/非 hex
    expect(parseGrokBuildFromLog("agent-node 2.5.0 (abcdef)")).toBeUndefined();
  });
  test("--version 输出走同一个解析（同形状，一份实现）", () => {
    expect(parseGrokBuildFromVersionOutput(`${V1013}\n`)).toBe(V1013);
  });
});

describe("#1615 四种现实四句不同的话", () => {
  const match = describeGrokBuildDrift(V105, V105);
  const drift = describeGrokBuildDrift(V105, V1013);
  const noCur = describeGrokBuildDrift(V105, undefined);
  const noStart = describeGrokBuildDrift(undefined, V1013);

  test("kind 四种互不相同", () => {
    expect(new Set([match.kind, drift.kind, noCur.kind, noStart.kind]).size).toBe(4);
  });
  test("文案四句互不相同", () => {
    expect(new Set([match.line, drift.line, noCur.line, noStart.line]).size).toBe(4);
  });
  test("相同 ⇒ match", () => { expect(match.kind).toBe("match"); });

  // 🔴 这条夹具**取自真机**（DEV / grok-v1，2026-08-31）：节点日志里是
  //    `grok 1.0.5 (5115b46bc9)`，而 `grok --version` 现在打的是同一串加 ` [stable]`。
  //    第一版严格串比较把它判成 drift —— 一个每次跑 doctor 都黄的假阳。
  //    18 条单测当时全绿，因为夹具是我造的（1.0.5 vs 1.0.13），**这种组合不在里面**。
  const CHANNEL = `${V105} [stable]`;
  test("🔴 只差频道标签 ⇒ 仍是 match（真机形状，不是我造的）", () => {
    expect(describeGrokBuildDrift(V105, CHANNEL).kind).toBe("match");
    expect(describeGrokBuildDrift(CHANNEL, V105).kind).toBe("match");
  });
  test("但两个原串都要打出来 —— 判据放宽了，展示没有", () => {
    const v = describeGrokBuildDrift(V105, CHANNEL);
    expect(v.line).toContain(V105);
    expect(v.line).toContain("[stable]");
    expect(v.line).toContain("仅频道标签不同");
  });
  test("正控：真不同的版本即使都带 [stable] 也仍是 drift", () => {
    expect(describeGrokBuildDrift(`${V105} [stable]`, `${V1013} [stable]`).kind).toBe("drift");
  });
  test("hash 不同 ⇒ drift（剥的只是频道标签，不是 hash）", () => {
    expect(describeGrokBuildDrift(V105, "grok 1.0.5 (aaaaaaaaa1)").kind).toBe("drift");
  });
  test("不同 ⇒ drift，且两个版本都出现在文案里", () => {
    expect(drift.kind).toBe("drift");
    expect(drift.line).toContain(V105);
    expect(drift.line).toContain(V1013);
  });
  // 🔴 这条是本模块存在的理由：漂移**不是当下故障**。
  //    不说清楚，读的人会去查一个此刻并不存在的问题。
  test("drift 必须说清「当前运行不受影响、下一次重启才会用新的」", () => {
    expect(drift.line).toContain("当前运行不受影响");
    expect(drift.line).toContain("下一次重启");
  });
  test("drift 给出可粘贴的恢复路径（GROK_BINARY）", () => {
    expect(drift.line).toContain("GROK_BINARY=");
  });
  // 🔴 兜底方向：两种「不知道」都不许说成「没问题」。
  test("问不出当前版本 ⇒ unknown-current，且明说这不等于没问题", () => {
    expect(noCur.kind).toBe("unknown-current");
    expect(noCur.line).toContain("不知道");
  });
  test("日志里没有横幅 ⇒ unknown-started，且明说不能当成没问题", () => {
    expect(noStart.kind).toBe("unknown-started");
    expect(noStart.line).toContain("不能当成");
  });
  test("空白串等同缺失，不当成一个版本", () => {
    expect(describeGrokBuildDrift("   ", V1013).kind).toBe("unknown-started");
    expect(describeGrokBuildDrift(V105, "   ").kind).toBe("unknown-current");
  });
});

describe("#1615 不越界：本模块不判合法性", () => {
  const src = require("node:fs").readFileSync(new URL("./grok-build-drift.ts", import.meta.url), "utf8");
  // 🔴 第一版这里只剥了 `//` 与 ` *` 开头的行，漏掉 `/**` 开头的 JSDoc 首行 ——
  //    于是注释里举例的版本串被当成「硬编码清单」判红。剥注释要连块注释一起剥。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l: string) => !l.trim().startsWith("//"))
    .join("\n");

  // 判合法性需要 agent-node 的 GROK_COPRESENCE_VERIFIED_BUILDS。
  // 抄一份进来就是这个仓里的第五份白名单 —— 这条把它做成会红的断言。
  test("代码里没有硬编码的 grok 版本清单", () => {
    expect(/VERIFIED_BUILDS|0\.2\.93|1\.0\.5|1\.0\.13/.test(code)).toBe(false);
  });

  // 🔴 第一版写的是「`agent-node` 这个词不许出现」——太松也太严：
  //    它**正当地**出现在给用户看的文案里（指出验证清单住在哪）。
  //    要判的是**依赖**，不是**文字**：import / require / from "…"。
  test("没有从 agent-node 导入（判的是依赖，不是这个词）", () => {
    expect(/from\s+["'][^"']*agent-node[^"']*["']/.test(code)).toBe(false);
    expect(/require\(\s*["'][^"']*agent-node[^"']*["']\s*\)/.test(code)).toBe(false);
    expect(/import\s*\(\s*["'][^"']*agent-node/.test(code)).toBe(false);
  });

  // 正控：证明上面那条**能**红 —— 否则它可能只是恒真。
  test("正控：一段真的 import 会被上面的判据抓到", () => {
    const fake = 'import { X } from "../../agent-node/src/runtime/grok-copresence/runtime";';
    expect(/from\s+["'][^"']*agent-node[^"']*["']/.test(fake)).toBe(true);
  });
});
