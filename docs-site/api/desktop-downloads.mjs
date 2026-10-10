import {
  DESKTOP_RELEASES_URL,
  DESKTOP_UPDATE_FALLBACK_URL,
  GITHUB_JSON_HEADERS,
  selectDesktopRelease,
} from './desktop-update-latest.mjs';

// Same release the desktop updater would ship: newest non-draft `desktop-v*`
// tag that carries `latest.json`. Installers are the other assets on that
// release. A platform with no matching file is omitted rather than pointed at
// an older filename.

const MIRROR_ROOT = 'https://modelscope.cn/datasets/SmartFlowAI/agent-network-releases/resolve/master/desktop';

export const PLATFORM_ORDER = ['macos', 'windows', 'linux', 'android', 'ios'];

const VERSION_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const SAFE_FILENAME = /^[\w.+-]+$/;

export const classifyInstallAsset = (name) => {
  const file = String(name ?? '').split('/').pop() ?? '';
  if (!file || file.endsWith('.sig') || file === 'latest.json' || file === 'SHA256SUMS.txt') return null;
  const lower = file.toLowerCase();
  if (lower.endsWith('.app.tar.gz') || lower.endsWith('.tar.gz')) return null;
  if (lower.endsWith('.dmg')) return { platform: 'macos', kind: 'dmg', role: 'install' };
  if (lower.endsWith('.msi')) return { platform: 'windows', kind: 'msi', role: 'install' };
  if (lower.endsWith('.exe')) return { platform: 'windows', kind: 'nsis', role: 'install' };
  if (lower.endsWith('.deb')) return { platform: 'linux', kind: 'deb', role: 'install' };
  if (lower.endsWith('.appimage')) return { platform: 'linux', kind: 'appimage', role: 'install' };
  if (lower.endsWith('.apk')) return { platform: 'android', kind: 'apk', role: 'install' };
  if (lower.endsWith('.ipa')) return { platform: 'ios', kind: 'ipa', role: 'audit' };
  return null;
};

export const publicGithubDownloadUrl = (url) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
  if (!parsed.pathname.includes('/releases/download/')) return null;
  return parsed.toString();
};

export const modelscopeMirrorUrl = (version, filename) => {
  if (!VERSION_TEXT.test(version) || !SAFE_FILENAME.test(filename)) return null;
  return `${MIRROR_ROOT}/${version}/${filename}`;
};

const assetRecord = (releaseTag, version, asset) => {
  const classified = classifyInstallAsset(asset?.name);
  if (!classified) return null;
  const filename = String(asset.name).split('/').pop();
  const direct = publicGithubDownloadUrl(asset.browser_download_url)
    || publicGithubDownloadUrl(
      `https://github.com/sleep2agi/agent-network-app/releases/download/${releaseTag}/${filename}`,
    );
  if (!direct) return null;
  return {
    platform: classified.platform,
    kind: classified.kind,
    role: classified.role,
    name: filename,
    bytes: typeof asset.size === 'number' && asset.size >= 0 ? asset.size : null,
    url: direct,
    mirrorUrl: classified.role === 'install' ? modelscopeMirrorUrl(version, filename) : null,
  };
};

const kindRank = { dmg: 0, nsis: 0, deb: 0, apk: 0, ipa: 0, msi: 1, appimage: 1 };

export const catalogFromRelease = (release, version) => (release?.assets ?? [])
  .map((asset) => assetRecord(release.tag_name, version, asset))
  .filter(Boolean)
  .sort((left, right) => (
    PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform)
    || (kindRank[left.kind] ?? 9) - (kindRank[right.kind] ?? 9)
    || left.name.localeCompare(right.name)
  ));

export const catalogFromUrls = (urls, version) => {
  const seen = new Set();
  const assets = [];
  for (const url of urls) {
    const direct = publicGithubDownloadUrl(url);
    if (!direct) continue;
    const filename = direct.split('/').pop();
    if (!filename || seen.has(filename)) continue;
    const record = assetRecord(`desktop-v${version}`, version, {
      name: decodeURIComponent(filename),
      browser_download_url: direct,
    });
    if (!record) continue;
    seen.add(filename);
    assets.push(record);
  }
  return assets;
};

export const groupPlatforms = (assets) => PLATFORM_ORDER.map((id) => ({
  id,
  assets: assets.filter((asset) => asset.platform === id),
}));

const fetchJson = async (fetchImpl, url, headers = {}) => {
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

export const resolveDesktopDownloads = async (fetchImpl = fetch) => {
  try {
    const releases = await fetchJson(fetchImpl, DESKTOP_RELEASES_URL, GITHUB_JSON_HEADERS);
    const selected = selectDesktopRelease(Array.isArray(releases) ? releases : []);
    if (!selected) throw new Error('no published desktop release has latest.json');
    const assets = catalogFromRelease(selected.release, selected.version.text);
    if (assets.length === 0) throw new Error('release has no installable assets');
    return {
      version: selected.version.text,
      tag: selected.release.tag_name,
      source: selected.release.tag_name,
      releaseUrl: selected.release.html_url
        || `https://github.com/sleep2agi/agent-network-app/releases/tag/${selected.release.tag_name}`,
      publishedAt: selected.release.published_at ?? null,
      platforms: groupPlatforms(assets),
    };
  } catch (error) {
    const manifest = await fetchJson(fetchImpl, DESKTOP_UPDATE_FALLBACK_URL);
    const version = manifest?.version;
    if (typeof version !== 'string') throw error;
    const assets = catalogFromUrls(
      Object.values(manifest.platforms ?? {}).map((entry) => entry?.url),
      version,
    );
    if (assets.length === 0) throw error;
    return {
      version,
      tag: `desktop-v${version}`,
      source: 'fallback',
      releaseUrl: `https://github.com/sleep2agi/agent-network-app/releases/tag/desktop-v${version}`,
      publishedAt: typeof manifest.pub_date === 'string' ? manifest.pub_date : null,
      platforms: groupPlatforms(assets),
    };
  }
};

export default async function handler(_request, response) {
  try {
    const catalog = await resolveDesktopDownloads();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    response.setHeader('X-Anet-Download-Source', catalog.source);
    response.status(200).json(catalog);
  } catch {
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({ error: 'desktop_downloads_unavailable' });
  }
}
