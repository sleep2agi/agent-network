import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareDesktopVersions, resolveDesktopUpdate, selectDesktopRelease } from '../api/desktop-update-latest.mjs';

const release = (tag, { draft = false, asset = true } = {}) => ({
  tag_name: tag,
  draft,
  assets: asset ? [{
    name: 'latest.json',
    url: `https://asset.test/${tag}`,
    browser_download_url: `https://download.test/${tag}/latest.json`,
  }, {
    name: 'mac.tar.gz',
    url: `https://asset.test/${tag}/mac`,
    browser_download_url: `https://download.test/${tag}/mac.tar.gz`,
  }, {
    name: 'win.exe',
    url: `https://asset.test/${tag}/win`,
    browser_download_url: `https://download.test/${tag}/win.exe`,
  }] : [],
});
const manifest = (version) => ({
  version,
  platforms: {
    'darwin-aarch64': { signature: 'mac', url: `https://asset.test/desktop-v${version}/mac` },
    'windows-x86_64': { signature: 'win', url: `https://asset.test/desktop-v${version}/win` },
  },
});

assert.ok(compareDesktopVersions(
  { core: [0, 2, 33], pre: ['3'] },
  { core: [0, 2, 33], pre: ['2'] },
) > 0);
assert.equal(selectDesktopRelease([
  release('desktop-v0.2.32'),
  release('desktop-v0.2.33-2'),
  release('desktop-v0.2.33-3'),
])?.release.tag_name, 'desktop-v0.2.33-3');
assert.equal(selectDesktopRelease([
  release('desktop-v0.2.34', { draft: true }),
  release('mobile-v9.0.0'),
  release('desktop-v0.2.33-3'),
])?.release.tag_name, 'desktop-v0.2.33-3');

const calls = [];
const dynamicFetch = async (url) => {
  calls.push(url);
  if (url.includes('/releases?')) return { ok: true, json: async () => [release('desktop-v0.2.33-3')] };
  return { ok: true, json: async () => manifest('0.2.33-3') };
};
const dynamic = await resolveDesktopUpdate(dynamicFetch);
assert.equal(dynamic.source, 'desktop-v0.2.33-3');
assert.equal(dynamic.manifest.version, '0.2.33-3');
assert.equal(dynamic.manifest.platforms['darwin-aarch64'].url, 'https://download.test/desktop-v0.2.33-3/mac.tar.gz');
assert.equal(dynamic.manifest.platforms['windows-x86_64'].url, 'https://download.test/desktop-v0.2.33-3/win.exe');
assert.equal(calls.length, 2);

const fallbackFetch = async (url) => {
  if (url.includes('/releases?')) return { ok: false, status: 502 };
  assert.match(url, /fallback\.json$/);
  return { ok: true, json: async () => manifest('0.2.33-3') };
};
assert.equal((await resolveDesktopUpdate(fallbackFetch)).source, 'fallback');

const mismatchFetch = async (url) => {
  if (url.includes('/releases?')) return { ok: true, json: async () => [release('desktop-v0.2.33-3')] };
  if (url.includes('asset.test')) return { ok: true, json: async () => manifest('0.2.33-2') };
  return { ok: true, json: async () => manifest('0.2.33-3') };
};
assert.equal((await resolveDesktopUpdate(mismatchFetch)).source, 'fallback');

const handlerSource = fs.readFileSync(new URL('../api/desktop-update-latest.mjs', import.meta.url), 'utf8');
const vercelConfig = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.match(handlerSource, /setHeader\('Cache-Control', 'no-store, max-age=0'\)/);
assert.equal(vercelConfig.headers[0].headers[0].value, 'no-store, max-age=0');

console.log('desktop updater dynamic route: 12 checks passed');
