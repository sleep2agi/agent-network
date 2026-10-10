import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  catalogFromRelease,
  catalogFromUrls,
  classifyInstallAsset,
  modelscopeMirrorUrl,
  publicGithubDownloadUrl,
  resolveDesktopDownloads,
} from '../api/desktop-downloads.mjs';

assert.equal(classifyInstallAsset('Agent.Network_0.2.228_aarch64.app.tar.gz'), null);
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_aarch64.app.tar.gz.sig'), null);
assert.equal(classifyInstallAsset('latest.json'), null);
assert.equal(classifyInstallAsset('569210828'), null);
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_aarch64.dmg')?.kind, 'dmg');
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_x64-setup.exe')?.kind, 'nsis');
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_x64_en-US.msi')?.kind, 'msi');
assert.equal(classifyInstallAsset('ANet_0.2.228_amd64.deb')?.platform, 'linux');
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_amd64.AppImage')?.kind, 'appimage');
assert.equal(classifyInstallAsset('Agent.Network_0.2.228_android-universal.apk')?.platform, 'android');
assert.equal(classifyInstallAsset('Agent.Network_0.2.41_ios.ipa')?.role, 'audit');

assert.equal(publicGithubDownloadUrl('https://api.github.com/repos/sleep2agi/agent-network-app/releases/assets/569210828'), null);
assert.equal(publicGithubDownloadUrl('javascript:alert(1)'), null);
assert.match(
  publicGithubDownloadUrl('https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.228/Agent.Network_0.2.228_amd64.deb'),
  /\/download\/desktop-v0\.2\.228\/Agent\.Network_0\.2\.228_amd64\.deb$/,
);
assert.equal(modelscopeMirrorUrl('0.2.228', '../secret'), null);
assert.equal(
  modelscopeMirrorUrl('0.2.228', 'Agent.Network_0.2.228_aarch64.dmg'),
  'https://modelscope.cn/datasets/SmartFlowAI/agent-network-releases/resolve/master/desktop/0.2.228/Agent.Network_0.2.228_aarch64.dmg',
);

const release = (tag, names, { draft = false } = {}) => ({
  tag_name: tag,
  draft,
  html_url: `https://github.com/sleep2agi/agent-network-app/releases/tag/${tag}`,
  assets: [
    {
      name: 'latest.json',
      url: `https://api.github.com/repos/sleep2agi/agent-network-app/releases/assets/1`,
      browser_download_url: `https://github.com/sleep2agi/agent-network-app/releases/download/${tag}/latest.json`,
    },
    ...names.map((name, index) => ({
      name,
      size: (index + 1) * 1024 * 1024,
      url: `https://api.github.com/repos/sleep2agi/agent-network-app/releases/assets/${9000 + index}`,
      browser_download_url: `https://github.com/sleep2agi/agent-network-app/releases/download/${tag}/${name}`,
    })),
  ],
});

const published = release('desktop-v0.2.226', [
  'Agent.Network_0.2.226_aarch64.app.tar.gz',
  'Agent.Network_0.2.226_aarch64.dmg',
  'Agent.Network_0.2.226_x64-setup.exe',
  'Agent.Network_0.2.226_x64_en-US.msi',
  'Agent.Network_0.2.226_android-universal.apk',
]);
const draft = release('desktop-v0.2.228', [
  'Agent.Network_0.2.228_aarch64.dmg',
  'Agent.Network_0.2.228_amd64.deb',
  'Agent.Network_0.2.228_amd64.AppImage',
], { draft: true });

const fromPublished = catalogFromRelease(published, '0.2.226');
assert.deepEqual(fromPublished.map((asset) => asset.kind), ['dmg', 'nsis', 'msi', 'apk']);
assert.equal(fromPublished[0].url, 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.226/Agent.Network_0.2.226_aarch64.dmg');
assert.equal(fromPublished.find((asset) => asset.platform === 'linux'), undefined);

const withLinux = catalogFromRelease(release('desktop-v0.2.228', [
  'Agent.Network_0.2.228_amd64.deb',
  'Agent.Network_0.2.228_amd64.AppImage',
  'Agent.Network_0.2.228_ios.ipa',
]), '0.2.228');
assert.deepEqual(withLinux.map((asset) => `${asset.platform}:${asset.kind}:${asset.role}`), [
  'linux:deb:install',
  'linux:appimage:install',
  'ios:ipa:audit',
]);
assert.equal(withLinux.find((asset) => asset.kind === 'ipa').mirrorUrl, null);
assert.ok(withLinux.find((asset) => asset.kind === 'deb').mirrorUrl?.endsWith('/0.2.228/Agent.Network_0.2.228_amd64.deb'));

const calls = [];
const dynamicFetch = async (url) => {
  calls.push(url);
  return { ok: true, json: async () => [draft, published, release('mobile-v9.0.0', ['Agent.Network_9.0.0_aarch64.dmg'])] };
};
const dynamic = await resolveDesktopDownloads(dynamicFetch);
assert.equal(dynamic.source, 'desktop-v0.2.226');
assert.equal(dynamic.version, '0.2.226');
assert.equal(dynamic.platforms.find((platform) => platform.id === 'linux').assets.length, 0);
assert.equal(dynamic.platforms.find((platform) => platform.id === 'macos').assets[0].name, 'Agent.Network_0.2.226_aarch64.dmg');
assert.equal(calls.length, 1);

const fallbackManifest = {
  version: '0.2.33-3',
  pub_date: '2026-01-01T00:00:00.000Z',
  platforms: {
    'windows-x86_64': { url: 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.33-3/win.exe' },
    'linux-x86_64': { url: 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.33-3/linux.deb' },
    'darwin-aarch64': { url: 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.33-3/mac.app.tar.gz' },
    'bogus': { url: 'https://api.github.com/repos/sleep2agi/agent-network-app/releases/assets/569210828' },
  },
};
assert.deepEqual(catalogFromUrls(Object.values(fallbackManifest.platforms).map((entry) => entry.url), '0.2.33-3').map((asset) => asset.kind), ['nsis', 'deb']);

const fallbackFetch = async (url) => {
  if (String(url).includes('/releases?')) return { ok: false, status: 502 };
  assert.match(String(url), /fallback\.json$/);
  return { ok: true, json: async () => fallbackManifest };
};
const fallback = await resolveDesktopDownloads(fallbackFetch);
assert.equal(fallback.source, 'fallback');
assert.equal(fallback.version, '0.2.33-3');
assert.deepEqual(fallback.platforms.find((platform) => platform.id === 'macos').assets, []);
assert.equal(fallback.platforms.find((platform) => platform.id === 'linux').assets[0].kind, 'deb');

const handlerSource = fs.readFileSync(new URL('../api/desktop-downloads.mjs', import.meta.url), 'utf8');
assert.match(handlerSource, /selectDesktopRelease/);
assert.match(handlerSource, /setHeader\('Cache-Control', 'public, max-age=60, stale-while-revalidate=300'\)/);
assert.match(handlerSource, /desktop_downloads_unavailable/);

console.log('desktop downloads catalog: checks passed');
