import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #893 —— `extract-zip` 有一个**没有补丁版本**的公告(GHSA-jmr9-qjv8-65gv, zip-slip)。
// 2026-09-01 判定它在本产品中**不可达**，依据是安装树里的调用链：
//
//   extract-zip
//     └─ @puppeteer/browsers/lib/cjs/fileUtil.js  `await import('extract-zip')`
//          └─ 只出现在 unpackArchive() 里
//               └─ 全包唯一调用点 install.js  ← 「下载并解压浏览器」那条路
//
//   而 puppeteer-core 里搜 `install(` / `unpackArchive` 是 0 命中；
//   executablePath 不存在时它 **throw**（BrowserLauncher.js），不会转去下载。
//   本仓 0 处 import `@puppeteer/browsers`，且永远显式传 executablePath。
//
// 🔴 这条测试**只钉 lockfile 里的消费者集合** —— 它能发现「又多了一个包会解压 zip」，
//    **发现不了**「puppeteer-core 自己新增了一条自动下载兜底」。后者只有读 node_modules
//    才看得见，而这里读不到 node_modules。升级 puppeteer-core 时**仍需人工重判**。

const LOCK = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package-lock.json"), "utf-8"),
) as { packages?: Record<string, { dependencies?: Record<string, string> }> };

/** 取集：谁把 extract-zip 声明成了自己的依赖。 */
function extractZipConsumers(): string[] {
  const pkgs = LOCK.packages ?? {};
  return Object.keys(pkgs)
    .filter(k => "extract-zip" in (pkgs[k]?.dependencies ?? {}))
    .sort();
}

describe("#893 extract-zip 的可达面没有变宽", () => {
  it("取集正控：lockfile 读到了，且 extract-zip 确实在树里", () => {
    const pkgs = LOCK.packages ?? {};
    expect(Object.keys(pkgs).length).toBeGreaterThan(100);
    expect(Object.keys(pkgs)).toContain("node_modules/extract-zip");
  });

  it("🔴 extract-zip 的消费者有且只有 @puppeteer/browsers", () => {
    // 多出任何一个 ⇒ 上面那条调用链论证不再覆盖全集，必须重判可达性，
    // **不是**把新名字加进这个列表了事。
    expect(extractZipConsumers()).toEqual(["node_modules/@puppeteer/browsers"]);
  });

  it("@puppeteer/browsers 仍然只经 puppeteer-core 进来", () => {
    const pkgs = LOCK.packages ?? {};
    const viaBrowsers = Object.keys(pkgs)
      .filter(k => "@puppeteer/browsers" in (pkgs[k]?.dependencies ?? {}))
      .sort();
    expect(viaBrowsers).toEqual(["node_modules/puppeteer-core"]);
  });

  it("本仓源码从不 import @puppeteer/browsers（那才是会触发下载的入口）", () => {
    const renderer = readFileSync(
      join(import.meta.dir, "im", "feishu", "markdown-image-renderer.ts"),
      "utf-8",
    );
    expect(renderer).not.toContain("@puppeteer/browsers");
    // 选 puppeteer-core + 系统浏览器是**有意**的，不是巧合 —— 钉住这个意图。
    expect(renderer).toContain("executablePath");
  });
});
