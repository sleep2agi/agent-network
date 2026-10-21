#!/usr/bin/env node
/**
 * release-backlog.mjs — 「还没发出去的提交」积压（只读）
 *
 * 背景（2026-10-21 发版复盘）：桌面端从「最后一个功能 PR 合入」到「可下载」中位 20.2 分钟，
 * 本身不慢；慢在**决策点**。这个脚本量的是最关键的那个数：**已经合进 main、却还没发出去的
 * 提交有多少、堆了多久**，以及 main 现在绿不绿（绿了却没发，就是「本该发但没人发」）。
 *
 * 它让「为什么慢」有一个每周/每天都能复跑的指标，而不是只活在一次 PPT 里。
 *
 * 只读：只发 GET，不创建/修改任何 release、workflow 或分支。
 *
 * 用法：
 *   node scripts/release-backlog.mjs --repo sleep2agi/agent-network-app [--since-tag desktop-v0.2.282] [--json]
 *   node scripts/release-backlog.mjs --repo sleep2agi/agent-network --since-tag v2.3.0-preview.188
 *
 * 退出码：0 = 没有积压（或者查询失败但没抛）；2 = 用法错误。
 */

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
}

const REPO = arg("repo");
const SINCE_TAG = arg("since-tag", "");
const JSON_OUT = args.includes("--json");
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

if (!REPO) {
  console.error("usage: node release-backlog.mjs --repo owner/name [--since-tag tag] [--json]");
  process.exit(2);
}

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

const days = (ms) => ms / 86_400_000;
const hours = (ms) => ms / 3_600_000;

async function latestRelease() {
  const releases = await api(`/repos/${REPO}/releases?per_page=100`);
  if (!releases) return null;
  const published = releases.filter((r) => !r.draft && r.published_at);
  published.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  return published[0] ?? null;
}

async function mergedSince(sinceIso) {
  const merged = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await api(`/repos/${REPO}/pulls?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`);
    if (!batch || !batch.length) break;
    for (const pr of batch) {
      if (!pr.merged_at) continue;
      if (sinceIso && new Date(pr.merged_at) <= new Date(sinceIso)) return merged;
      merged.push(pr);
    }
    if (batch.length < 100) break;
  }
  return merged;
}

async function mainCi() {
  const sha = await api(`/repos/${REPO}/commits/main`);
  if (!sha) return null;
  const checks = await api(`/repos/${REPO}/commits/${sha.sha}/check-runs?per_page=100`);
  if (!checks) return null;
  const list = checks.check_runs ?? checks;
  const failed = list.filter((c) => c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out");
  const pending = list.filter((c) => c.status !== "completed");
  return { sha: sha.sha, total: list.length, failed: failed.length, pending: pending.length, failedNames: failed.slice(0, 5).map((c) => c.name) };
}

(async () => {
  const release = await latestRelease();
  const sinceIso = SINCE_TAG
    ? (await api(`/repos/${REPO}/releases/tags/${encodeURIComponent(SINCE_TAG)}`))?.published_at
    : release?.published_at ?? null;
  const merged = await mergedSince(sinceIso);
  const ci = await mainCi();
  const now = Date.now();
  const oldest = merged.length ? Math.min(...merged.map((p) => new Date(p.merged_at).getTime())) : null;
  const newest = merged.length ? Math.max(...merged.map((p) => new Date(p.merged_at).getTime())) : null;
  const result = {
    repo: REPO,
    sinceTag: SINCE_TAG || release?.tag_name || null,
    sincePublishedAt: sinceIso,
    mergedCount: merged.length,
    oldestMergeAgeHours: oldest ? Math.round(hours(now - oldest) * 10) / 10 : null,
    newestMergeAgeHours: newest ? Math.round(hours(now - newest) * 10) / 10 : null,
    main: ci ? { sha: ci.sha.slice(0, 10), failed: ci.failed, pending: ci.pending, failedNames: ci.failedNames } : null,
    backlog: merged.slice(0, 20).map((p) => ({ number: p.number, title: p.title.slice(0, 60), mergedAt: p.merged_at })),
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    console.log(`## ${REPO} · 未发版积压（只读）`);
    console.log(`基准版本：${result.sinceTag ?? "（没找到已发布的 release）"} · 发布于 ${result.sincePublishedAt ?? "—"}`);
    console.log(`之后合入的 PR：${result.mergedCount} 条 · 最早一条已等 ${result.oldestMergeAgeHours ?? "—"} 小时 · 最近一条已等 ${result.newestMergeAgeHours ?? "—"} 小时`);
    if (result.main) {
      console.log(`main：${result.main.sha} · 红 ${result.main.failed} · 未完 ${result.main.pending}${result.main.failedNames.length ? ` （${result.main.failedNames.join(" / ")}）` : ""}`);
    }
    if (result.backlog.length) {
      console.log("积压明细（最近 20 条）：");
      for (const b of result.backlog) console.log(`  #${b.number} ${b.mergedAt} ${b.title}`);
    } else {
      console.log("没有积压：上次发布之后没有新的合入。");
    }
    if (result.main && result.main.failed === 0 && result.main.pending === 0 && result.mergedCount > 0) {
      console.log("⇒ main 是绿的、且有已合入的提交没发出去 —— 这就是「本该发但没人发」。");
    }
  }
  process.exit(0);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
