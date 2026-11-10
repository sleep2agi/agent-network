// Rebuild the static updater fallback from the latest published desktop release.
//
// The dynamic route (/desktop/update/latest.json) resolves the release itself, but
// fallback.json is a checked-in file: when the dynamic endpoint cannot parse the
// release (rate limit, timeout) clients fall back to whatever this file says. It
// does not move on its own, and forgetting it ships an older version with the wrong
// platform list — 0.2.289's fallback still said 0.2.288 and had no Linux entry at all.
//
// usage: node docs-site/scripts/sync-desktop-fallback.mjs [version]
//   prints "up-to-date" and exits 0 when nothing needs to change.
import { readFile, writeFile } from 'node:fs/promises';

const REPO = 'sleep2agi/agent-network-app';
const FILE = new URL('../docs/public/desktop/update/fallback.json', import.meta.url);

const wanted = process.argv[2];
const releaseUrl = wanted
  ? `https://api.github.com/repos/${REPO}/releases/tags/desktop-v${wanted.replace(/^v/, '')}`
  : `https://api.github.com/repos/${REPO}/releases/latest`;
const headers = { 'User-Agent': 'anet-fallback-sync', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const release = await (await fetch(releaseUrl, { headers })).json();
if (!release?.tag_name || !Array.isArray(release.assets)) {
  console.error(`could not read the release (${releaseUrl}): ${release?.message ?? 'no assets'}`);
  process.exit(1);
}
const asset = release.assets.find(a => a.name === 'latest.json');
if (!asset) {
  console.error(`release ${release.tag_name} has no latest.json yet`);
  process.exit(1);
}
const manifest = await (await fetch(asset.browser_download_url, { headers })).json();

// #4399 —— notes 要跟着这一版走，不能继承上一版。
//
// 原来这里写的是 `if (current.notes) next.notes = current.notes`，于是版本号在动、文案永远停在
// 第一次写进来的那一版：2026-11-10 实测 fallback.json 的 version 已是 0.2.498，而 notes 里
// 写的还是「What's new in 0.2.288」。走静态兜底的客户端（动态端点被限流/超时）就会看到
// 0.2.288 的更新内容配 0.2.498 的包。
//
// latest.json 里的 notes 就是这一版的 releaseBody（tauri-action 原样写入），所以优先用它；
// 只有它缺失时才退回现有文案 —— 那至少不会比现在更糟。
const current = JSON.parse(await readFile(FILE, 'utf8'));
const notes = typeof manifest.notes === 'string' && manifest.notes.trim() ? manifest.notes : (current.notes ?? null);
const sameVersion = current.version === manifest.version;
const samePlatforms = JSON.stringify(Object.keys(current.platforms ?? {}).sort()) === JSON.stringify(Object.keys(manifest.platforms).sort());
// notes 也参与「是否已经一致」的判定：只比版本号会让同版本的重复跑永远修不好旧文案。
const sameNotes = (current.notes ?? '') === (notes ?? '');
if (sameVersion && samePlatforms && sameNotes) {
  console.log(`up-to-date: ${manifest.version}, ${Object.keys(manifest.platforms).length} platforms`);
  process.exit(0);
}

const next = { version: manifest.version, pub_date: release.published_at, platforms: manifest.platforms };
if (notes) next.notes = notes;
await writeFile(FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(`fallback ${current.version} -> ${manifest.version} (${Object.keys(manifest.platforms).length} platforms)`);
