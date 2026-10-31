#!/usr/bin/env node
/**
 * #3177 —— 在**打包时**把构建标识写进制品：`server/build-info.json`。
 *
 * 为什么必须有这一步：生产 runtime 是 `npm install` 出来的（没有 .git），
 * 运行期 `git rev-parse` 永远拿不到东西 ⇒ `/health` 的 build_identified 恒为 false
 * （实测：部署 0.9.0-preview.246 之后仍为 false）。同一版本号、不同字节无法分辨。
 *
 * 判据：**读不到环境就写不写都要说清楚**。CI 用 actions/checkout 的浅克隆，
 * 有 GITHUB_SHA；本地打包则退回 git rev-parse。两者都拿不到时——
 * **不写文件**（⇒ 运行期读到 absent，这是诚实的），而不是写一个假的 commit。
 *
 * 用法：node scripts/write-build-info.mjs [--out <path>]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const outPath = arg("--out") ?? join(pkgRoot, "build-info.json");

const SHA40 = /^[0-9a-f]{40}$/;

function fromEnv() {
  const sha = (process.env.GITHUB_SHA ?? process.env.SOURCE_COMMIT ?? "").toLowerCase();
  if (!SHA40.test(sha)) return null;
  // CI 的 checkout 是干净的（我们只读它）；GITHUB_DEPLOYMENT_DIRTY 仅供人工覆盖。
  const dirty = String(process.env.GITHUB_DEPLOYMENT_DIRTY ?? "false").toLowerCase() === "true";
  return { commit: sha, dirty, source: "ci" };
}

function fromGit() {
  try {
    const commit = execFileSync("git", ["-C", pkgRoot, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    }).toString().trim().toLowerCase();
    if (!SHA40.test(commit)) return null;
    let dirty = false;
    try {
      dirty = execFileSync("git", ["-C", pkgRoot, "status", "--porcelain"], {
        stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
      }).toString().trim().length > 0;
    } catch {
      dirty = true; // 读不到状态 ⇒ 保守认定脏
    }
    return { commit, dirty, source: "git" };
  } catch {
    return null;
  }
}

const picked = fromEnv() ?? fromGit();
if (!picked) {
  // 不写文件：运行期会读到 absent（部署形态的正常状态），而不是一个假的 commit。
  console.error("[build-info] 既没有 GITHUB_SHA/SOURCE_COMMIT，也读不到 git —— **不写 build-info.json**（运行期将报 absent）");
  process.exit(0);
}

const payload = {
  schema: 1,
  commit: picked.commit,
  dirty: picked.dirty,
  built_at: new Date().toISOString(),
  source: picked.source,
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
// ⚠️ 必须走 stderr：这个脚本由 `prepack` 触发，而发布流程用 `npm pack --json` 解析 stdout。
// 实测：写 stdout 一行就把 JSON 前缀污染，`JSON.parse` 失败 ⇒ tarball 名为空 ⇒ 构建 stage 红。
console.error(`[build-info] wrote ${outPath} (commit=${payload.commit.slice(0, 12)} dirty=${payload.dirty} source=${payload.source})`);
