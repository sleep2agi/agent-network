#!/usr/bin/env node
/**
 * npm-release-probe.mjs — 只读「publish 之后到底可见没可见」探针
 *
 * 背景（#2844/#2845）：CI 的 publish 步骤 success ≠ 用户在 registry 拿得到。
 *   - staged 发布要人工批准（2FA），没批就永远 404，但 CI 是绿的；
 *   - npm 处理有延迟，SOP 之前靠「等 45 分钟」+ 人肉轮询。
 * 这个脚本只做一件事：对某个包/版本轮询 registry，给出
 *   visible | staged | error，以及等了多久、dist-tags 现在指向谁。
 *
 * 只读：只发 GET，不 publish、不写任何东西。
 *
 * 用法：
 *   node npm-release-probe.mjs --pkg @sleep2agi/agent-network
 *   node npm-release-probe.mjs --pkg @sleep2agi/agent-node --version 2.5.0-preview.151
 *   node npm-release-probe.mjs --pkg @sleep2agi/agent-network --channel preview --timeout 20m
 *   node npm-release-probe.mjs --pkg ... --once --json
 *
 * 退出码：0 = visible；1 = 超时仍未可见（staged/延迟）；2 = 用法或网络错误。
 */

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
}
function dur(s, dfltMs) {
  if (!s) return dfltMs;
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) return dfltMs;
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]];
}

const PKG = arg("pkg");
const VERSION = arg("version");
const CHANNEL = arg("channel", "preview");
const TIMEOUT_MS = dur(arg("timeout", "15m"), 15 * 60000);
const INTERVAL_MS = dur(arg("interval", "20s"), 20000);
const ONCE = args.includes("--once");
const JSON_OUT = args.includes("--json");

if (!PKG) {
  console.error("usage: node npm-release-probe.mjs --pkg <name> [--version v] [--channel preview] [--timeout 15m] [--interval 20s] [--once] [--json]");
  process.exit(2);
}

const enc = encodeURIComponent(PKG);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`https://registry.npmjs.org${path}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) return { status: res.status, body: null, error: `HTTP ${res.status}` };
  return { status: res.status, body: await res.json() };
}

/** 文档：一次采样 = 版本是否存在 + dist-tags 指向谁 + tarball 是否可解析 */
async function sample(version) {
  const doc = await getJson(`/${enc}`);
  if (doc.status !== 200 || !doc.body) {
    return { reachable: false, error: doc.error || `HTTP ${doc.status}` };
  }
  const packument = doc.body;
  const distTags = packument["dist-tags"] || {};
  const target = version || distTags[CHANNEL] || distTags.latest;
  const versionDoc = target in (packument.versions || {})
    ? (packument.versions || {})[target]
    : null;
  return {
    reachable: true,
    target,
    visible: Boolean(versionDoc && versionDoc.dist && versionDoc.dist.tarball),
    distTags,
    channelPointsAtTarget: target ? distTags[CHANNEL] === target : false,
    publishedAt: packument.time && target ? packument.time[target] : null,
    integrity: versionDoc && versionDoc.dist ? versionDoc.dist.integrity?.slice(0, 24) ?? null : null,
  };
}

function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

(async () => {
  const startedAt = Date.now();
  let last = null;
  let state = "error";
  for (;;) {
    try {
      last = await sample(VERSION);
    } catch (e) {
      last = { reachable: false, error: e.message };
    }
    const elapsed = Date.now() - startedAt;
    if (last.reachable && last.visible) {
      state = "visible";
      break;
    }
    if (last.reachable === false) {
      // 网络问题不判 staged；继续轮询直到超时
      state = "error";
    } else {
      state = "staged";
    }
    if (ONCE || elapsed >= TIMEOUT_MS) break;
    await sleep(Math.min(INTERVAL_MS, TIMEOUT_MS - elapsed));
  }
  const elapsedMs = Date.now() - startedAt;
  const result = {
    package: PKG,
    target: last?.target ?? VERSION ?? null,
    channel: CHANNEL,
    state,
    elapsedMs,
    elapsed: fmtElapsed(elapsedMs),
    distTags: last?.distTags ?? null,
    channelPointsAtTarget: last?.channelPointsAtTarget ?? null,
    publishedAt: last?.publishedAt ?? null,
    integrity: last?.integrity ?? null,
    error: last?.error ?? null,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    const verdict = {
      visible: "✅ visible（registry 已可见）",
      staged: "⏳ staged / 延迟（registry 仍不可见 —— 检查 2FA 批准与 npm 处理队列）",
      error: "⚠️ 无法判定（网络或 registry 错误）",
    }[state];
    console.log(`${PKG}${result.target ? `@${result.target}` : ""} · ${verdict}`);
    console.log(`  等了 ${result.elapsed} · dist-tags: ${Object.entries(result.distTags || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}`);
    if (result.publishedAt) console.log(`  registry 发布时刻: ${result.publishedAt}`);
    if (result.error) console.log(`  错误: ${result.error}`);
    if (state === "staged") {
      console.log("  提示：staged 发布需要人工批准；批准前 registry 返回 404，但 CI 的 publish 步骤可能已显示 success（#2844）。");
    }
  }
  process.exit(state === "visible" ? 0 : state === "staged" ? 1 : 2);
})();
