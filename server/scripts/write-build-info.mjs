#!/usr/bin/env node
/**
 * #3177 —— 在**打包时**把构建标识写进制品：`server/build-info.json`。
 *
 * 为什么必须有这一步：生产 runtime 是 `npm install` 出来的（没有 .git），
 * 运行期 `git rev-parse` 永远拿不到东西 ⇒ `/health` 的 build_identified 恒为 false
 * （实测：部署 0.9.0-preview.246 之后仍为 false）。同一版本号、不同字节无法分辨。
 *
 * 判据：**读不到环境就写不写都要说清楚**。都拿不到时——
 * **不写文件**（⇒ 运行期读到 absent，这是诚实的），而不是写一个假的 commit。
 *
 * 🔴 2026-10-31 —— 优先级反了，实测抓到一次：
 *    release workflow 的 checkout 是 `ref: inputs.commit || github.sha`，
 *    而 `GITHUB_SHA` 永远是**事件**的 sha。所以「指定 commit 发布」时，
 *    被打包的树是 inputs.commit，而 GITHUB_SHA 是分支 HEAD —— 两者可以不同。
 *    实测 agent-network .205：checkout=9bb1a399（日志里 `HEAD is now at 9bb1a3995`），
 *    制品里的 build-info 却写着 644c95cd。**标识说错了自己描述的对象。**
 *
 *    ⇒ 先问 git（它描述的是**这棵树**），再用 GITHUB_SHA 兜底（没 .git 的安装树）；
 *      两者都有且不同 ⇒ 记下 event_sha 并在 stderr 说清楚。
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

// git 优先：`git rev-parse HEAD` 描述的是**这棵树**；GITHUB_SHA 描述的是触发事件。
// 二者在「指定 commit 发布」时必然不同 —— 那时只有前者是真的。
const fromGitRef = fromGit();
const fromEnvRef = fromEnv();
let picked = fromGitRef ?? fromEnvRef;
if (fromGitRef && fromEnvRef && fromGitRef.commit !== fromEnvRef.commit) {
  // 事件 sha 与被打包的树不同：这不是错误（发布时指定了别的 commit），但必须留痕，
  // 否则读制品的人会以为「这次发布的源码就是 main 的 HEAD」。
  picked = { ...fromGitRef, event_sha: fromEnvRef.commit };
  console.error(`[build-info] event sha ${fromEnvRef.commit.slice(0, 12)} ≠ checked-out tree ` +
    `${fromGitRef.commit.slice(0, 12)} —— 记 commit=树, event_sha=事件（制品描述的是前者）`);
}
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
  // 只在「事件 sha ≠ 树」时出现；读侧不依赖它，它是给审计看的。
  ...(picked.event_sha ? { event_sha: picked.event_sha } : {}),
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
// ⚠️ 必须走 stderr：这个脚本由 `prepack` 触发，而发布流程用 `npm pack --json` 解析 stdout。
// 实测：写 stdout 一行就把 JSON 前缀污染，`JSON.parse` 失败 ⇒ tarball 名为空 ⇒ 构建 stage 红。
console.error(`[build-info] wrote ${outPath} (commit=${payload.commit.slice(0, 12)} dirty=${payload.dirty} source=${payload.source})`);
